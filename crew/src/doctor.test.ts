import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectDoctor, lastLogLines } from "./cli.js";
import { defaultConfig } from "./config.js";
import { crewPaths, ensureCrewTree } from "./paths.js";
import { createCrewServer } from "./server.js";
import { EventBus } from "./events.js";
import { freshState, StateStore } from "./state.js";
import { git } from "./worktrees.js";
import type { CrewConfig, RuntimeId } from "./types.js";

/**
 * `doctor` is the one command a human runs when the crew is behaving strangely, so its job is
 * to name the causes that are otherwise INVISIBLE. Each test below is one of those: a skill a
 * profile declares but cannot load, `crew/*` branches quietly accumulating, and a daemon from
 * somebody else's crew home already holding the port.
 *
 * Everything is under mkdtemp; DOCKET_CREW_HOME is never the user's real ~/.docket.
 */

async function scratchHome(): Promise<ReturnType<typeof crewPaths>> {
  const paths = crewPaths(await mkdtemp(join(tmpdir(), "crew-doctor-test-")));
  await ensureCrewTree(paths);
  return paths;
}

function configWithSkills(skills: string[]): CrewConfig {
  const base = defaultConfig();
  return {
    ...base,
    profiles: { ...base.profiles, "coder-codex": { ...base.profiles["coder-codex"], skills } },
  };
}

test("doctor resolves each profile's skills to the file they will actually be read from", async () => {
  const paths = await scratchHome();
  const report = await collectDoctor(paths, defaultConfig(), null);

  const manager = report.skills.profiles.find((p) => p.profile === "manager-claude");
  assert.ok(manager, "every configured profile must appear");
  const roleSkill = manager.resolved.find((s) => s.name === "crew-manager");
  assert.ok(roleSkill, "a manager profile must resolve the manager role skill");
  assert.match(roleSkill.source, /crew\/skills\/crew-manager\/SKILL\.md$/, "the source path must be the real file on disk");
  assert.deepEqual(manager.missing, []);
  assert.deepEqual(report.skills.errors, []);
});

test("doctor names a skill a profile declares but cannot load — the silent-misbehaviour case", async () => {
  const paths = await scratchHome();
  const report = await collectDoctor(paths, configWithSkills(["no-such-skill"]), null);

  const row = report.skills.profiles.find((p) => p.profile === "coder-codex");
  assert.ok(row);
  assert.deepEqual(row.missing, ["no-such-skill (not-found)"]);
  assert.ok(
    row.resolved.some((s) => s.name === "crew-worker"),
    "the role skill still loads — one bad name must not blank the profile",
  );
  assert.ok(
    report.skills.errors.some((e) => e.includes("no-such-skill")),
    "a declared-but-missing skill is an ERROR, not a silent omission",
  );
});

test("a user skill in the crew home overrides the packaged one, and doctor says which it shadowed", async () => {
  const paths = await scratchHome();
  await mkdir(join(paths.root, "skills", "crew-worker"), { recursive: true });
  await writeFile(join(paths.root, "skills", "crew-worker", "SKILL.md"), "---\nname: crew-worker\n---\n\nMine.\n", "utf8");

  const report = await collectDoctor(paths, defaultConfig(), null);
  const row = report.skills.profiles.find((p) => p.profile === "coder-codex");
  const worker = row?.resolved.find((s) => s.name === "crew-worker");
  assert.ok(worker);
  assert.equal(worker.source, join(paths.root, "skills", "crew-worker", "SKILL.md"), "the user's file must win");
  assert.ok(
    worker.shadowed.some((p) => p.endsWith("crew/skills/crew-worker/SKILL.md")),
    "doctor must show WHICH file was overridden — that is why an edit to the packaged one had no effect",
  );
});

