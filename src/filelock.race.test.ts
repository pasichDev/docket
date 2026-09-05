import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-filelock-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { LOCK_HEARTBEAT_MS, LOCK_STALE_MS, withFileLock } = await import("./filelock.js");

/** The compiled module the child processes import — the same one under test here. */
const FILELOCK_MODULE = fileURLToPath(new URL("./filelock.js", import.meta.url));

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

/**
 * Two contenders, in real separate processes — not two async calls in one, which would
 * never exercise the cross-process reap at all. Each writes an ENTER and an EXIT marker
 * around its critical section; if the lock ever admits both, the markers interleave.
 *
 * They synchronise on a wall-clock start time so both land in the acquire path together.
 * Without that they'd queue politely and the test would pass for the wrong reason.
 */
const CHILD_SOURCE = `
import { appendFileSync } from "node:fs";
import { withFileLock } from ${JSON.stringify(FILELOCK_MODULE)};

const [lockPath, markerPath, id, startAt] = process.argv.slice(2);
await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));

await withFileLock(lockPath, async () => {
  appendFileSync(markerPath, \`ENTER \${id}\\n\`);
  await new Promise((r) => setTimeout(r, 250));
  appendFileSync(markerPath, \`EXIT \${id}\\n\`);
});
`;

async function runContenders(lockPath: string, markerPath: string): Promise<string[]> {
  const childPath = join(dataDirectory, "contender.mjs");
  await writeFile(childPath, CHILD_SOURCE, "utf8");
  const startAt = Date.now() + 400;
  const children = ["a", "b"].map((id) =>
    spawn(process.execPath, [childPath, lockPath, markerPath, id, String(startAt)], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, DOCKET_DATA_DIR: dataDirectory },
    }),
  );
  const stderr = children.map((c) => {
    let out = "";
    c.stderr.on("data", (chunk) => (out += chunk));
    return () => out;
  });
  const codes = await Promise.all(children.map((c) => once(c, "exit")));
  codes.forEach(([code], i) => assert.equal(code, 0, `contender exited ${code}: ${stderr[i]()}`));
  return (await readFile(markerPath, "utf8")).trim().split("\n").filter(Boolean);
}

test("withFileLock: two processes reaping the same stale lock never both enter the critical section", async () => {
  const lockPath = join(dataDirectory, "race.lock");
  const markerPath = join(dataDirectory, "race.markers");
  await writeFile(markerPath, "");

  // A crashed holder's lock, left behind and already past the staleness threshold. Both
  // contenders will judge it reapable at the same moment — the exact setup where a
  // delete-then-create reap lets the second one delete the FIRST one's brand-new lock.
  await writeFile(lockPath, JSON.stringify({ pid: 999999, host: "gone", startedAt: new Date(0).toISOString() }));
  const aged = new Date(Date.now() - LOCK_STALE_MS * 3);
  await utimes(lockPath, aged, aged);

  const markers = await runContenders(lockPath, markerPath);
  assert.equal(markers.length, 4, `expected two complete sections, got: ${markers.join(" | ")}`);

  let inside: string | null = null;
  for (const marker of markers) {
    const [event, id] = marker.split(" ");
    if (event === "ENTER") {
      assert.equal(inside, null, `${id} entered while ${inside} was still inside — two processes held the lock at once`);
      inside = id;
    } else {
      assert.equal(inside, id, `${id} exited a section it never entered`);
      inside = null;
    }
  }
  assert.equal(inside, null);
});

test("withFileLock: a legitimately-held lock is kept fresh, so a slow operation isn't reaped out from under it", async () => {
  const lockPath = join(dataDirectory, "heartbeat.lock");
  let mtimeWhileHeld = 0;
  const heldFor = LOCK_HEARTBEAT_MS + 400;

  await withFileLock(lockPath, async () => {
    const { stat } = await import("node:fs/promises");
    const before = (await stat(lockPath)).mtimeMs;
    await new Promise((r) => setTimeout(r, heldFor));
    mtimeWhileHeld = (await stat(lockPath)).mtimeMs - before;
  });

  assert.ok(
    mtimeWhileHeld > 0,
    "the lock's mtime never advanced while it was held — an operation slower than LOCK_STALE_MS would have its lock reaped",
  );
});

