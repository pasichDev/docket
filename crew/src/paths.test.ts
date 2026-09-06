import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireCrewHomeLock, crewPaths, CrewHomeLockedError, ensureCrewTree } from "./paths.js";

/**
 * Defect E — nothing enforced the documented single-writer invariant on DOCKET_CREW_HOME.
 *
 * A duplicate `__daemon` ran restart recovery, rewrote state.json, killed the live daemon's
 * in-flight assignment with a fabricated "interrupted" result, wrote phantom failures into the
 * shared event log and rotated `agent-token` (so every turn started afterwards got 401 and
 * silently lost all crew_* tools) — and only THEN died on EADDRINUSE. Binding a port cannot
 * protect a directory; an O_EXCL lock taken as the daemon's first act can.
 */

async function scratchHome(): Promise<ReturnType<typeof crewPaths>> {
  const root = await mkdtemp(join(tmpdir(), "crew-paths-test-"));
  return ensureCrewTree(crewPaths(root));
}

test("the crew home lock is exclusive: a second holder is refused, by pid", async () => {
  const paths = await scratchHome();
  const first = await acquireCrewHomeLock(paths, process.pid);

  // A second daemon (a different pid) must be refused outright — and told whose home it is.
  await assert.rejects(
    () => acquireCrewHomeLock(paths, 1),
    (err: unknown) =>
      err instanceof CrewHomeLockedError && err.holderPid === process.pid && /already owned/.test(err.message),
  );

  await first.release();
  // Released: the home is claimable again, so a normal restart is not blocked.
  const second = await acquireCrewHomeLock(paths, process.pid);
  await second.release();
});

test("a lock left by a DEAD daemon is reclaimed — a SIGKILL must not lock the home out forever", async () => {
  const paths = await scratchHome();
  // A pid that cannot exist: kill(0) on it fails, so the record is stale by construction.
  await writeFile(paths.lockFile, JSON.stringify({ pid: 0x7fff_fffe, startedAt: "2026-01-01T00:00:00Z" }), "utf8");

  const lock = await acquireCrewHomeLock(paths, process.pid);
  const held = JSON.parse(await readFile(paths.lockFile, "utf8")) as { pid: number };
  assert.equal(held.pid, process.pid);
  await lock.release();
});

test("release() never removes a lock a successor already owns", async () => {
  const paths = await scratchHome();
  const mine = await acquireCrewHomeLock(paths, process.pid);
  // Somebody else's daemon took over the home (its own release/acquire cycle).
  await writeFile(paths.lockFile, JSON.stringify({ pid: 1, startedAt: "2026-01-01T00:00:00Z" }), "utf8");
  await mine.release();
  const still = JSON.parse(await readFile(paths.lockFile, "utf8")) as { pid: number };
  assert.equal(still.pid, 1, "a stale release stole the live daemon's lock");
});

test("the crew tree is 0700 — the root used to be 0755 while everything in it was 0600", async () => {
  const paths = await scratchHome();
  for (const dir of [paths.root, paths.logsDir, paths.worktreesDir]) {
    assert.equal((await stat(dir)).mode & 0o777, 0o700, `${dir} is world-readable`);
  }
});
