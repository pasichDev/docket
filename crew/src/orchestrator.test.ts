import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { canTakeATurn, Orchestrator, type TurnOutcome, type TurnRequest } from "./orchestrator.js";
import { agent, FakeBus, FakeStore, seedAgents } from "./testsupport.js";
import { createAssignment } from "./assignments.js";
import { git } from "./worktrees.js";
import type {
  AgentEvent,
  AgentRuntimeAdapter,
  CrewConfig,
  RuntimeCapabilities,
  RuntimeDetection,
} from "./types.js";
import { EventBus } from "./events.js";
import { crewPaths, ensureCrewTree } from "./paths.js";
import { freshState, StateStore } from "./state.js";
import { Supervisor } from "./supervisor.js";

/**
 * The manager loop (spec §23/§24). No real runtime is involved: `runTurn` is the seam, and
 * these tests are about WHO gets woken WHEN and when the loop is cut off — not about how a
 * CLI is spawned, which is the adapters' (live-tested) business.
 */

function config(overrides: Partial<CrewConfig["automation"]> = {}): CrewConfig {
  return {
    manager: { profile: "manager-claude" },
    profiles: {
      "manager-claude": { name: "manager-claude", runtime: "claude", role: "manager" },
      "coder-codex": { name: "coder-codex", runtime: "codex", role: "worker" },
    },
    automation: {
      managerAutoWake: true,
      maxAutonomousTurns: 10,
      maxAgents: 4,
      maxConcurrentRuns: 3,
      maxRetries: 1,
      ...overrides,
    },
  };
}

interface Harness {
  orchestrator: Orchestrator;
  store: FakeStore;
  bus: FakeBus;
  turns: TurnRequest[];
}

/**
 * `onTurn` stands in for what a real agent does DURING its turn — most importantly calling
 * crew_report, which is what makes the manager wake. It is handed the orchestrator so a
 * test can model a worker that reports (and one that forgets to).
 */
function harness(
  opts: {
    automation?: Partial<CrewConfig["automation"]>;
    onTurn?: (r: TurnRequest, o: Orchestrator) => Promise<void> | void;
    /** Model a runtime that dies mid-turn (rate limit, crash). Default: every turn succeeds. */
    turnOutcome?: (r: TurnRequest) => TurnOutcome | undefined;
    workspaceDir?: string;
    /** The daemon's own git checkout — the human's tree. Set to exercise the isolation guard. */
    workspaceRepoDir?: string;
    cancelRun?: (runId: string) => Promise<void>;
  } = {},
): Harness {
  const store = new FakeStore();
  const bus = new FakeBus();
  const turns: TurnRequest[] = [];
  let orchestrator!: Orchestrator;
  orchestrator = new Orchestrator({
    store,
    bus,
    config: config(opts.automation),
    workspaceDir: opts.workspaceDir ?? "/tmp",
    ...(opts.workspaceRepoDir === undefined ? {} : { workspaceRepoDir: opts.workspaceRepoDir }),
    ...(opts.cancelRun === undefined ? {} : { cancelRun: opts.cancelRun }),
    runTurn: async (request) => {
      turns.push(request);
      await opts.onTurn?.(request, orchestrator);
      return opts.turnOutcome?.(request) ?? { ok: true, resultText: "ok" };
    },
  });
  return { orchestrator, store, bus, turns };
}

/** Let pending microtasks (and the background wakes they start) run. */
async function tick(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/**
 * A real git repo in the OS temp dir, standing in for THE HUMAN'S CHECKOUT. Never their
 * actual repository and never ~/.docket: the defect under test is Crew putting an agent in a
 * tree it was not invited into, and a test that did that to prove it would be the same bug.
 */
async function scratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crew-orch-repo-"));
  await git(["init", "-b", "main"], dir);
  await git(["config", "user.email", "crew@test.local"], dir);
  await git(["config", "user.name", "Crew Test"], dir);
  await git(["config", "commit.gpgsign", "false"], dir);
  await writeFile(join(dir, "README.md"), "seed\n");
  await git(["add", "README.md"], dir);
  await git(["commit", "-m", "seed"], dir);
  return dir;
}

/** A worker that does the job properly: it calls crew_report before ending its turn. */
const reportsDone =
  (summary = "created CHANGELOG.md") =>
  async (request: TurnRequest, orchestrator: Orchestrator) => {
    if (request.agent.role !== "worker" || !request.agent.currentAssignmentId) return;
    await orchestrator.report({
      agentId: request.agent.id,
      assignmentId: request.agent.currentAssignmentId,
      status: "done",
      summary,
    });
  };

test("assign → the worker runs → it reports → the idle manager is woken automatically with the result", async () => {
  // The worker's turn reports "done" from inside the turn, exactly as crew_report does.
  const h = harness({
    onTurn: async (request, orchestrator) => {
      if (request.agent.role !== "worker") return;
      const assignmentId = request.agent.currentAssignmentId;
      if (!assignmentId) return;
      await orchestrator.report({
        agentId: request.agent.id,
        assignmentId,
        status: "done",
        summary: "created CHANGELOG.md",
      });
    },
  });
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    agent({ id: "w1", role: "worker", status: "idle" }),
  );

  const assignment = await h.orchestrator.assign({
    to: "w1",
    title: "add a CHANGELOG",
    instructions: "create CHANGELOG.md",
    assignedBy: "mgr",
  });
  await h.orchestrator.settle();

  // The worker ran without anyone scheduling it by hand.
  assert.equal(h.turns.filter((t) => t.agent.id === "w1").length, 1);
  assert.equal((await h.store.getState()).assignments[assignment.id].status, "done");

  const managerTurns = h.turns.filter((t) => t.agent.id === "mgr");
  assert.equal(managerTurns.length, 1, "the manager was woken exactly once — no manual prompt copying");
  assert.match(managerTurns[0].prompt, /created CHANGELOG\.md/, "the worker's result is IN the manager's prompt");
  assert.equal(h.bus.count("manager.woken"), 1);
  assert.equal((await h.store.getState()).autonomousTurns, 1);
});

test("a worker that ends its turn WITHOUT reporting is sent to review, never silently accepted", async () => {
  const h = harness(); // the fake turn does nothing at all — a worker that forgot crew_report
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    agent({ id: "w1", role: "worker", status: "idle" }),
  );
  const assignment = await h.orchestrator.assign({ to: "w1", title: "t", instructions: "i", assignedBy: "mgr" });
  await h.orchestrator.settle();

  const state = await h.store.getState();
  assert.equal(state.assignments[assignment.id].status, "review", "no verdict is invented for an unreported turn");
  assert.match(state.assignments[assignment.id].result?.summary ?? "", /UNVERIFIED/);
  assert.equal(h.bus.count("manager.woken"), 1, "and the manager is told, rather than the work hanging forever");
});

test("the manager resumes its own session across wakes instead of starting fresh", async () => {
  const h = harness({ onTurn: () => {} });
  await seedAgents(h.store, agent({ id: "mgr", role: "manager", status: "idle", nativeSessionId: "sess-42" }));

  await h.orchestrator.wakeManager("first");
  await h.orchestrator.settle();
  const [turn] = h.turns;
  assert.equal(turn.agent.nativeSessionId, "sess-42", "the runner is handed the session id so it can resume (spec §18)");
});

