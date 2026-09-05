import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atomicCreateOrRead, atomicWriteFile } from "./fs-atomic.js";

/**
 * The two guarantees every persistent write in Docket now depends on, and neither of which
 * the previous "temp file + rename" idiom actually provided.
 *
 * Atomicity it did provide. Durability it did not — rename says nothing about whether the
 * data or the directory entry reached the medium — and exclusivity it did not, which is a
 * separate bug entirely: a first-run secret written by read-then-write can be minted twice,
 * leaving two live processes holding two different keys.
 */
const dir = await mkdtemp(join(tmpdir(), "docket-fs-atomic-"));
test.after(() => rm(dir, { recursive: true, force: true }));

const litterIn = async (where: string): Promise<string[]> =>
  (await readdir(where)).filter((name) => name.endsWith(".tmp") || name.includes(".tmp."));

/* ==========================================================================================
 * atomicWriteFile
 * ========================================================================================== */

test("a reader never observes a partially written file, however many writers there are", async () => {
  const path = join(dir, "concurrent.bin");
  // Big enough that a non-atomic write would be observably torn: a single write() of a
  // megabyte is not one trip to the disk.
  const payloads = ["a", "b", "c", "d", "e", "f"].map((c) => c.repeat(1024 * 1024));
  await atomicWriteFile(path, payloads[0]);

  let stop = false;
  const observed = new Set<string>();
  const reader = (async () => {
    while (!stop) {
      const seen = await readFile(path, "utf8").catch(() => null);
      if (seen !== null) observed.add(`${seen.length}:${seen[0]}`);
    }
  })();

  for (let round = 0; round < 6; round++) {
    await Promise.all(payloads.map((payload) => atomicWriteFile(path, payload)));
  }
  stop = true;
  await reader;

  const torn = [...observed].filter((shape) => shape !== `${payloads[0].length}:${shape.split(":")[1]}`);
  assert.deepEqual(torn, [], `a reader saw a file that was neither the old contents nor the new: ${torn.join(", ")}`);
  assert.deepEqual(await litterIn(dir), [], "concurrent writers left temp files behind");
});

test("a write that fails leaves the previous contents in place and cleans up after itself", async () => {
  // The target is a directory, so the rename cannot succeed however well the temp file was
  // written. What matters is that the failure is reported AND that nothing is left behind:
  // a temp file per failed write, in the data directory, is its own slow-motion outage.
  const path = join(dir, "occupied");
  await rm(path, { recursive: true, force: true });
  await import("node:fs/promises").then((fs) => fs.mkdir(path));
  await assert.rejects(() => atomicWriteFile(path, "anything"));
  assert.deepEqual(await litterIn(dir), [], "a failed write left its temp file behind");
  await rm(path, { recursive: true, force: true });
});

test("the file is never world-readable, not even for the instant before the rename", async () => {
  // The mode is applied at CREATE time on the temp file, not chmod'd afterwards — otherwise
  // there is a window in which the at-rest key or a device private key sits on disk with
  // whatever the umask allowed.
  const path = join(dir, "secret");
  await atomicWriteFile(path, "sensitive");
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const readable = join(dir, "public");
  await atomicWriteFile(readable, "not sensitive", 0o644);
  assert.equal((await stat(readable)).mode & 0o777, 0o644, "an explicit mode must be honoured");
});

test("writing into a directory that does not exist fails rather than silently doing nothing", async () => {
  await assert.rejects(() => atomicWriteFile(join(dir, "nope", "file"), "x"), /ENOENT/);
});

/* ==========================================================================================
 * atomicCreateOrRead — the first-run secret race
 * ========================================================================================== */

test("concurrent creators all end up with the same value, in process", async () => {
  const path = join(dir, `secret-${randomUUID()}`);
  let generated = 0;
  const results = await Promise.all(
    Array.from({ length: 32 }, () =>
      atomicCreateOrRead(
        path,
        () => {
          generated += 1;
          return Buffer.from(randomUUID());
        },
        (buf) => buf.length === 36,
      ),
    ),
  );
  const distinct = new Set(results.map((buf) => buf.toString("utf8")));
  assert.equal(distinct.size, 1, `${distinct.size} different values were handed out for one secret`);
  assert.equal([...distinct][0], (await readFile(path, "utf8")).trim(), "the value in memory is not the one on disk");
  assert.ok(generated >= 1, "premise broken: nothing was generated");
});

