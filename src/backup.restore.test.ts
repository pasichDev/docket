import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Backup and restore, as transactions.
 *
 * The three failures these cover are the ones that only appear when something else is
 * happening at the same time — another process writing while a backup is read, a crash
 * partway through a restore's commit, a live process still holding the keys of a data
 * directory that has just been replaced. All three used to produce a data directory that
 * looks fine and is not.
 */
const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-restore-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;

const { createBackup, restoreBackup, recoverInterruptedRestore, liveHoldersOfDataDirectory } = await import("./backup.js");
const { withFileLock } = await import("./filelock.js");
const { atomicWriteFile } = await import("./fs-atomic.js");

test.after(async () => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  await rm(dataDirectory, { recursive: true, force: true });
});

/**
 * Retries an operation that lost a race for the data directory's locks.
 *
 * Both refusals below are correct behaviour, not defects: `docket serve`, the dashboard and
 * every MCP session share one advisory lock per file, and a machine running forty test files
 * in parallel — each spawning processes — can genuinely starve one of them past the five
 * second acquire timeout or the ten second staleness window. The property these tests exist
 * to check is that no INCOHERENT result is ever produced; a refusal to produce one is the
 * mechanism working. What must not be tolerated is silence, so anything else propagates.
 */
const CONTENTION = /could not read a coherent snapshot|timed out waiting for lock/;

