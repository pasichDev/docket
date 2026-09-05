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

/*
 * The three-process case, which is the whole reason the restore uses `link` rather than
 * `rename`.
 *
 * The test above ("does not delete the new holder's lock") is the two-process version, and
 * it passes either way: when the releaser puts back what it claimed, it is putting back the
 * NEW holder's record, and rename and link behave identically because the path is free. The
 * difference only exists in the gap between the claim and the restore, during which the lock
 * path is genuinely unlocked — so a third process can legitimately acquire it. `rename` then
 * silently deletes that third process's brand-new lock and installs a stale record in its
 * place; `link` fails with EEXIST and leaves it alone.
 *
 * Scheduling a real third contender inside that gap is not something a test can do
 * deterministically, so the restore is exercised directly against both states the path can
 * be in.
 */
test("withFileLock: restoring a claimed lock refuses to clobber one someone else has since taken", async () => {
  const { readFile, rm: remove, writeFile: write } = await import("node:fs/promises");
  const { restoreLockRecord } = await import("./filelock.js");
  const lockPath = join(dataDirectory, "three-way.lock");
  const claimedPath = `${lockPath}.releasing.claimed`;
  await write(claimedPath, "record-A");

  // A third process acquired during the gap. Its lock is the only legitimate one now.
  await write(lockPath, "record-C");
  assert.equal(await restoreLockRecord(claimedPath, lockPath), "superseded");
  assert.equal(await readFile(lockPath, "utf8"), "record-C", "the restore overwrote a lock its owner still holds");

  // Nobody took the path: the rightful holder gets its record back.
  await remove(lockPath, { force: true });
  assert.equal(await restoreLockRecord(claimedPath, lockPath), "restored");
  assert.equal(await readFile(lockPath, "utf8"), "record-A");
  await remove(lockPath, { force: true });
  await remove(claimedPath, { force: true });
});

test("the lease reports loss by identity, so a fresh lock at the same path is not mistaken for ours", async () => {
  const { writeFile: write, utimes: touch } = await import("node:fs/promises");
  const { LeaseLostError } = await import("./filelock.js");
  const lockPath = join(dataDirectory, "identity.lock");
  let error: unknown = null;

  await withFileLock(lockPath, async (lease) => {
    // Reaped and replaced while this process still believes it is inside.
    const aged = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await touch(lockPath, aged, aged);
    await write(lockPath, JSON.stringify({ id: "someone-else", pid: 1, host: "elsewhere", startedAt: new Date().toISOString() }));
    error = await lease.assertOwned().then(() => null, (err: unknown) => err);
  });
  assert.ok(error instanceof LeaseLostError, `expected LeaseLostError, got ${String(error)}`);
});

/* ==========================================================================================
 * The small encrypted registries, which had no detection at all before the lease existed
 *
 * storage.ts always caught a lost race with its own content stamp. peers, viewers, server
 * devices and remote credentials simply wrote — so a writer suspended past the staleness
 * window would wake up and overwrite a newer registry with the copy it read minutes ago,
 * silently unpairing a device that had just been added or restoring one just revoked.
 * ========================================================================================== */

/** What a suspended holder looks like from outside: a lock nobody has refreshed in far too long. */
async function ageLock(lockPath: string): Promise<void> {
  const { utimes: touch } = await import("node:fs/promises");
  const aged = new Date(Date.now() - LOCK_STALE_MS - 60_000);
  await touch(lockPath, aged, aged);
}

function gate(): { reached: Promise<void>; open(): void } {
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (open = () => resolve()));
  return { reached, open };
}

test("withRegistry: a writer whose lock was reaped retries instead of overwriting the newer registry", async () => {
  const { readFile, writeFile: write } = await import("node:fs/promises");
  const { withRegistry } = await import("./registry.js");
  const path = join(dataDirectory, "registry.json");
  const lockPath = `${path}.lock`;
  await write(path, JSON.stringify([]));

  const options = {
    path,
    lockPath,
    name: "test registry",
    load: async () => JSON.parse(await readFile(path, "utf8")) as string[],
    serialize: (value: string[]) => Buffer.from(JSON.stringify(value)),
  };

  const stalled = gate();
  const mayFinish = gate();
  let attempts = 0;
  let sawOnAttemptTwo: string[] = [];

  const suspended = withRegistry(options, async (entries) => {
    attempts += 1;
    if (attempts === 1) {
      stalled.open();
      await mayFinish.reached;
    } else {
      sawOnAttemptTwo = [...entries];
    }
    entries.push(`a${attempts}`);
  });
  await stalled.reached;

  await ageLock(lockPath);
  await withRegistry(options, (entries) => entries.push("b"));

  mayFinish.open();
  await suspended;

  assert.equal(attempts, 2, "the stalled writer committed without ever re-reading the registry");
  assert.deepEqual(sawOnAttemptTwo, ["b"], "the retry must run against the registry that actually won");
  assert.deepEqual(
    JSON.parse(await readFile(path, "utf8")),
    ["b", "a2"],
    "the reaped writer overwrote a newer registry — this is how a just-approved device silently unpairs",
  );
});

test("withRegistry: a write is abandoned rather than committed when the state keeps moving", async () => {
  // Three lost races in a row is not contention any more, it is something stuck. Retrying
  // forever would hang a tool call; committing anyway is the exact bug the retry prevents.
  const { readFile, writeFile: write } = await import("node:fs/promises");
  const { withRegistry } = await import("./registry.js");
  const path = join(dataDirectory, "hostile.json");
  await write(path, JSON.stringify([]));

  let interference = 0;
  await assert.rejects(
    () =>
      withRegistry(
        {
          path,
          lockPath: `${path}.lock`,
          name: "hostile registry",
          load: async () => JSON.parse(await readFile(path, "utf8")) as string[],
          serialize: (value: string[]) => Buffer.from(JSON.stringify(value)),
        },
        async (entries) => {
          // Someone else commits between this attempt's load and its commit, every time.
          await write(path, JSON.stringify([`other-${++interference}`]));
          entries.push("mine");
        },
      ),
    /kept changing underneath this write/,
  );
  assert.equal(interference, 3, "it must give up after a bounded number of attempts, not spin");
  assert.deepEqual(
    JSON.parse(await readFile(path, "utf8")),
    ["other-3"],
    "the abandoned write must leave the other writer's state exactly as it was",
  );
});
