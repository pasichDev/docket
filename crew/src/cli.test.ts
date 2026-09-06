import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeCrashHandler, removeDaemonSecrets } from "./cli.js";
import { crewPaths, ensureCrewTree } from "./paths.js";

/**
 * Defect A, the orphaning half.
 *
 * There was no `uncaughtException`/`unhandledRejection` handler anywhere in crew/src. The
 * daemon spawns runtime children into their own process groups, so a crash exited the process
 * with supervisor.stopAll() never running: every child kept going, kept editing worktrees, and
 * daemon.json still advertised a daemon that no longer existed. A crash we cannot prevent must
 * at least not leave that behind.
 */

test("a fatal crash reaps the supervised children and clears daemon.json before exiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "crew-crash-test-"));
  const daemonFile = join(root, "daemon.json");
  await writeFile(daemonFile, JSON.stringify({ pid: process.pid, port: 0, startedAt: "now" }), "utf8");

  let reaped = false;
  const exits: number[] = [];
  const handle = makeCrashHandler({
    reap: async () => {
      reaped = true;
    },
    cleanup: () => rm(daemonFile, { force: true }),
    exit: (code) => exits.push(code),
  });

  await handle(new Error("boom"), "uncaughtException");

  assert.equal(reaped, true, "children were orphaned — they keep editing worktrees after the daemon is gone");
  await assert.rejects(() => stat(daemonFile), "a stale daemon.json was left claiming a dead daemon");
  assert.deepEqual(exits, [1], "a crashed daemon must exit non-zero");
});

test("a reap that hangs cannot stop the crash handler from exiting", async () => {
  const exits: number[] = [];
  const handle = makeCrashHandler({
    reap: () => new Promise<void>(() => {}), // a child that never dies
    cleanup: async () => {},
    exit: (code) => exits.push(code),
    timeoutMs: 100,
  });
  const started = Date.now();
  await handle(new Error("boom"), "unhandledRejection");
  assert.ok(Date.now() - started < 3_000, "the crash handler hung instead of exiting");
  assert.deepEqual(exits, [1]);
});

test("a second crash while reaping does not restart the reaping", async () => {
  let reaps = 0;
  const exits: number[] = [];
  const handle = makeCrashHandler({
    reap: async () => {
      reaps += 1;
    },
    cleanup: async () => {},
    exit: (code) => exits.push(code),
  });
  await Promise.all([handle(new Error("one"), "uncaughtException"), handle(new Error("two"), "uncaughtException")]);
  assert.equal(reaps, 1);
  assert.deepEqual(exits, [1]);
});

// ---------------------------------------------------------------------------
// Defect 8 — a stopped daemon must leave no live secrets behind
// ---------------------------------------------------------------------------

test("stop removes the daemon's secret files, including a symlink planted in their place", async () => {
  /**
   * `agent-token` survived `stop`: a 0600, secret-shaped file naming a credential nothing would
   * ever accept again — and, if an agent had planted a SYMLINK there, the thing the next start
   * would have written through (defect 6's other half). `rm` unlinks the LINK, never its target.
   */
  const root = await mkdtemp(join(tmpdir(), "crew-secrets-test-"));
  const paths = crewPaths(root);
  await ensureCrewTree(paths);

  const victim = join(root, "precious.txt");
  await writeFile(victim, "the user's own file\n");
  await symlink(victim, join(root, "agent-token"));
  await writeFile(join(root, "ui-key"), "deadbeef\n", { mode: 0o600 });
  await mkdir(join(root, "agent-tokens"), { recursive: true });
  await writeFile(join(root, "agent-tokens", "a1.token"), "cafebabe\n", { mode: 0o600 });

  await removeDaemonSecrets(paths);

  for (const gone of ["agent-token", "ui-key", "agent-tokens"]) {
    await assert.rejects(lstat(join(root, gone)), /ENOENT/, `${gone} must not survive stop`);
  }
  assert.equal(await readFile(victim, "utf8"), "the user's own file\n", "the symlink TARGET is not ours to delete");
});