test("the autonomous-loop guard trips at maxAutonomousTurns, pauses, and says so", async () => {
  const h = harness({ automation: { maxAutonomousTurns: 2 } });
  await seedAgents(h.store, agent({ id: "mgr", role: "manager", status: "idle" }));

  assert.equal(await h.orchestrator.wakeManager("r1"), "ran");
  assert.equal(await h.orchestrator.wakeManager("r2"), "ran");
  assert.equal(await h.orchestrator.wakeManager("r3"), "paused", "the third autonomous wake is refused");
  await h.orchestrator.settle();

  const state = await h.store.getState();
  assert.equal(state.managerPaused, true);
  assert.equal(h.turns.filter((t) => t.agent.id === "mgr").length, 2, "no third turn was ever started");

  const paused = h.bus.events.find((e) => e.type === "manager.paused");
  assert.ok(paused, "manager.paused is emitted so the Office can show it");
  assert.match(paused.summary ?? "", /Manager paused\. Human input required\./);

  // While paused, further autonomous wakes do nothing at all.
  assert.equal(await h.orchestrator.wakeManager("r4"), "skipped");
  assert.equal(h.turns.filter((t) => t.agent.id === "mgr").length, 2);
});

test("human input always overrides: it lifts the pause, resets the counter, and wakes the manager", async () => {
  const h = harness({ automation: { maxAutonomousTurns: 1 } });
  await seedAgents(h.store, agent({ id: "mgr", role: "manager", status: "idle" }));

  await h.orchestrator.wakeManager("r1");
  await h.orchestrator.wakeManager("r2"); // trips the guard
  await h.orchestrator.settle();
  assert.equal((await h.store.getState()).managerPaused, true);

  await h.orchestrator.humanInput("actually, do this instead");
  await h.orchestrator.settle();

  const state = await h.store.getState();
  assert.equal(state.managerPaused, false, "the human overrides the pause");
  assert.equal(state.autonomousTurns, 0, "and resets the budget");
  const last = h.turns.at(-1);
  assert.equal(last?.agent.id, "mgr");
  assert.match(last?.prompt ?? "", /do this instead/);
});

test("managerAutoWake:false stops automatic wakes but not human ones", async () => {
  const h = harness({ automation: { managerAutoWake: false } });
  await seedAgents(h.store, agent({ id: "mgr", role: "manager", status: "idle" }));

  assert.equal(await h.orchestrator.wakeManager("worker finished"), "skipped");
  assert.equal(h.turns.length, 0);

  await h.orchestrator.humanInput("go");
  await h.orchestrator.settle();
  assert.equal(h.turns.length, 1, "the human is never gated by the automation switch");
});

test("a failure inside the retry budget re-queues silently; the manager is only woken once the budget is spent", async () => {
  let attempt = 0;
  const h = harness({
    automation: { maxRetries: 1 },
    onTurn: async (request, orchestrator) => {
      if (request.agent.role !== "worker" || !request.agent.currentAssignmentId) return;
      attempt += 1;
      await orchestrator.report({
        agentId: request.agent.id,
        assignmentId: request.agent.currentAssignmentId,
        status: "failed",
        summary: attempt === 1 ? "compile error" : "still failing",
      });
    },
  });
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    agent({ id: "w1", role: "worker", status: "idle" }),
  );

  const assignment = await h.orchestrator.assign({ to: "w1", title: "t", instructions: "i", assignedBy: "mgr" });
  await h.orchestrator.settle();

  const final = (await h.store.getState()).assignments[assignment.id];
  assert.equal(attempt, 2, "the first failure was retried automatically");
  assert.equal(final.status, "failed");
  assert.equal(final.attempts, 2);
  assert.equal(h.bus.count("manager.woken"), 1, "the manager was bothered only once, after the budget was spent");
  assert.match(h.turns.at(-1)?.prompt ?? "", /still failing/);
});

test("observed Docket sessions can never be assigned, prompted or stopped", async () => {
  const h = harness();
  await seedAgents(h.store, agent({ id: "obs", origin: "observed", status: "idle", name: "Warp session" }));

  await assert.rejects(
    () => h.orchestrator.assign({ to: "obs", title: "t", instructions: "i", assignedBy: "mgr" }),
    /observed session/,
  );
  await assert.rejects(() => h.orchestrator.runAgentTurn("obs", ""), /observed session/);
  await assert.rejects(() => h.orchestrator.stopAgent("obs"), /observed session/);
  assert.equal(h.turns.length, 0);
});

test("maxAgents is a hard limit on spawning", async () => {
  const h = harness({ automation: { maxAgents: 2 } });
  await h.orchestrator.spawnAgent("coder-codex");
  await h.orchestrator.spawnAgent("coder-codex");
  await assert.rejects(() => h.orchestrator.spawnAgent("coder-codex"), /maxAgents limit reached/);
});

test("maxConcurrentRuns refuses to start another turn rather than over-subscribing the machine", async () => {
  const h = harness({ automation: { maxConcurrentRuns: 1 } });
  await seedAgents(
    h.store,
    agent({ id: "w1", status: "working", currentRunId: "busy" }),
    agent({ id: "w2", status: "idle" }),
  );
  await assert.rejects(() => h.orchestrator.runAgentTurn("w2", "go"), /maxConcurrentRuns/);
});

test("the turn prompt carries the real role SKILL.md, the agent's identity and its assignment", async () => {
  const h = harness();
  await seedAgents(h.store, agent({ id: "w1", role: "worker", status: "idle", name: "Codex #1" }));
  await h.orchestrator.assign({ to: "w1", title: "add tests", instructions: "cover the parser", assignedBy: "mgr" });
  await h.orchestrator.settle();

  const prompt = h.turns.find((t) => t.agent.id === "w1")?.prompt ?? "";
  assert.match(prompt, /You are a crew worker/, "crew/skills/crew-worker/SKILL.md is injected into the first turn");
  assert.match(prompt, /never push, merge, publish, tag or release/i, "the authorization boundary travels with every turn");
  assert.match(prompt, /Codex #1/);
  assert.match(prompt, /cover the parser/);
});

test("the manager's turns carry the manager skill, which forbids doing the work itself", async () => {
  const h = harness();
  await seedAgents(h.store, agent({ id: "mgr", role: "manager", status: "idle" }));
  await h.orchestrator.humanInput("build me a thing");
  await h.orchestrator.settle();

  const prompt = h.turns.at(-1)?.prompt ?? "";
  assert.match(prompt, /You are the crew manager/);
  assert.match(prompt, /Do not do the work yourself/);
  assert.match(prompt, /never push, merge, publish, tag or release/i);
});

// ---------------------------------------------------------------------------
// Profile skills, all the way into a real turn prompt
// ---------------------------------------------------------------------------

/**
 * skills.test.ts proves the skill MODULE composes correctly. These prove the WIRE: that
 * `CrewProfile.skills` from config.yml survives spawnAgent → loadSkill → resolveSkillsForProfile
 * → buildTurnPrompt and lands in the prompt an adapter is actually handed. That wire was the
 * last thing to be connected, and every part of it typechecks whether or not it works.
 */
async function skillsHarness(profileSkills: string[], write: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "crew-skills-wire-"));
  for (const [name, body] of Object.entries(write)) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "SKILL.md"), body, "utf8");
  }
  const store = new FakeStore();
  const bus = new FakeBus();
  const turns: TurnRequest[] = [];
  const base = config();
  const orchestrator = new Orchestrator({
    store,
    bus,
    config: {
      ...base,
      profiles: { ...base.profiles, "coder-codex": { ...base.profiles["coder-codex"], skills: profileSkills } },
    },
    workspaceDir: "/tmp",
    // The crew-home root. The packaged crew/skills stays beneath it, so `crew-worker` still
    // resolves — which is the point: an extra skill must ADD to the role skill, never replace it.
    skillsDir: root,
    runTurn: async (request) => {
      turns.push(request);
      return { ok: true, resultText: "ok" };
    },
  });
  return { orchestrator, turns, root };
}