async function despiteContention<T>(what: string, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const message = (err as Error).message;
      if (attempt >= 5 || !CONTENTION.test(message)) throw new Error(`${what}: ${message}`);
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

const inData = (name: string): string => join(dataDirectory, name);
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const PASSWORD = "correct horse battery staple";

async function seedDataDirectory(): Promise<void> {
  await writeFile(inData("device.json"), JSON.stringify({ id: "device-1", name: "TestBox" }));
  await writeFile(inData("key"), Buffer.alloc(32, 7));
  await writeFile(inData("todos.json.enc"), Buffer.from("todos-generation-0"));
  await writeFile(inData("peers.json.enc"), Buffer.from("peers-generation-0"));
  await writeFile(inData("history.json.enc"), Buffer.from("history-generation-0"));
}

/* ==========================================================================================
 * B06 — a backup must be one moment, not several
 * ========================================================================================== */

/**
 * The invariant a real data directory has and a test has to make observable: the store and
 * the peer list are written together, so a coherent snapshot always holds the SAME
 * generation number in both. Backup used to read them one after another with nothing held,
 * so a writer running in between produced a bundle with generation N in one file and N+1 in
 * the other — two files that were never simultaneously true, and nothing anywhere reports it.
 */
async function writeCoupledGeneration(n: number): Promise<void> {
  // The same canonical lock order backup uses, for the same reason.
  const locks = ["device.json", "peers.json.enc", "todos.json.enc"].map((f) => inData(`${f}.lock`)).sort();
  const take = async (i: number): Promise<void> => {
    if (i === locks.length) {
      await atomicWriteFile(inData("todos.json.enc"), Buffer.from(`todos-generation-${n}`));
      // A deliberately wide gap between the two writes: without the locks a concurrent
      // backup lands in here every time rather than once in a thousand runs.
      await new Promise((r) => setTimeout(r, 3));
      await atomicWriteFile(inData("peers.json.enc"), Buffer.from(`peers-generation-${n}`));
      return;
    }
    await withFileLock(locks[i], () => take(i + 1));
  };
  await take(0);
}

function generationOf(text: string): string {
  return text.replace(/^[a-z]+-generation-/, "");
}

test("every backup taken during concurrent writes is a single coherent moment", async () => {
  await seedDataDirectory();

  let generation = 0;
  let writing = true;
  const writer = (async () => {
    while (writing) await writeCoupledGeneration(++generation);
  })();

  const bundles: Buffer[] = [];
  for (let i = 0; i < 12; i++) {
    bundles.push(await despiteContention(`backup ${i}`, () => createBackup(PASSWORD)));
  }
  writing = false;
  await writer;
  assert.ok(generation > 1, `premise broken: the writer only managed ${generation} rounds`);

  // Restore each bundle into a scratch directory and check the two files agree.
  for (const [index, bundle] of bundles.entries()) {
    const scratch = await mkdtemp(join(tmpdir(), "docket-coherence-"));
    try {
      const child = await runInDataDir(scratch, RESTORE_CHILD, [bundle.toString("base64"), PASSWORD]);
      assert.equal(child.code, 0, `restore of bundle ${index} failed: ${child.err}`);
      const todos = generationOf(await readFile(join(scratch, "todos.json.enc"), "utf8"));
      const peers = generationOf(await readFile(join(scratch, "peers.json.enc"), "utf8"));
      assert.equal(
        todos,
        peers,
        `bundle ${index} captured todos from generation ${todos} and peers from generation ${peers} — a moment that never existed`,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
});

test("a bundle whose contents do not match its manifest is refused before anything is touched", async () => {
  await seedDataDirectory();
  const bundle = await despiteContention("backup", () => createBackup(PASSWORD));

  // Corrupt one file inside the bundle, re-sealing the envelope so the GCM tag still passes
  // — i.e. exactly the damage the envelope cannot see: a bad build, not a bad actor.
  const damaged = await resealWith(bundle, PASSWORD, (parsed) => {
    parsed.files["todos.json.enc"] = Buffer.from("truncated").toString("base64");
  });

  const before = sha256(await readFile(inData("todos.json.enc")));
  await assert.rejects(() => restoreBackup(damaged, PASSWORD), /does not match the manifest/);
  // The manifest is checked before a single lock is taken, so this one cannot be starved.
  assert.equal(sha256(await readFile(inData("todos.json.enc"))), before, "a refused restore still modified the live store");
  assert.deepEqual(await stagingDirs(), [], "a refused restore left staged files behind");
});

/* ==========================================================================================
 * B07 — an interrupted restore must finish, not fossilise
 * ========================================================================================== */

test("a restore interrupted at any commit boundary recovers to the complete new state", async () => {
  await seedDataDirectory();
  const bundle = await despiteContention("backup", () => createBackup(PASSWORD));
  const target = await snapshotOf(dataDirectory);

  // Move on to a different generation, so "the new state" is distinguishable from "whatever
  // was already there".
  await writeCoupledGeneration(99);
  await writeFile(inData("history.json.enc"), Buffer.from("history-generation-99"));

  const names = Object.keys(target).filter((n) => n !== "generation");
  for (let stoppedAfter = 0; stoppedAfter <= names.length; stoppedAfter++) {
    await restoreThenCrashAfter(bundle, stoppedAfter);

    // Whatever state the crash left, the next start has to finish the job.
    const recovered = await despiteContention(`recovery after boundary ${stoppedAfter}`, () => recoverInterruptedRestore());
    assert.ok(recovered, `nothing to recover after stopping at boundary ${stoppedAfter}`);

    for (const name of names) {
      assert.equal(
        (await readFile(inData(name))).toString("utf8"),
        target[name],
        `after a crash at boundary ${stoppedAfter}, ${name} is not the restored version — the directory is a mixture`,
      );
    }
    assert.deepEqual(await stagingDirs(), [], `boundary ${stoppedAfter} left staging behind`);
    await assert.rejects(() => stat(inData("restore-journal.json")), `boundary ${stoppedAfter} left its journal behind`);

    // Reset for the next boundary.
    await writeCoupledGeneration(99);
    await writeFile(inData("history.json.enc"), Buffer.from("history-generation-99"));
  }
});

test("recovery is a no-op when no restore was interrupted", async () => {
  assert.equal(await recoverInterruptedRestore(), null);
});

test("an unreadable journal stops the process rather than guessing", async () => {
  await writeFile(inData("restore-journal.json"), "{ this is not json");
  try {
    await assert.rejects(() => recoverInterruptedRestore(), /interrupted and cannot be finished automatically/);
  } finally {
    await rm(inData("restore-journal.json"), { force: true });
  }
});

/* ==========================================================================================
 * B08 — nothing that predates the restore may write into what it produced
 * ========================================================================================== */

test("a process holding the previous data directory cannot commit into the restored one", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "docket-generation-"));
  try {
    const ready = join(scratch, "pinned");
    const go = join(scratch, "go");
    const child = spawnInDataDir(scratch, STALE_WRITER, [ready, go]);
    await waitFor(ready);

    // The restore's commit, in the only part that matters here.
    const bumper = await runInDataDir(scratch, BUMP_GENERATION, []);
    assert.equal(bumper.code, 0, `could not mint a new generation: ${bumper.err}`);

    await writeFile(go, "now");
    const result = await child;
    assert.equal(result.code, 0, `the stale writer crashed instead of reporting: ${result.err}`);
    const reported = JSON.parse(result.out) as { refused: boolean; error: string; todos: number };
    assert.equal(reported.refused, true, "a process holding the previous at-rest key committed into the restored directory");
    assert.match(reported.error, /GenerationChangedError/);
    assert.equal(reported.todos, 0, "the refused write must leave the store exactly as the restore left it");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("restore names processes holding THIS data directory, and only those", async () => {
  const { createServer } = await import("node:http");
  const { getGeneration } = await import("./generation.js");
  const mine = await getGeneration();

  // Ports nobody else on this machine is using: the defaults are whatever the developer
  // running the suite happens to have open, which is not something a test may depend on.
  const originalWeb = process.env.DOCKET_WEB_PORT;
  const originalServer = process.env.DOCKET_SERVER_PORT;

  const serve = (generation: string | null): Promise<{ port: number; close: () => Promise<void> }> =>
    new Promise((resolve) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(generation === null ? { pid: 1 } : { pid: 1, generation }));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as { port: number };
        resolve({ port: address.port, close: () => new Promise((done) => server.close(() => done())) });
      });
    });

  const ours = await serve(mine);
  const somebodyElses = await serve("11111111-2222-3333-4444-555555555555");
  try {
    process.env.DOCKET_WEB_PORT = String(ours.port);
    process.env.DOCKET_SERVER_PORT = String(somebodyElses.port);
    const holders = await liveHoldersOfDataDirectory();
    assert.equal(holders.length, 1, `expected exactly the dashboard on our own generation, got: ${holders.join(" | ")}`);
    assert.match(holders[0], /web dashboard/);

    // An older build that reports no generation at all is assumed to be a holder: silence is
    // not evidence of absence, and the cost of a spurious warning is far below the cost of a
    // missed one.
    const legacy = await serve(null);
    try {
      process.env.DOCKET_WEB_PORT = String(legacy.port);
      process.env.DOCKET_SERVER_PORT = "1";
      assert.equal((await liveHoldersOfDataDirectory()).length, 1);
    } finally {
      await legacy.close();
    }

    // And with nothing listening at all, the answer is a list, not a throw.
    process.env.DOCKET_WEB_PORT = "1";
    process.env.DOCKET_SERVER_PORT = "1";
    assert.deepEqual(await liveHoldersOfDataDirectory(), []);
  } finally {
    await ours.close();
    await somebodyElses.close();
    if (originalWeb === undefined) delete process.env.DOCKET_WEB_PORT;
    else process.env.DOCKET_WEB_PORT = originalWeb;
    if (originalServer === undefined) delete process.env.DOCKET_SERVER_PORT;
    else process.env.DOCKET_SERVER_PORT = originalServer;
  }
});

