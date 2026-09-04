import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dataDirectory = await mkdtemp(join(tmpdir(), "docket-store-race-test-"));
// Set BEFORE storage.js is imported anywhere below: it resolves the data directory at
// import time, so a later assignment would have this process reading a different store than
// the children it just spawned.
process.env.DOCKET_DATA_DIR = dataDirectory;
const STORAGE_MODULE = fileURLToPath(new URL("./storage.js", import.meta.url));
const MUTATIONS_MODULE = fileURLToPath(new URL("./mutations.js", import.meta.url));

test.after(() => rm(dataDirectory, { recursive: true, force: true }));

/**
 * A process that takes the store lock, then stalls inside its critical section for longer
 * than the lock's staleness window — a laptop suspending, a SIGSTOP, a debugger. Its
 * heartbeat cannot fire while it is stalled, which is the whole point: no check made before
 * the NEXT acquisition can help a process that is already inside.
 */
const SLOW_WRITER = `
import { appendFileSync, writeFileSync } from "node:fs";
import { withStore } from ${JSON.stringify(STORAGE_MODULE)};
import { createTodo } from ${JSON.stringify(MUTATIONS_MODULE)};

const [markerPath, readyPath, stallMs] = process.argv.slice(2);
let attempt = 0;
await withStore(async (store) => {
  attempt += 1;
  appendFileSync(markerPath, \`attempt \${attempt}: saw \${store.todos.length} item(s)\\n\`);
  if (attempt === 1) {
    writeFileSync(readyPath, "in");
    await new Promise((r) => setTimeout(r, Number(stallMs)));
  }
  createTodo(store, { title: "from the stalled writer", agent: "slow", session: "s" }, "device-slow", "Slow");
});
`;

const QUICK_WRITER = `
import { withStore } from ${JSON.stringify(STORAGE_MODULE)};
import { createTodo } from ${JSON.stringify(MUTATIONS_MODULE)};
await withStore((store) => {
  createTodo(store, { title: "from the reaper", agent: "quick", session: "s" }, "device-quick", "Quick");
});
`;

/** Written to a file rather than passed with `-e`: `node -e` shifts process.argv, so the child would read the wrong paths. */
async function run(name: string, script: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  const scriptPath = join(dataDirectory, `${name}.mjs`);
  await writeFile(scriptPath, script, "utf8");
  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, DOCKET_DATA_DIR: dataDirectory },
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  return once(child, "exit").then(([code]) => ({ code: code as number | null, stderr }));
}

async function waitFor(path: string, timeoutMs = 5_000): Promise<void> {
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

/**
 * The A3 fix, and the only test that exercises it.
 *
 * The lock cannot prevent this race: a process stalled past the staleness window has its
 * lock legitimately reaped while it is still inside its own critical section, and it will
 * happily write whatever it read before the stall — silently discarding everything the
 * reaper wrote. The defence is not prevention, it is detection: the store is stamped when
 * read and re-checked immediately before the commit, so a lost race becomes a retry.
 */
test("a writer whose lock was reaped mid-operation retries instead of clobbering the reaper's write", async () => {
  const markerPath = join(dataDirectory, "attempts.log");
  const readyPath = join(dataDirectory, "ready");
  await writeFile(markerPath, "");

  // The stall outlasts the reap, but stays under the heartbeat interval so the mtime we age
  // below is not refreshed underneath us — the same effect a suspended process has, without
  // making the test wait out a real staleness window.
  const slow = run("slow-writer", SLOW_WRITER, [markerPath, readyPath, "2500"]);
  await waitFor(readyPath);

  // Age the lock so the next contender judges its holder dead. This is what a suspended
  // laptop looks like from the outside.
  const lockPath = join(dataDirectory, "todos.json.enc.lock");
  await waitFor(lockPath);
  const aged = new Date(Date.now() - 60_000);
  await utimes(lockPath, aged, aged);

  const quick = await run("quick-writer", QUICK_WRITER, []);
  assert.equal(quick.code, 0, `the reaper failed: ${quick.stderr}`);

  const slowResult = await slow;
  assert.equal(slowResult.code, 0, `the stalled writer failed: ${slowResult.stderr}`);

  const attempts = (await readFile(markerPath, "utf8")).trim().split("\n").filter(Boolean);
  assert.ok(attempts.length >= 2, `the stalled writer committed without retrying:\n${attempts.join("\n")}`);

  const { readStore } = await import("./storage.js");
  const titles = (await readStore()).todos.map((t) => t.title).sort();
  assert.deepEqual(
    titles,
    ["from the reaper", "from the stalled writer"],
    "a write was lost: the stalled process overwrote the store it no longer held the lock for",
  );
});