test("a profile's declared skills are composed into its turn prompt, after the role skill", async () => {
  const h = await skillsHarness(["house-style"], {
    "house-style": "---\nname: house-style\ndescription: local rules\n---\n\n# House style\n\nHOUSE_STYLE_MARKER: two-space indent, no trailing commas.\n",
  });
  const spawned = await h.orchestrator.spawnAgent("coder-codex");
  await h.orchestrator.runAgentTurn(spawned.id, "");

  const prompt = h.turns.at(-1)?.prompt ?? "";
  assert.match(prompt, /HOUSE_STYLE_MARKER/, "the profile's extra skill never reached the prompt");
  assert.match(prompt, /You are a crew worker/, "the role skill must still be there — extras add, they do not replace");
  assert.ok(
    prompt.indexOf("You are a crew worker") < prompt.indexOf("HOUSE_STYLE_MARKER"),
    "the role skill leads: it is what makes the agent a worker at all",
  );
  // Frontmatter is metadata for a loader, not prompt content — and a prompt starting with
  // `---` is parsed as a flag by claude's argv parser (see skills.ts stripSkillFrontmatter).
  assert.doesNotMatch(prompt, /description: local rules/, "frontmatter must be stripped, not injected");
  assert.ok(!prompt.startsWith("-"), "a prompt may never begin with a dash");
});

test("a profile naming a skill that does not exist tells the agent so, rather than injecting nothing", async () => {
  const h = await skillsHarness(["does-not-exist"], {});
  const spawned = await h.orchestrator.spawnAgent("coder-codex");
  await h.orchestrator.runAgentTurn(spawned.id, "");

  const prompt = h.turns.at(-1)?.prompt ?? "";
  assert.match(prompt, /You are a crew worker/, "one bad name must not cost the agent its role skill");
  assert.match(prompt, /does-not-exist \(not-found\)/, "the agent must be told its instructions are incomplete");
  assert.match(prompt, /Do not guess at the missing rules/);
});