test("a truncated file is not adopted just because something exists at the path", async () => {
  const path = join(dir, `truncated-${randomUUID()}`);
  await writeFile(path, "hal"); // a partial write of a 36-character value
  await assert.rejects(
    () => atomicCreateOrRead(path, () => Buffer.from(randomUUID()), (buf) => buf.length === 36),
    /could not settle on a value/,
    "a half-written secret was adopted — the process now holds a key nothing else can read",
  );
});

/* ==========================================================================================
 * …and the same race across real processes, which is where it actually happens
 * ========================================================================================== */

const CRYPTO_MODULE = fileURLToPath(new URL("./crypto.js", import.meta.url));
const STORAGE_MODULE = fileURLToPath(new URL("./storage.js", import.meta.url));
const ADMIN_TOKEN_MODULE = fileURLToPath(new URL("./server/admin-token.js", import.meta.url));

/**
 * Each child settles on all three first-run secrets and reports what it is holding IN
 * MEMORY, not what it can read back from disk — the whole failure mode is a process that
 * cached a value the file no longer contains. The ciphertext is the proof for the at-rest
 * key: a child that minted its own key produces something no other party can decrypt.
 */
const FIRST_RUN_CHILD = `
import { encryptToBuffer } from ${JSON.stringify(CRYPTO_MODULE)};
import { getStoreEpoch } from ${JSON.stringify(STORAGE_MODULE)};
import { getAdminToken } from ${JSON.stringify(ADMIN_TOKEN_MODULE)};

// Spawning twelve processes does not make them arrive together — Node's startup jitter is
// far wider than the race being tested, so without a barrier the first child to boot has
// long since written every secret before the last one looks. A shared wall-clock deadline
// puts all twelve at the create within a few milliseconds of each other, which is what
// "the MCP session and the dashboard it spawns start against an empty directory" looks like.
const startAt = Number(process.argv[2]);
await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt - Date.now())));
while (Date.now() < startAt) { /* spin off the last millisecond */ }

const [epoch, token, cipher] = await Promise.all([
  getStoreEpoch(),
  getAdminToken(),
  encryptToBuffer("the same plaintext in every child").then((b) => b.toString("base64")),
]);
process.stdout.write(JSON.stringify({ epoch, token, cipher }));
`;

test("a dozen processes starting at once against an empty data directory agree on every first-run secret", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "docket-first-run-"));
  const scriptPath = join(dataDirectory, "child.mjs");
  await writeFile(scriptPath, FIRST_RUN_CHILD, "utf8");

  const startAt = Date.now() + 2_000; // enough for twelve `node` processes to be up and waiting
  const children = Array.from({ length: 12 }, () => {
    const child = spawn(process.execPath, [scriptPath, String(startAt)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DOCKET_DATA_DIR: dataDirectory },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    return once(child, "exit").then(([code]) => ({ code: code as number | null, out, err }));
  });

  const results = await Promise.all(children);
  const failed = results.filter((r) => r.code !== 0);
  assert.deepEqual(failed.map((r) => r.err.split("\n")[0]), [], "a child failed to settle on a secret at all");

  const parsed = results.map((r) => JSON.parse(r.out) as { epoch: string; token: string; cipher: string });
  assert.equal(new Set(parsed.map((p) => p.epoch)).size, 1, "the store epoch was minted more than once — every paired device's cursor means something different to each of these processes");
  assert.equal(new Set(parsed.map((p) => p.token)).size, 1, "the admin token was minted more than once — the CLI can only ever authorise against one of these servers");

  // The decisive one: whatever the losers cached must decrypt with the key that survived.
  const originalDataDirectory = process.env.DOCKET_DATA_DIR;
  process.env.DOCKET_DATA_DIR = dataDirectory;
  try {
    const { decryptFromBuffer } = await import(`${CRYPTO_MODULE}?first-run=${randomUUID()}`);
    for (const [index, { cipher }] of parsed.entries()) {
      const plaintext = await (decryptFromBuffer as (b: Buffer) => Promise<string>)(Buffer.from(cipher, "base64"));
      assert.equal(plaintext, "the same plaintext in every child", `child ${index} encrypted with a key nobody else has`);
    }
  } finally {
    if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
    else process.env.DOCKET_DATA_DIR = originalDataDirectory;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