test("doctor counts the crew/* branches that nothing ever deletes", async () => {
  const repo = await mkdtemp(join(tmpdir(), "crew-doctor-repo-"));
  await git(["init", "-q", "-b", "main"], repo);
  await git(["config", "user.email", "t@example.com"], repo);
  await git(["config", "user.name", "t"], repo);
  await writeFile(join(repo, "f.txt"), "x\n", "utf8");
  await git(["add", "."], repo);
  await git(["commit", "-qm", "init"], repo);
  await git(["branch", "crew/aaaa1111-codex"], repo);
  await git(["branch", "crew/bbbb2222-claude"], repo);
  await git(["branch", "not-a-crew-branch"], repo);

  const paths = await scratchHome();
  const report = await collectDoctor(paths, defaultConfig(), repo);
  assert.ok(report.worktrees, "a git workspace must be reported on");
  assert.equal(report.worktrees.branches, 2, "only crew/* branches count");
  assert.equal(report.worktrees.checkouts, 0, "no worktrees are attached yet");
  assert.ok(report.worktrees.oldestBranch, "the oldest is named so a human knows how far back this goes");

  await rm(repo, { recursive: true, force: true });
});

test("doctor reports a daemon holding the port that this crew home does not own", async () => {
  // A real server on a real port, with a crew home that has no daemon.json — exactly what a
  // second `docket-crew start` from a different DOCKET_CREW_HOME leaves behind.
  const paths = await scratchHome();
  const other = await scratchHome();
  const server = createCrewServer({
    store: new StateStore(other.stateFile, () => freshState("other", 0)),
    bus: new EventBus(other.eventsFile),
    config: defaultConfig(),
    paths: other,
    supervisor: null,
    runtimes: {} as Record<RuntimeId, never>,
    workspace: { workspace: "other", source: "explicit" as never, root: other.root },
  });
  const port = await server.start(0);
  const previous = process.env.DOCKET_CREW_PORT;
  process.env.DOCKET_CREW_PORT = String(port);
  try {
    const report = await collectDoctor(paths, defaultConfig(), null);
    assert.ok(report.strayDaemon, "a foreign daemon on our port must not be silent — `start` would reuse it");
    assert.equal(report.strayDaemon.port, port);
    assert.match(report.strayDaemon.reason, /no daemon\.json/);
  } finally {
    if (previous === undefined) delete process.env.DOCKET_CREW_PORT;
    else process.env.DOCKET_CREW_PORT = previous;
    await server.stop();
  }
});

/**
 * `start` used to fail with only "see daemon.log". The reason is almost always EADDRINUSE, and
 * a user who is told to go read a stack trace usually does not — so the tail is printed inline.
 */
test("a failed start can quote the reason out of the daemon log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crew-doctor-log-"));
  const file = join(dir, "daemon.log");
  await writeFile(
    file,
    [
      "docket-crew: Error: listen EADDRINUSE: address already in use 127.0.0.1:8790",
      "    at Server.setupListenHandle [as _listen2] (node:net:2324:16)",
      "    at listenInCluster (node:net:2433:12)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:90:21)",
      "",
    ].join("\n"),
    "utf8",
  );
  const lines = await lastLogLines(file, 3);
  // The regression this pins: a plain tail returned the bottom THREE STACK FRAMES and hid the
  // one line that names the cause. Frames are dropped so the message survives.
  assert.deepEqual(lines, ["docket-crew: Error: listen EADDRINUSE: address already in use 127.0.0.1:8790"]);

  assert.deepEqual(await lastLogLines(join(dir, "nope.log"), 3), [], "a missing log is not a crash");
  await rm(dir, { recursive: true, force: true });
});

test("doctor locates Docket Core's built dist — the thing that gives workers their todo_* tools", async () => {
  const paths = await scratchHome();
  const report = await collectDoctor(paths, defaultConfig(), null);
  // crew/ lives inside the Docket repo, which is built (npm test builds it), so this must
  // resolve here. When it does NOT, workers lose every todo_* tool with no error anywhere —
  // which is the whole reason doctor reports it.
  assert.ok("path" in report.docketDist, `expected a built dist, got: ${JSON.stringify(report.docketDist)}`);
  assert.match(report.docketDist.path, /dist$/);
});