/* ==========================================================================================
 * Scaffolding
 * ========================================================================================== */

const BACKUP_MODULE = fileURLToPath(new URL("./backup.js", import.meta.url));
const GENERATION_MODULE = fileURLToPath(new URL("./generation.js", import.meta.url));
const STORAGE_MODULE = fileURLToPath(new URL("./storage.js", import.meta.url));
const MUTATIONS_MODULE = fileURLToPath(new URL("./mutations.js", import.meta.url));

const RESTORE_CHILD = `
import { restoreBackup } from ${JSON.stringify(BACKUP_MODULE)};
const [bundle, password] = process.argv.slice(2);
await restoreBackup(Buffer.from(bundle, "base64"), password);
`;

const BUMP_GENERATION = `
import { newGeneration } from ${JSON.stringify(GENERATION_MODULE)};
await newGeneration();
`;

/**
 * A long-running process, exactly as the audit describes it: it pins the data directory at
 * startup (which is what caching the at-rest key really means), waits while a restore
 * replaces that directory, and only then tries to write.
 */
const STALE_WRITER = `
import { writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { getGeneration } from ${JSON.stringify(GENERATION_MODULE)};
import { withStore, readStore } from ${JSON.stringify(STORAGE_MODULE)};
import { createTodo } from ${JSON.stringify(MUTATIONS_MODULE)};

const [readyPath, goPath] = process.argv.slice(2);
await getGeneration();          // the pin
await withStore(() => {});      // and a real read, so everything is cached the way a live process has it
writeFileSync(readyPath, "pinned");

for (;;) {
  try { await stat(goPath); break; } catch { await new Promise((r) => setTimeout(r, 20)); }
}

let refused = false;
let error = "";
try {
  await withStore((store) => {
    createTodo(store, { title: "written by a stale process", agent: "stale", session: "s" }, "device-stale", "Stale");
  });
} catch (err) {
  refused = true;
  error = err.name + ": " + err.message;
}
process.stdout.write(JSON.stringify({ refused, error, todos: (await readStore()).todos.length }));
`;