test("withFileLock: a nested acquisition of the same lock fails immediately and names both call sites", async () => {
  const lockPath = join(dataDirectory, "nested.lock");
  const startedAt = Date.now();

  await assert.rejects(
    () => withFileLock(lockPath, () => withFileLock(lockPath, () => "unreachable")),
    (err: Error) => {
      assert.match(err.message, /already held/i);
      assert.match(err.message, /filelock\.race\.test/, "the message must name where the lock is held and where it was re-entered");
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 1_000, "a nested acquisition must fail immediately, not sit until the acquire timeout");
});

test("withFileLock: two different locks may be held at once — only re-entering the SAME one is an error", async () => {
  const outer = join(dataDirectory, "outer.lock");
  const inner = join(dataDirectory, "inner.lock");
  const result = await withFileLock(outer, () => withFileLock(inner, () => "ok"));
  assert.equal(result, "ok");
});

test("withFileLock: a process whose lock was reaped while held does not delete the new holder's lock", async () => {
  const { readFile, writeFile } = await import("node:fs/promises");
  const lockPath = join(dataDirectory, "stolen.lock");

  await withFileLock(lockPath, async () => {
    // Simulate the residual window: something reaped this lock and took it. Whatever this
    // process does next must not make that worse for the process that now holds it.
    await writeFile(lockPath, JSON.stringify({ id: "someone-else", pid: 1, host: "other", startedAt: new Date().toISOString() }));
  });

  const survivor = JSON.parse(await readFile(lockPath, "utf8")) as { id: string };
  assert.equal(survivor.id, "someone-else", "releasing must not delete a lock this process no longer owns");
  await rm(lockPath, { force: true });
});

test("withFileLock: a lock that came back to life between judging and reaping is put back, not stolen", async () => {
  const { stat, utimes, writeFile } = await import("node:fs/promises");
  const lockPath = join(dataDirectory, "revived.lock");

  // A holder that looks stale by mtime but is genuinely alive is indistinguishable from a
  // crashed one at the instant of judging — a suspended laptop resuming looks exactly like
  // this. The reap must notice the refreshed mtime before it commits.
  const holder = JSON.stringify({ id: "alive", pid: process.pid, host: "here", startedAt: new Date().toISOString() });
  await writeFile(lockPath, holder);
  const aged = new Date(Date.now() - LOCK_STALE_MS * 3);
  await utimes(lockPath, aged, aged);

  // The holder heartbeats just before a contender would rename it away.
  const now = new Date();
  await utimes(lockPath, now, now);

  await assert.rejects(
    () => withFileLock(lockPath, () => "should not get in"),
    /timed out waiting for lock/,
    "a live holder's lock must be waited for, not reaped",
  );
  assert.ok((await stat(lockPath)).isFile(), "and it must still be there afterwards");
  await rm(lockPath, { force: true });
});

test("withFileLock: ownership decided by rename, so a lock taken between judging and unlinking survives", async () => {
  /*
   * The narrow window the previous test could not reach.
   *
   * Release used to be read-then-unlink: read the holder record, see "mine", unlink. A
   * process suspended between those two steps — which is what a laptop lid does — wakes up
   * to find its lock long since reaped and a NEW holder in place, and then unlinks that
   * holder's lock. One bad reap turns into a chain of them, and the second victim has no
   * optimistic stamp to catch it the way the todo store does.
   *
   * Claiming by rename removes the window rather than narrowing it: rename is atomic and
   * has exactly one winner, so whatever this call moves aside is the file it is entitled to
   * judge, and nobody else can still be looking at it.
   */
  const { readFile, writeFile, stat } = await import("node:fs/promises");
  const lockPath = join(dataDirectory, "toctou.lock");
  const newHolder = JSON.stringify({ id: "new-holder", pid: 424242, host: "elsewhere", startedAt: new Date().toISOString() });

  await withFileLock(lockPath, async () => {
    // Precisely the suspension: this process still believes it holds the lock, and by the
    // time it releases, the file on disk belongs to someone else.
    await writeFile(lockPath, newHolder);
    await new Promise((r) => setTimeout(r, 20));
  });

  assert.ok((await stat(lockPath)).isFile(), "the new holder's lock was deleted by the previous holder's release");
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).id, "new-holder", "the lock file was replaced rather than left alone");

  // And the new holder can still release its own lock normally afterwards.
  await rm(lockPath, { force: true });
  await withFileLock(lockPath, async () => {});
  await assert.rejects(() => stat(lockPath), "a normal release must still remove the lock");
});