test("two profiles sharing a role get their OWN skill sets — the cache keys on profile, not role", async () => {
  const root = await mkdtemp(join(tmpdir(), "crew-skills-cache-"));
  for (const name of ["skill-a", "skill-b"]) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\n---\n\nMARKER_${name.toUpperCase().replace("-", "_")}\n`, "utf8");
  }
  const store = new FakeStore();
  const bus = new FakeBus();
  const turns: TurnRequest[] = [];
  const base = config();
  const orchestrator = new Orchestrator({
    store,
    bus,
    config: {
      ...base,
      profiles: {
        ...base.profiles,
        "worker-a": { name: "worker-a", runtime: "codex", role: "worker", skills: ["skill-a"] },
        "worker-b": { name: "worker-b", runtime: "codex", role: "worker", skills: ["skill-b"] },
      },
    },
    workspaceDir: "/tmp",
    skillsDir: root,
    runTurn: async (request) => {
      turns.push(request);
      return { ok: true, resultText: "ok" };
    },
  });

  const a = await orchestrator.spawnAgent("worker-a");
  const b = await orchestrator.spawnAgent("worker-b");
  await orchestrator.runAgentTurn(a.id, "");
  await orchestrator.runAgentTurn(b.id, "");

  const promptA = turns.find((t) => t.agent.id === a.id)?.prompt ?? "";
  const promptB = turns.find((t) => t.agent.id === b.id)?.prompt ?? "";
  assert.match(promptA, /MARKER_SKILL_A/);
  assert.doesNotMatch(promptA, /MARKER_SKILL_B/);
  // The failure this guards: a cache keyed on role alone hands the second worker the first
  // one's rules, silently, forever.
  assert.match(promptB, /MARKER_SKILL_B/, "worker-b was served worker-a's cached skill set");
  assert.doesNotMatch(promptB, /MARKER_SKILL_A/);
});

test("an empty result text is NOT treated as failure (verified codex resume behaviour)", async () => {
  const store = new FakeStore();
  const bus = new FakeBus();
  const orchestrator = new Orchestrator({
    store,
    bus,
    config: config(),
    workspaceDir: "/tmp",
    // Exactly what a codex resume can produce: a clean turn whose result text is empty.
    runTurn: async () => ({ ok: true, resultText: "" }),
  });
  await seedAgents(store, agent({ id: "w1", status: "idle" }));
  const outcome = await orchestrator.runAgentTurn("w1", "do it");
  assert.equal(outcome.ok, true);
  assert.equal((await store.getState()).agents.w1.status, "idle");
  assert.equal(bus.count("agent.failed"), 0, "empty result text must never be reported as a failure");
});

// ---------------------------------------------------------------------------
// A failed manager turn must not be a dead end, and a finished worker result must
// never be dropped on the floor (defect 1)
// ---------------------------------------------------------------------------

test("a worker result still reaches the manager after the manager's own last turn failed", async () => {
  const h = harness({ onTurn: reportsDone() });
  // Exactly the state a rate-limited or crashed manager turn leaves behind.
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "failed" }),
    agent({ id: "w1", role: "worker", status: "idle" }),
  );

  const assignment = await h.orchestrator.assign({
    to: "w1",
    title: "t",
    instructions: "i",
    assignedBy: "human",
    requestedBy: "human",
  });
  await h.orchestrator.settle();

  assert.equal((await h.store.getState()).assignments[assignment.id].status, "done");
  const managerTurns = h.turns.filter((t) => t.agent.id === "mgr");
  assert.equal(managerTurns.length, 1, "the completed work was reported to the manager, not silently dropped");
  assert.match(managerTurns[0].prompt, /created CHANGELOG\.md/, "and the result itself is in the prompt");
  assert.equal((await h.store.getState()).agents.mgr.status, "idle", "the manager was restarted in place");
});

test("human input recovers a failed manager instead of reporting that none is running", async () => {
  const h = harness();
  await seedAgents(h.store, agent({ id: "mgr", role: "manager", status: "failed" }));

  await h.orchestrator.humanInput("carry on");
  await h.orchestrator.settle();

  assert.match(h.turns.at(-1)?.prompt ?? "", /carry on/);
  assert.equal((await h.store.getState()).agents.mgr.status, "idle");
});

test("a manager wake gets a bounded retry, and a wake that cannot be delivered is LOUD", async () => {
  const h = harness({
    automation: { maxRetries: 1 },
    onTurn: reportsDone("the parser is fixed and the tests pass"),
    // The manager runtime is down for the whole test — every wake of it dies.
    turnOutcome: (r) => (r.agent.role === "manager" ? { ok: false, resultText: "", error: "rate limit" } : undefined),
  });
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    agent({ id: "w1", role: "worker", status: "idle" }),
  );

  await h.orchestrator.assign({ to: "w1", title: "t", instructions: "i", assignedBy: "human", requestedBy: "human" });
  await h.orchestrator.settle();

  const managerTurns = h.turns.filter((t) => t.agent.id === "mgr");
  assert.equal(managerTurns.length, 2, "one retry, then it stops — no infinite wake loop");
  for (const turn of managerTurns) {
    assert.match(turn.prompt, /the parser is fixed/, "a failed turn does not consume the result it was woken with");
  }

  const undelivered = h.bus.events.find((e) => /not delivered/i.test(e.summary ?? ""));
  assert.ok(undelivered, "the undeliverable wake is announced in the feed");
  assert.match(undelivered.summary ?? "", /the parser is fixed/, "carrying the result nobody read");
  assert.match(undelivered.summary ?? "", /rate limit/, "and why it could not be handed over");
  assert.equal((await h.store.getState()).managerPaused, true, "and the Office shows the crew needs a human");
});

test("a completed result with no manager at all is surfaced, never swallowed", async () => {
  const h = harness({ onTurn: reportsDone("shipped it") });
  await seedAgents(h.store, agent({ id: "w1", role: "worker", status: "idle" }));

  const assignment = await h.orchestrator.assign({
    to: "w1",
    title: "t",
    instructions: "i",
    assignedBy: "human",
    requestedBy: "human",
  });
  await h.orchestrator.settle();

  assert.equal((await h.store.getState()).assignments[assignment.id].status, "done");
  const undelivered = h.bus.events.find((e) => /not delivered/i.test(e.summary ?? ""));
  assert.ok(undelivered, "the human is told that nobody received the finished work");
  assert.match(undelivered.summary ?? "", /shipped it/);
});

test("a wake refused because every run slot was busy is retried when one frees", async () => {
  /**
   * maxConcurrentRuns:1, and the worker keeps working after crew_report — which is what a
   * real runtime does: the tool call returns and the turn ends some time later. So the
   * manager's wake is attempted while the worker still holds the only slot, is refused, and
   * used to be lost with the result sitting unread in an idle manager's inbox.
   */
  const h = harness({
    automation: { maxConcurrentRuns: 1 },
    onTurn: async (request, orchestrator) => {
      await reportsDone("the fix is on crew/abc")(request, orchestrator);
      if (request.agent.role !== "worker") return;
      // Stay "working" long enough for the background wake to be attempted and refused.
      for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
    },
  });
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    agent({ id: "w1", role: "worker", status: "idle" }),
  );

  await h.orchestrator.assign({ to: "w1", title: "t", instructions: "i", assignedBy: "human", requestedBy: "human" });
  await h.orchestrator.settle();

  const managerTurns = h.turns.filter((t) => t.agent.id === "mgr");
  assert.equal(managerTurns.length, 1, "the result reached the manager once a slot freed");
  assert.match(managerTurns[0].prompt, /the fix is on crew\/abc/);
  assert.equal((await h.store.getState()).messages.every((m) => m.readAt), true, "and nothing is left unread");
});

test("an automatic retry after a CRASHED worker turn is actually dispatched", async () => {
  let attempts = 0;
  const h = harness({
    automation: { maxRetries: 1 },
    // No crew_report at all: the runtime itself dies, which is what a rate limit looks like.
    turnOutcome: (r) => {
      if (r.agent.role !== "worker") return undefined;
      attempts += 1;
      return { ok: false, resultText: "", error: "runtime crashed" };
    },
  });
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    agent({ id: "w1", role: "worker", status: "idle" }),
  );

  const assignment = await h.orchestrator.assign({
    to: "w1",
    title: "t",
    instructions: "i",
    assignedBy: "human",
    requestedBy: "human",
  });
  await h.orchestrator.settle();

  assert.equal(attempts, 2, "the retry the failure booked actually ran instead of sitting queued forever");
  const final = (await h.store.getState()).assignments[assignment.id];
  assert.equal(final.status, "failed");
  assert.equal(h.bus.count("manager.woken"), 1, "and the manager is told once the budget is spent");
});

test("pause/resume from the human are explicit, event-emitting operations", async () => {
  const h = harness();
  await seedAgents(h.store, agent({ id: "mgr", role: "manager", status: "idle" }));

  await h.orchestrator.pauseManager("Office button");
  assert.equal((await h.store.getState()).managerPaused, true);
  assert.equal(await h.orchestrator.wakeManager("worker result"), "skipped");

  await h.orchestrator.resumeManager();
  const state = await h.store.getState();
  assert.equal(state.managerPaused, false);
  assert.equal(state.autonomousTurns, 0);
  assert.equal(await h.orchestrator.wakeManager("worker result"), "ran");
});

// ---------------------------------------------------------------------------
// A — an agent may never put a worker in the human's checkout, whichever door
//     it comes through. The decision belongs to STARTING A TURN, not to assign().
// ---------------------------------------------------------------------------

test("an agent-sent message can never start a worker turn in the human's own checkout", async () => {
  const repo = await scratchRepo();
  // Exactly the daemon's shape: the crew runs inside the human's git checkout.
  const h = harness({ workspaceDir: repo, workspaceRepoDir: repo });
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle", cwd: repo }),
    // A worker that never had an isolated assignment: spawnAgent's default cwd IS the repo.
    agent({ id: "w1", role: "worker", status: "idle", cwd: repo }),
  );

  // Byte-for-byte what crew_send does — no assignment, no worktree, no human.
  await h.orchestrator.mailbox.send({
    from: "mgr",
    to: "w1",
    workspace: "test-ws",
    kind: "message",
    body: "have a look at the login route",
  });
  await h.orchestrator.settle();

  const workerTurns = h.turns.filter((t) => t.agent.id === "w1");
  assert.equal(workerTurns.length, 1, "the message still gets answered");
  assert.notEqual(
    resolve(workerTurns[0].cwd),
    resolve(repo),
    "a worker turn must NEVER be started in the crew's own workspace repository",
  );
  const refusal = h.bus.events.find((e) => e.data?.refusedWorkspaceRun === true);
  assert.ok(refusal, "and the human sees that it was refused, rather than it happening silently");
});

test("the MANAGER still runs in the human's checkout — the guard is about workers, not everyone", async () => {
  const repo = await scratchRepo();
  const h = harness({ workspaceDir: repo, workspaceRepoDir: repo });
  await seedAgents(h.store, agent({ id: "mgr", role: "manager", status: "idle", cwd: repo }));

  await h.orchestrator.humanInput("plan the release");
  await h.orchestrator.settle();

  const managerTurn = h.turns.find((t) => t.agent.id === "mgr");
  assert.equal(resolve(managerTurn?.cwd ?? ""), resolve(repo));
});

test("a queued assignment cannot smuggle a worker into the workspace repo either", async () => {
  const repo = await scratchRepo();
  const h = harness({ workspaceDir: repo, workspaceRepoDir: repo });
  await seedAgents(h.store, agent({ id: "w1", role: "worker", status: "idle", cwd: repo }));
  // The fail-open shape: an assignment that exists, is queued and has no worktree.
  await h.store.withState((state) => {
    const a = createAssignment({ title: "t", instructions: "i", workspace: "w", assignedBy: "mgr", assignedTo: "w1" });
    state.assignments[a.id] = a;
  });

  await h.orchestrator.pump();
  await h.orchestrator.settle();

  const workerTurns = h.turns.filter((t) => t.agent.id === "w1");
  assert.equal(workerTurns.length, 1);
  assert.notEqual(resolve(workerTurns[0].cwd), resolve(repo));
});

test("a NON-isolated run the human authorised really does run in their checkout", async () => {
  const repo = await scratchRepo();
  const h = harness({ workspaceDir: repo, workspaceRepoDir: repo });
  await seedAgents(h.store, agent({ id: "w1", role: "worker", status: "idle", cwd: repo }));

  await h.orchestrator.assign({
    to: "w1",
    title: "t",
    instructions: "i",
    assignedBy: "human",
    requestedBy: "human",
  });
  await h.orchestrator.settle();

  const workerTurns = h.turns.filter((t) => t.agent.id === "w1");
  assert.equal(workerTurns.length, 1);
  assert.equal(resolve(workerTurns[0].cwd), resolve(repo), "the human's own choice must still work");
});

// ---------------------------------------------------------------------------
// B / C — stop stops, and a turn's epilogue only writes its OWN run's state
// ---------------------------------------------------------------------------

test("a stopped agent stays stopped: the cancelled turn's epilogue must not resurrect it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({
    onTurn: async (r) => {
      if (r.agent.id === "w1") await gate;
    },
    turnOutcome: (r) => (r.agent.id === "w1" ? { ok: false, resultText: "", error: "cancelled" } : undefined),
    cancelRun: async () => release(),
  });
  await seedAgents(h.store, agent({ id: "mgr", role: "manager", status: "idle" }), agent({ id: "w1", status: "idle" }));

  const turn = h.orchestrator.runAgentTurn("w1", "go").catch(() => undefined);
  await tick();
  await h.orchestrator.stopAgent("w1");
  await turn;
  await h.orchestrator.settle();

  const stopped = (await h.store.getState()).agents.w1;
  assert.equal(stopped.status, "stopped", "the cancelled turn's epilogue overwrote the human's stop");
  assert.equal(canTakeATurn(stopped), false);

  // The exact consequence the reviewers reproduced: the next thing that wakes it restarts it.
  await h.orchestrator.mailbox.send({ from: "mgr", to: "w1", workspace: "w", body: "one more thing" });
  await h.orchestrator.settle();
  assert.equal(h.turns.filter((t) => t.agent.id === "w1").length, 1, "a stopped agent took another turn");
});

test("a cancelled run's late epilogue does not overwrite the state that replaced it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({
    onTurn: async (r) => {
      if (r.agent.id === "w1") await gate;
    },
    // A cancelled turn comes back as a FAILED one — which is what the epilogue then wrote over
    // the state the cancel had just established.
    turnOutcome: (r) => (r.agent.id === "w1" ? { ok: false, resultText: "", error: "cancelled" } : undefined),
    cancelRun: async () => {
      /* a child that has not died yet — the run is still in flight */
    },
  });
  await seedAgents(h.store, agent({ id: "w1", status: "idle" }));

  const turn = h.orchestrator.runAgentTurn("w1", "go").catch(() => undefined);
  await tick();
  await h.orchestrator.cancelAgentRun("w1");
  assert.equal((await h.store.getState()).agents.w1.status, "idle");

  release();
  await turn;
  await h.orchestrator.settle();
  assert.equal((await h.store.getState()).agents.w1.status, "idle", "the cancelled run wrote over its successor's state");
});

test("one agent can never have two turns in flight — two CLI children on one worktree", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({
    automation: { maxConcurrentRuns: 1 },
    onTurn: async (r) => {
      if (r.agent.id === "w1") await gate;
    },
    cancelRun: async () => {
      /* the child ignores the signal, as a wedged CLI does */
    },
  });
  await seedAgents(h.store, agent({ id: "w1", status: "idle" }));

  const first = h.orchestrator.runAgentTurn("w1", "one").catch(() => undefined);
  await tick();
  // A cancel clears currentRunId while the child is still alive; state alone then says "idle".
  await h.orchestrator.cancelAgentRun("w1");
  await assert.rejects(() => h.orchestrator.runAgentTurn("w1", "two"), /already executing/);

  release();
  await first;
  await h.orchestrator.settle();
  assert.equal(h.turns.filter((t) => t.agent.id === "w1").length, 1);
});

test("a native session is never handed to a turn in a directory it was not created in", async () => {
  const h = harness();
  await seedAgents(h.store, agent({ id: "w1", status: "idle", cwd: "/tmp/tree-a", nativeSessionId: "sess-a" }));
  await h.store.withState((state) => {
    const a = createAssignment({ title: "t", instructions: "i", workspace: "w", assignedBy: "m", assignedTo: "w1" });
    a.worktree = { repoDir: "/tmp/repo", assignmentId: a.id, branch: "crew/x", path: "/tmp/tree-b", baseCommit: "abc" };
    state.assignments[a.id] = a;
  });

  await h.orchestrator.pump();
  await h.orchestrator.settle();

  const turn = h.turns.find((t) => t.agent.id === "w1");
  assert.equal(turn?.cwd, "/tmp/tree-b", "the turn runs in the assignment's worktree");
  assert.equal(turn?.agent.nativeSessionId, undefined, "resuming sess-a here would run it in the wrong tree");
});

// ---------------------------------------------------------------------------
// D — each assignment runs in ITS OWN worktree
// ---------------------------------------------------------------------------

test("two queued assignments each run in their OWN worktree, not in the newest one", async () => {
  const repo = await scratchRepo();
  const h = harness({ workspaceDir: repo, workspaceRepoDir: repo, onTurn: reportsDone("done") });
  // The worker is busy while both assignments are created, so both really do queue up.
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle", cwd: repo }),
    agent({ id: "w1", role: "worker", status: "working", currentRunId: "external", cwd: repo }),
  );

  const a1 = await h.orchestrator.assign({
    to: "w1", title: "first", instructions: "i", assignedBy: "mgr", isolate: { repoDir: repo },
  });
  const a2 = await h.orchestrator.assign({
    to: "w1", title: "second", instructions: "i", assignedBy: "mgr", isolate: { repoDir: repo },
  });
  await h.orchestrator.settle();

  await h.store.withState((state) => {
    state.agents.w1.status = "idle";
    delete state.agents.w1.currentRunId;
  });
  await h.orchestrator.pump();
  await h.orchestrator.settle();

  const workerTurns = h.turns.filter((t) => t.agent.id === "w1");
  assert.equal(workerTurns.length, 2);
  const state = await h.store.getState();
  assert.equal(workerTurns[0].cwd, state.assignments[a1.id].worktree?.path, "assignment 1 ran in assignment 2's tree");
  assert.equal(workerTurns[1].cwd, state.assignments[a2.id].worktree?.path);
  assert.notEqual(workerTurns[0].cwd, workerTurns[1].cwd);
});

// ---------------------------------------------------------------------------
// E — worktree bookkeeping must survive the daemon that created it
// ---------------------------------------------------------------------------

test("worktree bookkeeping survives a restart: the report still says WHERE the work is", async () => {
  const repo = await scratchRepo();
  const h = harness({ workspaceDir: repo, workspaceRepoDir: repo });
  await seedAgents(h.store, agent({ id: "w1", role: "worker", status: "working", currentRunId: "external", cwd: repo }));
  const assignment = await h.orchestrator.assign({
    to: "w1", title: "t", instructions: "i", assignedBy: "mgr", isolate: { repoDir: repo },
  });
  await h.orchestrator.settle();

  // A NEW daemon over the same state: everything in-memory is gone, the branches are not.
  const restarted = new Orchestrator({
    store: h.store,
    bus: h.bus,
    config: config(),
    workspaceDir: repo,
    workspaceRepoDir: repo,
    runTurn: async () => ({ ok: true, resultText: "ok" }),
  });
  await restarted.assignments.start(assignment.id);
  const reported = await restarted.report({ agentId: "w1", assignmentId: assignment.id, status: "done", summary: "shipped" });

  assert.ok(reported.result?.branch, "the record of WHERE the work is was lost with the daemon");
  assert.ok(reported.result?.worktree);
  assert.ok(reported.result?.diffStat);
});

// ---------------------------------------------------------------------------
// F / G — the queue must not head-of-line block, and a refused turn must not
//         strand a claimed assignment
// ---------------------------------------------------------------------------

test("a queued assignment whose assignee is stopped does not block the rest of the queue", async () => {
  const h = harness();
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    agent({ id: "w1", status: "working", currentRunId: "x" }),
    agent({ id: "w2", status: "working", currentRunId: "y" }),
  );
  await h.store.withState((state) => {
    const first = createAssignment({ title: "blocked", instructions: "i", workspace: "w", assignedBy: "mgr", assignedTo: "w1" });
    const second = createAssignment({ title: "runnable", instructions: "i", workspace: "w", assignedBy: "mgr", assignedTo: "w2" });
    state.assignments[first.id] = first;
    state.assignments[second.id] = second;
  });

  await h.orchestrator.stopAgent("w1");
  await h.store.withState((state) => {
    state.agents.w2.status = "idle";
    delete state.agents.w2.currentRunId;
  });
  await h.orchestrator.pump();
  await h.orchestrator.settle();

  assert.equal(h.turns.filter((t) => t.agent.id === "w2").length, 1, "one unclaimable item blocked the whole queue");
  assert.equal(h.turns.filter((t) => t.agent.id === "w1").length, 0);
});

test("a turn the pump cannot start releases its claim instead of stranding the assignment", async () => {
  const h = harness();
  await seedAgents(h.store, agent({ id: "mgr", role: "manager", status: "idle" }), agent({ id: "w1", status: "idle" }));

  // Something else starts a turn for the assignee between the claim and the turn — exactly
  // what deliverQueuedMail/a mailbox wake do, both fired from a finishing turn's epilogue.
  let hijacked = false;
  h.bus.subscribe((e) => {
    if (e.type !== "assignment.started" || hijacked) return;
    hijacked = true;
    void h.orchestrator.runAgentTurn("w1", "surprise").catch(() => undefined);
  });

  await h.orchestrator.assign({ to: "w1", title: "t", instructions: "i", assignedBy: "human", requestedBy: "human" });
  await h.orchestrator.settle();

  const failed = h.bus.events.find((e) => /background task failed/.test(e.summary ?? ""));
  assert.equal(failed, undefined, "AgentBusyError escaped the pump and became an opaque failure");
  const assignment = Object.values((await h.store.getState()).assignments)[0];
  assert.notEqual(assignment.status, "running", "left running with nobody running it");
});

// ---------------------------------------------------------------------------
// H — a rejected review must be runnable again, and no turn may hijack an
//     assignment it was not built with
// ---------------------------------------------------------------------------

test("a rejected review goes back to the queue and is actually re-dispatched", async () => {
  const h = harness();
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    agent({ id: "rv", role: "reviewer", status: "idle" }),
    agent({ id: "w1", role: "worker", status: "idle" }),
  );
  const assignment = await h.orchestrator.assign({
    to: "w1", title: "t", instructions: "i", assignedBy: "human", requestedBy: "human",
  });
  await h.orchestrator.settle();
  assert.equal((await h.store.getState()).assignments[assignment.id].status, "review");

  const before = h.turns.filter((t) => t.agent.id === "w1").length;
  await h.orchestrator.completeReview("rv", assignment.id, false, "the retry only covers network errors");
  await h.orchestrator.settle();

  const after = (await h.store.getState()).assignments[assignment.id];
  assert.notEqual(after.status, "running", "a rejected review parks the assignment where nothing will ever pick it up");
  assert.ok(
    h.turns.filter((t) => t.agent.id === "w1").length > before,
    "the rework was never dispatched to anyone",
  );
});

test("a turn started for something else never auto-reports somebody's running assignment", async () => {
  const h = harness();
  await seedAgents(h.store, agent({ id: "mgr", role: "manager", status: "idle" }), agent({ id: "w1", status: "idle" }));
  // A stranded `running` assignment — the state a rejected review (or a crashed pump) leaves.
  const stranded = await h.store.withState((state) => {
    const a = createAssignment({ title: "someone else's work", instructions: "i", workspace: "w", assignedBy: "mgr", assignedTo: "w1" });
    a.status = "running";
    a.attempts = 1;
    state.assignments[a.id] = a;
    return a.id;
  });

  await h.orchestrator.runAgentTurn("w1", "say hi");
  await h.orchestrator.settle();

  const after = (await h.store.getState()).assignments[stranded];
  assert.equal(after.status, "running", "an unrelated turn moved someone else's assignment to review");
  assert.equal(after.result, undefined, "and invented a verdict for it");
});

// ---------------------------------------------------------------------------
// I — boot must pick up what the previous daemon left behind
// ---------------------------------------------------------------------------

test("boot dispatches queued work and wakes the manager only when it has something to read", async () => {
  const h = harness();
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    agent({ id: "w1", role: "worker", status: "idle" }),
  );
  await h.store.withState((state) => {
    const a = createAssignment({ title: "left over", instructions: "i", workspace: "w", assignedBy: "mgr", assignedTo: "w1" });
    state.assignments[a.id] = a;
    state.messages.push({
      id: "m1", from: "w1", to: "mgr", workspace: "w", kind: "result",
      body: "finished before the restart", createdAt: new Date().toISOString(),
    });
  });

  await h.orchestrator.resumeAfterBoot();
  await h.orchestrator.settle();

  assert.equal(h.turns.filter((t) => t.agent.id === "w1").length, 1, "the queued assignment sat forever after a restart");
  const managerTurns = h.turns.filter((t) => t.agent.id === "mgr");
  assert.ok(managerTurns.length >= 1, "the unread result sat forever after a restart");
  assert.match(managerTurns[0].prompt, /finished before the restart/);
});

test("boot does NOT wake a manager that has nothing waiting for it", async () => {
  const h = harness();
  await seedAgents(h.store, agent({ id: "mgr", role: "manager", status: "idle" }));
  await h.orchestrator.resumeAfterBoot();
  await h.orchestrator.settle();
  assert.equal(h.turns.length, 0, "a restart must not spend a manager turn on an empty inbox");
});

// ---------------------------------------------------------------------------
// J — the delivery status the human is shown must be true
// ---------------------------------------------------------------------------

test('a message to a PAUSED manager is reported "queued", never "woken"', async () => {
  const h = harness();
  await seedAgents(h.store, agent({ id: "mgr", role: "manager", status: "idle" }), agent({ id: "w1", status: "idle" }));
  await h.orchestrator.pauseManager("human pressed pause");

  const outcome = await h.orchestrator.mailbox.send({
    from: "w1", to: "mgr", workspace: "w", kind: "result", body: "assignment finished",
  });
  await h.orchestrator.settle();

  assert.equal(h.turns.length, 0, "the paused manager really did not take a turn");
  assert.equal(outcome.delivery, "queued", "the sender was told the manager was woken when it was not");
});

test('a message refused by managerAutoWake:false is reported "queued" too', async () => {
  const h = harness({ automation: { managerAutoWake: false } });
  await seedAgents(h.store, agent({ id: "mgr", role: "manager", status: "idle" }), agent({ id: "w1", status: "idle" }));

  const outcome = await h.orchestrator.mailbox.send({
    from: "w1", to: "mgr", workspace: "w", kind: "result", body: "assignment finished",
  });
  await h.orchestrator.settle();
  assert.equal(h.turns.length, 0);
  assert.equal(outcome.delivery, "queued");
});

test("mail that arrives DURING a worker's turn is still delivered by that turn's epilogue", async () => {
  /**
   * The epilogue starts the agent's own next turn to hand over mail that queued behind it. It is
   * the one place a turn legitimately wakes the very agent that just finished, so anything
   * guarding "one turn at a time" must have let go by then.
   */
  const h = harness({
    onTurn: async (request, orchestrator) => {
      if (request.agent.id !== "w1" || request.prompt.includes("while you were busy")) return;
      await orchestrator.mailbox.send({ from: "human", to: "w1", workspace: "w", body: "while you were busy" });
    },
  });
  await seedAgents(h.store, agent({ id: "w1", status: "idle" }));

  await h.orchestrator.runAgentTurn("w1", "first");
  await h.orchestrator.settle();

  const turns = h.turns.filter((t) => t.agent.id === "w1");
  assert.equal(turns.length, 2, "the message queued behind the turn was never opened");
  assert.match(turns[1].prompt, /while you were busy/);
  assert.equal((await h.store.getState()).messages.every((m) => m.readAt), true);
});

test("a SUBDIRECTORY of the human's checkout is the human's checkout too", async () => {
  const repo = await scratchRepo();
  const inside = join(repo, "src");
  await mkdir(inside, { recursive: true });
  const h = harness({ workspaceDir: repo, workspaceRepoDir: repo });
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle", cwd: repo }),
    agent({ id: "w1", role: "worker", status: "idle", cwd: inside }),
  );

  await h.orchestrator.mailbox.send({ from: "mgr", to: "w1", workspace: "w", body: "take a look" });
  await h.orchestrator.settle();

  const turn = h.turns.find((t) => t.agent.id === "w1");
  assert.ok(turn);
  assert.equal(resolve(turn.cwd).startsWith(resolve(repo)), false, "a cwd under the repo is still the repo");
});

// ---------------------------------------------------------------------------
// Defect 9 — a cancelled turn is a decision, not a failure
// ---------------------------------------------------------------------------

test("a CANCELLED turn is not reported as a failed one, and does not spend the retry budget", async () => {
  /**
   * `runAgentTurn` mapped every `ok:false` to the same place: `agent.failed` on the bus, the
   * attached assignment reported `failed`, a retry from the §45 budget, and a manager wake
   * saying the worker failed. The supervisor already tells the two apart — it latches the abort
   * and refuses to call a turn that produced work cancelled (supervisor.ts) — so the human who
   * pressed cancel was being told their own click broke something.
   */
  let attempts = 0;
  const h = harness({
    turnOutcome: () => {
      attempts += 1;
      return { ok: false, cancelled: true, resultText: "" };
    },
  });
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    agent({ id: "w1", role: "worker", status: "idle", name: "backend" }),
  );

  const assignment = await h.orchestrator.assign({ to: "w1", title: "t", instructions: "i", assignedBy: "mgr" });
  await h.orchestrator.settle();

  const final = (await h.store.getState()).assignments[assignment.id];
  assert.equal(final.status, "cancelled", `a cancelled run leaves a cancelled assignment, got ${final.status}`);
  assert.equal(attempts, 1, "a deliberate cancellation must not be retried");
  assert.equal(h.bus.count("agent.failed"), 0, "nothing here is a failure");
  assert.ok(h.bus.count("agent.stopped") > 0, "the run ending on purpose is agent.stopped");
});

test("a genuinely FAILED turn still fails loudly — the cancellation path must not swallow it", async () => {
  // The other half of the same change: `ok:false` without `cancelled` is unchanged.
  const h = harness({
    automation: { maxRetries: 0 },
    turnOutcome: () => ({ ok: false, resultText: "", error: "rate limited" }),
  });
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    agent({ id: "w1", role: "worker", status: "idle" }),
  );
  const assignment = await h.orchestrator.assign({ to: "w1", title: "t", instructions: "i", assignedBy: "mgr" });
  await h.orchestrator.settle();

  const final = (await h.store.getState()).assignments[assignment.id];
  assert.equal(final.status, "failed");
  assert.ok(h.bus.count("agent.failed") > 0);
});

// ---------------------------------------------------------------------------
// Defect 10 — the pump was fully serial, so maxConcurrentRuns bought nothing
// ---------------------------------------------------------------------------

/** Seed one `queued` assignment per agent id, oldest first, and return their ids. */
async function queueFor(store: FakeStore, ...agentIds: string[]): Promise<string[]> {
  return store.withState((state) => {
    const ids: string[] = [];
    for (const [i, to] of agentIds.entries()) {
      const a = createAssignment(
        { title: `work for ${to}`, instructions: "i", workspace: "w", assignedBy: "mgr", assignedTo: to },
        new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(),
      );
      state.assignments[a.id] = a;
      ids.push(a.id);
    }
    return ids;
  });
}

/** Every turn the WORKERS took — manager wakes are legitimate extra turns and not the subject here. */
function workerTurns(h: Harness): TurnRequest[] {
  return h.turns.filter((t) => t.agent.role !== "manager");
}

/**
 * Let real async work (fs reads inside buildTurnPrompt) finish, not just the microtask queue:
 * a turn takes several macrotask hops to reach the runtime, so setImmediate rounds alone can
 * observe zero turns in flight and mask the very thing under test.
 */
async function settleTimers(ms = 50): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

/** A turn that parks inside the runtime until released, counting how many are parked at once. */
function gatedTurns(): { onTurn: () => Promise<void>; release: () => void; peak: () => number } {
  let live = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return {
    onTurn: async () => {
      live += 1;
      peak = Math.max(peak, live);
      await gate;
      live -= 1;
    },
    release: () => release(),
    peak: () => peak,
  };
}

test("three idle workers with three queued assignments really do run AT THE SAME TIME", async () => {
  /**
   * The defect: pumpOnce awaited runAgentTurn INSIDE its sweep loop, so the queue was drained
   * one turn at a time no matter what maxConcurrentRuns said. Reproduced exactly as the
   * reviewer described it — three idle workers, three queued assignments, peak in-flight 1.
   */
  const gate = gatedTurns();
  const h = harness({ automation: { maxConcurrentRuns: 4 }, onTurn: gate.onTurn });
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    agent({ id: "w1", status: "idle" }),
    agent({ id: "w2", status: "idle" }),
    agent({ id: "w3", status: "idle" }),
  );
  await queueFor(h.store, "w1", "w2", "w3");

  // Deliberately not awaited: with the serial pump this promise does not settle until every
  // turn has finished, which is the defect itself — the assertion is about what is in flight.
  const pumped = h.orchestrator.pump();
  await settleTimers();

  assert.equal(gate.peak(), 3, `maxConcurrentRuns:4 with three runnable workers ran ${gate.peak()} turn(s) at once`);
  gate.release();
  await pumped;
  await h.orchestrator.settle();
  assert.equal(workerTurns(h).length, 3);
});

test("maxConcurrentRuns is still the ceiling — the pump does not start a fourth turn", async () => {
  const gate = gatedTurns();
  const h = harness({ automation: { maxConcurrentRuns: 2 }, onTurn: gate.onTurn });
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    agent({ id: "w1", status: "idle" }),
    agent({ id: "w2", status: "idle" }),
    agent({ id: "w3", status: "idle" }),
  );
  const ids = await queueFor(h.store, "w1", "w2", "w3");

  const pumped = h.orchestrator.pump();
  await settleTimers();

  assert.equal(gate.peak(), 2, `the limit is 2, ${gate.peak()} turns were in flight`);
  // The one that did not fit must be back in the queue, not stranded `running` with nobody on it.
  const state = await h.store.getState();
  const parked = ids.map((id) => state.assignments[id]).filter((a) => a.status === "queued");
  assert.equal(parked.length, 1, "the assignment that did not fit must stay dispatchable");
  assert.equal(parked[0].attempts, 0, "a claim handed back must hand back the attempt it booked");

  gate.release();
  await pumped;
  await h.orchestrator.settle();
  assert.equal(workerTurns(h).length, 3, "the parked assignment runs once a slot frees");
});

test("concurrent sweeps never start the same assignment twice", async () => {
  /**
   * The property the single-flight lock was originally protecting, asserted directly against
   * the atomic claim: five pumps racing over five assignments, each of which also re-pumps
   * from inside its own turn. Exactly one `assignment.started` per assignment, one attempt
   * each, and no illegal `running → running`.
   */
  const h = harness({
    onTurn: (_r, o) => {
      o.schedulePump(); // a finishing turn pumps; do it mid-turn to maximise the overlap
    },
    automation: { maxConcurrentRuns: 5 },
  });
  await seedAgents(
    h.store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    ...["w1", "w2", "w3", "w4", "w5"].map((id) => agent({ id, status: "idle" })),
  );
  const ids = await queueFor(h.store, "w1", "w2", "w3", "w4", "w5");

  await Promise.all([
    h.orchestrator.pump(),
    h.orchestrator.pump(),
    h.orchestrator.pump(),
    h.orchestrator.pump(),
    h.orchestrator.pump(),
  ]);
  await h.orchestrator.settle();

  for (const id of ids) {
    const starts = h.bus.events.filter((e) => e.type === "assignment.started" && e.assignmentId === id);
    assert.equal(starts.length, 1, `assignment ${id} was started ${starts.length} times`);
  }
  assert.equal(workerTurns(h).length, 5, "one turn per assignment, no doubles");
  const broken = h.bus.events.find((e) => /illegal transition|background task failed/.test(e.summary ?? ""));
  assert.equal(broken, undefined, `a concurrent sweep broke the state machine: ${broken?.summary}`);
});

// ---------------------------------------------------------------------------
// Defect 11 — end to end: a wedged runtime must not pin an agent or an assignment
// ---------------------------------------------------------------------------

/** A runtime that speaks once and then never again, and never exits. */
class WedgedRuntime implements AgentRuntimeAdapter {
  readonly id = "claude" as const;
  #release!: () => void;
  readonly stuck = new Promise<void>((resolve) => {
    this.#release = resolve;
  });
  release(): void {
    this.#release();
  }
  async detect(): Promise<RuntimeDetection> {
    return { id: this.id, installed: true, executable: "/bin/true" };
  }
  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      nonInteractive: true,
      structuredOutput: true,
      resume: true,
      workingDirectoryFlag: false,
      modelSelection: true,
      providerSelection: false,
    };
  }
  async *startTurn(): AsyncIterable<AgentEvent> {
    yield { type: "status", status: "init" };
    await this.stuck;
  }
  async *resumeTurn(): AsyncIterable<AgentEvent> {
    yield* this.startTurn();
  }
  async cancel(): Promise<void> {}
}

test("a wedged runtime leaves the agent free, the slot free and the assignment ACTIONABLE", async () => {
  /**
   * The real seam, end to end: the orchestrator drives a real Supervisor (publishLifecycle
   * false, exactly as runtime.ts's createTurnRunner does) over a runtime that never ends. Every
   * assertion here is something that was pinned forever before the watchdog existed.
   */
  const root = await mkdtemp(join(tmpdir(), "crew-orch-timeout-"));
  const paths = crewPaths(root);
  await ensureCrewTree(paths);
  const supervisor = new Supervisor({
    store: new StateStore(paths.stateFile, () => freshState("test-ws", 0)),
    bus: new EventBus(paths.eventsFile),
    paths,
    maxConcurrentRuns: 1,
    turnIdleTimeoutMs: 150,
  });
  const wedged = new WedgedRuntime();

  const store = new FakeStore();
  const bus = new FakeBus();
  const orchestrator = new Orchestrator({
    store,
    bus,
    config: config({ maxConcurrentRuns: 1, maxRetries: 0 }),
    workspaceDir: root,
    cancelRun: async (runId) => void (await supervisor.cancelRun(runId)),
    runTurn: async ({ agent: a, runId, prompt, cwd }) => {
      const o = await supervisor.runTurn(wedged, a.id, { runId, prompt, cwd }, undefined, { publishLifecycle: false });
      return { ok: o.ok, cancelled: o.cancelled, resultText: o.resultText ?? "", error: o.errorMessage };
    },
  });
  await seedAgents(
    store,
    agent({ id: "mgr", role: "manager", status: "idle" }),
    agent({ id: "w1", role: "worker", status: "idle" }),
  );

  const assignment = await orchestrator.assign({ to: "w1", title: "wedges", instructions: "i", assignedBy: "mgr" });
  await orchestrator.settle();

  const state = await store.getState();
  const worker = state.agents.w1;
  assert.notEqual(worker.status, "working", "the agent is still pinned at working");
  assert.equal(worker.currentRunId, undefined, "the run slot is still held");
  assert.equal(supervisor.runningCount, 0, "the supervisor's maxConcurrentRuns slot is still held");

  const final = state.assignments[assignment.id];
  assert.equal(final.status, "failed", `a timed-out assignment must land somewhere a human can act on, got ${final.status}`);
  assert.notEqual(final.status, "cancelled", "a wedged runtime must not masquerade as a deliberate stop");
  assert.match(final.result?.summary ?? "", /timed out/i, "the assignment does not say WHY it ended");
  assert.match(final.result?.summary ?? "", /\d+s/, "and does not say how long it hung");
  assert.match(final.result?.summary ?? "", /worktree/i, "no verdict on the work itself — point at the evidence instead");

  // The agent is genuinely free again: another turn starts rather than throwing AgentBusyError.
  wedged.release();
  await orchestrator.runAgentTurn("w1", "still there?");
  await orchestrator.settle();
});