interface ChildResult {
  code: number | null;
  out: string;
  err: string;
}

function spawnInDataDir(dir: string, source: string, args: string[]): Promise<ChildResult> {
  const scriptPath = join(dir, `child-${Math.random().toString(36).slice(2)}.mjs`);
  return writeFile(scriptPath, source, "utf8").then(() => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DOCKET_DATA_DIR: dir },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    return once(child, "exit").then(([code]) => ({ code: code as number | null, out, err }));
  });
}

const runInDataDir = spawnInDataDir;

async function waitFor(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

async function stagingDirs(): Promise<string[]> {
  return (await readdir(dataDirectory)).filter((n) => n.startsWith(".restore-staging-"));
}

async function snapshotOf(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of ["device.json", "key", "todos.json.enc", "peers.json.enc", "history.json.enc"]) {
    out[name] = (await readFile(join(dir, name))).toString("utf8");
  }
  return out;
}

/** Re-encrypts a bundle after mutating its decoded form, so the envelope stays valid. */
async function resealWith(
  bundle: Buffer,
  password: string,
  mutate: (parsed: { files: Record<string, string> }) => void,
): Promise<Buffer> {
  const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = await import("node:crypto");
  const headerLen = bundle.readUInt32BE(0);
  const header = JSON.parse(bundle.subarray(4, 4 + headerLen).toString("utf8")) as { salt: string; iv: string; magic: string };
  const authTag = bundle.subarray(4 + headerLen, 4 + headerLen + 16);
  const ciphertext = bundle.subarray(4 + headerLen + 16);
  const oldKey = scryptSync(password, Buffer.from(header.salt, "base64"), 32, { N: 2 ** 14, r: 8, p: 1 });
  const decipher = createDecipheriv("aes-256-gcm", oldKey, Buffer.from(header.iv, "base64"));
  decipher.setAuthTag(authTag);
  const parsed = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  mutate(parsed);

  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N: 2 ** 14, r: 8, p: 1 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(parsed), "utf8"), cipher.final()]);
  const newHeader = Buffer.from(JSON.stringify({ magic: header.magic, salt: salt.toString("base64"), iv: iv.toString("base64") }), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(newHeader.length);
  return Buffer.concat([len, newHeader, cipher.getAuthTag(), body]);
}

/**
 * Reproduces the on-disk state a restore killed at a given commit boundary would leave —
 * the staging directory, the journal, and the first `stoppedAfter` files already moved into
 * place. Building the state directly rather than SIGKILLing a real child is what makes this
 * exhaustive: every boundary is covered, deterministically, instead of whichever few a race
 * happens to land on.
 */
async function restoreThenCrashAfter(bundle: Buffer, stoppedAfter: number): Promise<void> {
  const { createDecipheriv, scryptSync } = await import("node:crypto");
  const headerLen = bundle.readUInt32BE(0);
  const header = JSON.parse(bundle.subarray(4, 4 + headerLen).toString("utf8")) as { salt: string; iv: string };
  const key = scryptSync(PASSWORD, Buffer.from(header.salt, "base64"), 32, { N: 2 ** 14, r: 8, p: 1 });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.iv, "base64"));
  decipher.setAuthTag(bundle.subarray(4 + headerLen, 4 + headerLen + 16));
  const parsed = JSON.parse(
    Buffer.concat([decipher.update(bundle.subarray(4 + headerLen + 16)), decipher.final()]).toString("utf8"),
  ) as { files: Record<string, string> };

  const stamp = `crash-${stoppedAfter}`;
  const staging = inData(`.restore-staging-${stamp}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });

  const names = Object.keys(parsed.files);
  for (const name of names) await atomicWriteFile(join(staging, name), Buffer.from(parsed.files[name], "base64"));
  await writeFile(
    inData("restore-journal.json"),
    JSON.stringify({ stamp, staging, names, sweep: [] }, null, 2),
  );

  // …and then the process died after moving the first `stoppedAfter` of them.
  const { rename } = await import("node:fs/promises");
  for (const name of names.slice(0, stoppedAfter)) {
    await rename(inData(name), `${inData(name)}.pre-restore-${stamp}.bak`).catch(() => {});
    await rename(join(staging, name), inData(name));
  }
}

test("the generation guard covers a process that never asked for a generation", async () => {
  /*
   * The bug this catches was in the guard itself, and it was found by using it: the check
   * was gated on "has this process already pinned a generation?", and nothing in an MCP
   * session or a `docket serve` ever asks for one — so it was a no-op for exactly the
   * long-running writers it exists to stop. Only the dashboard, which reports the generation
   * on /api/version, happened to pin one.
   *
   * The child below does what those processes do: it writes, without ever mentioning a
   * generation, and must still be stopped when the directory is replaced underneath it.
   */
  const scratch = await mkdtemp(join(tmpdir(), "docket-generation-unpinned-"));
  try {
    const ready = join(scratch, "pinned");
    const go = join(scratch, "go");
    const child = spawnInDataDir(scratch, UNPINNED_WRITER, [ready, go]);
    await waitFor(ready);

    const bumper = await runInDataDir(scratch, BUMP_GENERATION, []);
    assert.equal(bumper.code, 0, `could not mint a new generation: ${bumper.err}`);

    await writeFile(go, "now");
    const result = await child;
    assert.equal(result.code, 0, `the writer crashed instead of reporting: ${result.err}`);
    const reported = JSON.parse(result.out) as { refused: boolean; error: string };
    assert.equal(reported.refused, true, "a writer that never asked for a generation was allowed to commit into the replaced directory");
    assert.match(reported.error, /GenerationChangedError/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a data directory wiped underneath a running process stops it, rather than mixing keys", async () => {
  /*
   * How this one was found: a script deleted its scratch data directory and restarted, while
   * the previous run's dashboard was still listening. That process kept its old at-rest key,
   * wrote the store into the recreated directory, and the new key beside it could not decrypt
   * it — a data directory that is unreadable from the next start onwards, produced by two
   * processes that were each behaving correctly on their own.
   *
   * An absent generation is therefore a mismatch once this process has pinned one. The
   * upgrade case is covered by the pin itself, which mints the file.
   */
  const scratch = await mkdtemp(join(tmpdir(), "docket-generation-wiped-"));
  try {
    const ready = join(scratch, "pinned");
    const go = join(scratch, "go");
    const child = spawnInDataDir(scratch, UNPINNED_WRITER, [ready, go]);
    await waitFor(ready);

    // Everything the process is holding a key for, gone.
    for (const name of ["generation", "todos.json.enc", "key"]) await rm(join(scratch, name), { force: true });

    await writeFile(go, "now");
    const reported = JSON.parse((await child).out) as { refused: boolean; error: string };
    assert.equal(reported.refused, true, "the process wrote its old ciphertext into a directory whose key it no longer has");
    assert.match(reported.error, /GenerationChangedError/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

/** A long-running writer that never mentions a generation — an MCP session, or `docket serve`. */
const UNPINNED_WRITER = `
import { writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { withStore } from ${JSON.stringify(STORAGE_MODULE)};
import { createTodo } from ${JSON.stringify(MUTATIONS_MODULE)};

const [readyPath, goPath] = process.argv.slice(2);
await withStore((store) => {
  createTodo(store, { title: "before", agent: "long-running", session: "s" }, "device-a", "A");
});
writeFileSync(readyPath, "pinned");

for (;;) {
  try { await stat(goPath); break; } catch { await new Promise((r) => setTimeout(r, 20)); }
}

let refused = false;
let error = "";
try {
  await withStore((store) => {
    createTodo(store, { title: "after the directory moved", agent: "long-running", session: "s" }, "device-a", "A");
  });
} catch (err) {
  refused = true;
  error = err.name + ": " + err.message;
}
process.stdout.write(JSON.stringify({ refused, error }));
`;
