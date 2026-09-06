import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { defaultConfig } from "./config.js";
import { EventBus } from "./events.js";
import { AGENT_RPC_PATH, ENV_AGENT_ROLE } from "./mcp/protocol.js";
import { Orchestrator, type TurnRequest } from "./orchestrator.js";
import { crewPaths, ensureCrewTree, type CrewPaths } from "./paths.js";
import { AgentTokenRegistry } from "./agent-tokens.js";
import { OutputBuffers, registerCrewCommands, registerCrewRoutes, registerGatedOfficeRoutes } from "./runtime.js";
import type { CommandRegistry, CrewCommand } from "./cli.js";
import { createCrewServer, UI_KEY_HEADER, UI_SESSION_COOKIE, type CrewServer } from "./server.js";
import { freshState, StateStore } from "./state.js";
import { git } from "./worktrees.js";
import type { CrewAgent, RuntimeId } from "./types.js";

/**
 * The Office control surface (spec §33/§43). Every scratch path is under the OS temp dir and
 * DOCKET_CREW_HOME is never the user's real ~/.docket.
 */

/** A real per-agent registry, in a scratch dir: identity is bound server-side, not claimed. */
function tokenRegistry(root: string): AgentTokenRegistry {
  return new AgentTokenRegistry(join(root, "agent-tokens"));
}

interface Fixture {
  base: string;
  /** The scratch crew home. `paths` is derived from it; never the user's ~/.docket. */
  root: string;
  paths: CrewPaths;
  server: CrewServer;
  orchestrator: Orchestrator;
  agentTokens: AgentTokenRegistry;
  turns: TurnRequest[];
  cookie: string;
  stop(): Promise<void>;
}

/**
 * Speak as one specific agent on the RPC channel — the way a real turn does, by holding that
 * agent's own leased token. There is no crew-wide token to borrow any more (agent-tokens.ts).
 */
async function tokenFor(f: Fixture, agentId: string): Promise<string> {
  return (await f.agentTokens.lease(agentId)).token;
}

const running: CrewServer[] = [];
after(async () => {
  await Promise.all(running.map((s) => s.stop()));
});

async function fixture(opts: { workspaceRepoDir?: string; office?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "crew-control-test-"));
  const paths = crewPaths(root);
  await ensureCrewTree(paths);
  const store = new StateStore(paths.stateFile, () => freshState("test-ws", 0));
  const bus = new EventBus(paths.eventsFile);
  const config = defaultConfig();
  const turns: TurnRequest[] = [];

  const orchestrator = new Orchestrator({
    store,
    bus,
    config,
    workspaceDir: opts.workspaceRepoDir ?? root,
    workspaceRepoDir: opts.workspaceRepoDir,
    runTurn: async (request) => {
      turns.push(request);
      return { ok: true, resultText: "done" };
    },
  });

  const agentTokens = tokenRegistry(root);
  const server = createCrewServer({
    store,
    bus,
    config,
    paths,
    supervisor: null,
    runtimes: {} as Record<RuntimeId, never>,
    workspace: { workspace: "test-ws", source: "explicit" as never, root },
  });
  registerCrewRoutes({
    server,
    orchestrator,
    config,
    agentTokens,
    outputs: new OutputBuffers(),
    workspaceRepoDir: opts.workspaceRepoDir,
  });
  // Mounted the way attachToDaemon mounts it: the gate first, then the Office's own routes.
  if (opts.office) registerGatedOfficeRoutes(server);
  // The daemon writes this in attachToDaemon; the CLI reads it back to authorize its own calls.
  await writeFile(join(root, "ui-key"), server.ctx.uiKey + "\n", { mode: 0o600 });
  const port = await server.start(0);
  running.push(server);
  return {
    base: `http://127.0.0.1:${port}`,
    root,
    paths,
    server,
    orchestrator,
    agentTokens,
    turns,
    cookie: `${UI_SESSION_COOKIE}=${server.ctx.uiSessionToken}`,
    stop: () => server.stop(),
  };
}

/** Raw HTTP, for the cases fetch() refuses to express (a forged Host header). */
function rawRequest(
  f: Fixture,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ statusCode: number; body: string }> {
  const url = new URL(f.base);
  return new Promise((resolvePromise, reject) => {
    const req = request(
      { host: "127.0.0.1", port: Number(url.port), method: opts.method, path: opts.path, headers: opts.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolvePromise({ statusCode: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** A request shaped the way a real browser tab on the Office page sends one. */
function browser(f: Fixture, extra: RequestInit = {}): RequestInit {
  return {
    ...extra,
    headers: {
      "Content-Type": "application/json",
      Origin: new URL(f.base).origin,
      Cookie: f.cookie,
      ...(extra.headers as Record<string, string> | undefined),
    },
  };
}

test("GET /api/profiles returns the profile list and the manager profile name", async () => {
  const f = await fixture();
  const res = await fetch(`${f.base}/api/profiles`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { profiles: { name: string }[]; manager: string };
  assert.ok(body.profiles.some((p) => p.name === "coder-codex"));
  assert.equal(body.manager, "manager-claude");
});

test("a cross-origin mutation is rejected before it reaches any handler", async () => {
  const f = await fixture();
  const res = await fetch(`${f.base}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example", Cookie: f.cookie },
    body: JSON.stringify({ goal: "exfiltrate" }),
  });
  assert.equal(res.status, 403);
  assert.match((await res.text()), /cross-origin/);
});

test("a DNS-rebinding Host header is rejected", async () => {
  const f = await fixture();
  // Raw http, not fetch: `Host` is a forbidden header for fetch(), and this attack is
  // precisely a request that carries an attacker-controlled Host — so it has to be sent by
  // something that will actually send it.
  const { statusCode, body } = await rawRequest(f, {
    method: "GET",
    path: "/api/profiles",
    headers: { Host: "attacker.example.com" },
  });
  assert.equal(statusCode, 403);
  assert.match(body, /Host header/);
});

test("a legitimate local Host (localhost, an IP literal) is accepted", async () => {
  const f = await fixture();
  for (const host of [`127.0.0.1:${new URL(f.base).port}`, `localhost:${new URL(f.base).port}`]) {
    const { statusCode } = await rawRequest(f, { method: "GET", path: "/api/profiles", headers: { Host: host } });
    assert.equal(statusCode, 200, `${host} must be allowed`);
  }
});

test("a browser request without the UI session cookie cannot mutate", async () => {
  const f = await fixture();
  const res = await fetch(`${f.base}/api/agents/spawn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(f.base).origin },
    body: JSON.stringify({ profile: "coder-codex" }),
  });
  assert.equal(res.status, 403);
  // The refusal names the way back in — the keyed URL `docket-crew start` prints, or the header.
  assert.match(await res.text(), /not proven to come from the human/);
});

test("a stale UI session token is rejected (the daemon restarted)", async () => {
  const f = await fixture();
  const res = await fetch(
    `${f.base}/api/agents/spawn`,
    browser(f, {
      method: "POST",
      headers: { Cookie: `${UI_SESSION_COOKIE}=deadbeef` },
      body: JSON.stringify({ profile: "coder-codex" }),
    }),
  );
  assert.equal(res.status, 403);
});

test("spawn → message → cancel → stop, each emitting its CrewEvent for the live feed", async () => {
  const f = await fixture();
  const seen: string[] = [];
  f.server.ctx.bus.subscribe((e) => seen.push(e.type));

  const spawned = await fetch(
    `${f.base}/api/agents/spawn`,
    browser(f, { method: "POST", body: JSON.stringify({ profile: "coder-codex" }) }),
  );
  assert.equal(spawned.status, 200);
  const { agent } = (await spawned.json()) as { agent: CrewAgent };
  assert.equal(agent.runtime, "codex");
  assert.ok(seen.includes("agent.spawned"));

  const messaged = await fetch(
    `${f.base}/api/agents/${agent.id}/message`,
    browser(f, { method: "POST", body: JSON.stringify({ body: "hello" }) }),
  );
  assert.equal(messaged.status, 200);
  assert.ok(seen.includes("message.sent"));
  // The message woke the agent (it was idle) — let that turn finish before cancelling, so
  // the assertion below is about cancel's semantics rather than a race with the wake.
  await f.orchestrator.settle();

  // Nothing is running, so cancel is a truthful no-op rather than a lie.
  const cancelled = await fetch(`${f.base}/api/agents/${agent.id}/cancel`, browser(f, { method: "POST" }));
  assert.equal(cancelled.status, 200);
  assert.equal(((await cancelled.json()) as { cancelled: boolean }).cancelled, false);

  const stopped = await fetch(`${f.base}/api/agents/${agent.id}/stop`, browser(f, { method: "POST" }));
  assert.equal(stopped.status, 200);
  assert.ok(seen.includes("agent.stopped"));
});

test("the manager can be started from the UI, idempotently", async () => {
  const f = await fixture();
  const first = (await (await fetch(`${f.base}/api/manager/start`, browser(f, { method: "POST" }))).json()) as {
    agent: CrewAgent;
    created: boolean;
  };
  assert.equal(first.created, true);
  assert.equal(first.agent.role, "manager");

  const second = (await (await fetch(`${f.base}/api/manager/start`, browser(f, { method: "POST" }))).json()) as {
    agent: CrewAgent;
    created: boolean;
  };
  assert.equal(second.created, false, "a second click must not create a second manager");
  assert.equal(second.agent.id, first.agent.id);
});

test("POST /api/ask wakes the manager with the human's goal and resets the loop guard", async () => {
  const f = await fixture();
  await fetch(`${f.base}/api/manager/start`, browser(f, { method: "POST" }));
  await f.orchestrator.pauseManager("trip it");

  const res = await fetch(`${f.base}/api/ask`, browser(f, { method: "POST", body: JSON.stringify({ goal: "add a CHANGELOG" }) }));
  assert.equal(res.status, 200);
  await f.orchestrator.settle();

  const state = await f.orchestrator.state();
  assert.equal(state.managerPaused, false, "human input always overrides the pause");
  assert.match(f.turns.at(-1)?.prompt ?? "", /add a CHANGELOG/);
});

test("pause and resume flip managerPaused and emit events", async () => {
  const f = await fixture();
  await fetch(`${f.base}/api/manager/start`, browser(f, { method: "POST" }));

  await fetch(`${f.base}/api/manager/pause`, browser(f, { method: "POST" }));
  assert.equal((await f.orchestrator.state()).managerPaused, true);

  await fetch(`${f.base}/api/manager/resume`, browser(f, { method: "POST" }));
  assert.equal((await f.orchestrator.state()).managerPaused, false);

  const recent = await f.server.ctx.bus.readRecent(50);
  assert.ok(recent.some((e) => e.type === "manager.paused"));
});

test("POST /api/assignments creates and dispatches an assignment", async () => {
  const f = await fixture();
  const { agent } = (await (
    await fetch(`${f.base}/api/agents/spawn`, browser(f, { method: "POST", body: JSON.stringify({ profile: "coder-codex" }) }))
  ).json()) as { agent: CrewAgent };

  const res = await fetch(
    `${f.base}/api/assignments`,
    browser(f, {
      method: "POST",
      // isolate:false — this fixture has no git repo, and Crew must never quietly
      // substitute a different tree.
      body: JSON.stringify({ title: "write docs", instructions: "document the API", assignedTo: agent.id, isolate: false }),
    }),
  );
  assert.equal(res.status, 200);
  const { assignment } = (await res.json()) as { assignment: { id: string; status: string } };
  assert.equal(assignment.status, "queued");
  await f.orchestrator.settle();
  assert.equal(f.turns.at(-1)?.agent.id, agent.id, "it was dispatched, not just recorded");
});

test("control endpoints refuse to act on an OBSERVED session", async () => {
  const f = await fixture();
  const observed = await f.orchestrator.registerObservedAgent({ id: "obs1", name: "Warp session" });

  for (const path of [`/api/agents/${observed.id}/message`, `/api/agents/${observed.id}/cancel`, `/api/agents/${observed.id}/stop`]) {
    const res = await fetch(`${f.base}${path}`, browser(f, { method: "POST", body: JSON.stringify({ body: "hi" }) }));
    assert.equal(res.status, 409, `${path} must refuse`);
    assert.match((await res.json() as { error: string }).error, /observed/);
  }
});

test("GET /api/agents/:id returns the agent, its assignment and its recent output", async () => {
  const f = await fixture();
  const { agent } = (await (
    await fetch(`${f.base}/api/agents/spawn`, browser(f, { method: "POST", body: JSON.stringify({ profile: "coder-codex" }) }))
  ).json()) as { agent: CrewAgent };

  const res = await fetch(`${f.base}/api/agents/${agent.id}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { agent: CrewAgent; assignment: unknown; output: string[]; inbox: unknown[] };
  assert.equal(body.agent.id, agent.id);
  assert.equal(body.assignment, null);
  assert.ok(Array.isArray(body.output));

  assert.equal((await fetch(`${f.base}/api/agents/nope`)).status, 404);
});

// ---------------------------------------------------------------------------
// Agent RPC — the channel the spawned runtimes' MCP servers use
// ---------------------------------------------------------------------------

test("the agent RPC endpoint refuses a missing or wrong bearer token", async () => {
  const f = await fixture();
  for (const headers of [{}, { Authorization: "Bearer wrong" }]) {
    const res = await fetch(`${f.base}${AGENT_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ agentId: "x", tool: "crew_agents", args: {} }),
    });
    assert.equal(res.status, 401);
  }
});

test("the UI session cookie does NOT grant access to the agent RPC channel", async () => {
  const f = await fixture();
  const res = await fetch(`${f.base}${AGENT_RPC_PATH}`, browser(f, { method: "POST", body: JSON.stringify({ agentId: "x", tool: "crew_agents", args: {} }) }));
  assert.equal(res.status, 401, "a browser tab is a different principal from a runtime subprocess");
});

test("role boundaries are re-enforced on every RPC, not just at tool registration", async () => {
  const f = await fixture();
  const { agent: worker } = (await (
    await fetch(`${f.base}/api/agents/spawn`, browser(f, { method: "POST", body: JSON.stringify({ profile: "coder-codex" }) }))
  ).json()) as { agent: CrewAgent };

  const token = await tokenFor(f, worker.id);
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    fetch(`${f.base}${AGENT_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ agentId: worker.id, tool, args }),
    });

  const denied = await call("crew_spawn", { profile: "coder-codex" });
  assert.equal(denied.status, 400);
  assert.match(((await denied.json()) as { error: string }).error, /not available to a worker/);

  const allowed = await call("crew_inbox");
  assert.equal(allowed.status, 200);
  assert.equal(((await allowed.json()) as { ok: boolean }).ok, true);
});

test("an observed session cannot drive the crew through the RPC channel either", async () => {
  const f = await fixture();
  await f.orchestrator.registerObservedAgent({ id: "obs1", name: "Warp session" });
  const res = await fetch(`${f.base}${AGENT_RPC_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await tokenFor(f, "obs1")}` },
    body: JSON.stringify({ agentId: "obs1", tool: "crew_inbox", args: {} }),
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /observed session/);
});

// ---------------------------------------------------------------------------
// isolate:false is a HUMAN decision, never an agent's (defect 2)
// ---------------------------------------------------------------------------

/** A real git repo under the OS temp dir — never the user's own checkout. */
async function scratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crew-control-repo-"));
  await git(["init", "-b", "main"], dir);
  await git(["config", "user.email", "crew@test.local"], dir);
  await git(["config", "user.name", "Crew Test"], dir);
  await git(["config", "commit.gpgsign", "false"], dir);
  await writeFile(join(dir, "README.md"), "seed\n");
  await git(["add", "README.md"], dir);
  await git(["commit", "-m", "seed"], dir);
  return dir;
}

async function spawnAgent(f: Fixture, profile: string): Promise<CrewAgent> {
  const res = await fetch(`${f.base}/api/agents/spawn`, browser(f, { method: "POST", body: JSON.stringify({ profile }) }));
  assert.equal(res.status, 200);
  return ((await res.json()) as { agent: CrewAgent }).agent;
}

/** The channel a spawned runtime's MCP server uses — i.e. an AGENT-originated request. */
async function rpc(f: Fixture, agentId: string, tool: string, args: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${f.base}${AGENT_RPC_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await tokenFor(f, agentId)}` },
    body: JSON.stringify({ agentId, tool, args }),
  });
}

test("the manager CANNOT route a worker into the crew's real working tree with isolate:false", async () => {
  const repo = await scratchRepo();
  const f = await fixture({ workspaceRepoDir: repo });
  const manager = await spawnAgent(f, "manager-claude");
  const worker = await spawnAgent(f, "coder-codex");

  const res = await rpc(f, manager.id, "crew_assign", {
    to: worker.id,
    title: "edit the code",
    instructions: "just do it in the main checkout",
    isolate: false,
  });
  assert.equal(res.status, 400);
  const { error } = (await res.json()) as { error: string };
  assert.match(error, /isolate:false/, "the refusal names what was refused");
  assert.match(error, /human/i, "and says whose decision it is");
  assert.match(error, /commit or stash/i, "and what the agent can do instead of retrying");

  // Nothing was created behind the refusal — no queued assignment a later pump could
  // dispatch into the human's checkout.
  assert.deepEqual(Object.values((await f.orchestrator.state()).assignments), []);
  await f.orchestrator.settle();
  assert.equal(f.turns.length, 0, "and no worker turn ever started");

  const refusal = (await f.server.ctx.bus.readRecent(50)).find((e) => /isolate:false/.test(e.summary ?? ""));
  assert.ok(refusal, "the refusal is in the event feed, not silent");
});

test("a human CAN choose isolate:false from the Office for the same repo", async () => {
  const repo = await scratchRepo();
  const f = await fixture({ workspaceRepoDir: repo });
  const worker = await spawnAgent(f, "coder-codex");

  const res = await fetch(
    `${f.base}/api/assignments`,
    browser(f, {
      method: "POST",
      body: JSON.stringify({ title: "look around", instructions: "read the code", assignedTo: worker.id, isolate: false }),
    }),
  );
  assert.equal(res.status, 200, "the human is looking at that tree and may choose to work in it");
  await f.orchestrator.settle();
  assert.equal(f.turns.at(-1)?.cwd, repo);
});

test("a local process without the Office session cannot pose as the human", async () => {
  const repo = await scratchRepo();
  const f = await fixture({ workspaceRepoDir: repo });
  const worker = await spawnAgent(f, "coder-codex");

  // No Origin, no cookie, no key: a curl (or a spawned agent with a shell) hitting the control
  // API. It used to reach the Orchestrator and be refused there (400, "isolate:false"); the
  // boundary now refuses it a layer earlier, so it never reaches the assignment book at all.
  const res = await fetch(`${f.base}/api/assignments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "sneak in", instructions: "x", assignedTo: worker.id, isolate: false }),
  });
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { error: string }).error, /not proven to come from the human/);
  assert.equal(Object.keys((await f.orchestrator.state()).assignments).length, 0, "nothing may have been recorded");
});

test("a dirty repo refuses isolation loudly and tells the manager NOT to retry unisolated", async () => {
  const repo = await scratchRepo();
  await writeFile(join(repo, "README.md"), "the human is mid-edit\n");
  const f = await fixture({ workspaceRepoDir: repo });
  const manager = await spawnAgent(f, "manager-claude");
  const worker = await spawnAgent(f, "coder-codex");

  const dirty = await rpc(f, manager.id, "crew_assign", { to: worker.id, title: "fix", instructions: "fix it" });
  assert.equal(dirty.status, 400);
  const error = ((await dirty.json()) as { error: string }).error;
  assert.match(error, /uncommitted changes/);
  assert.match(error, /README\.md/);
  assert.match(error, /isolate:false/i, "the dirty-repo error itself closes the retry-unisolated door");

  // The refused isolation must not leave a queued assignment that a later pump would run in
  // the human's own checkout — that is the same hazard by another route.
  const assignments = Object.values((await f.orchestrator.state()).assignments);
  assert.ok(
    assignments.every((a) => a.status === "cancelled"),
    "a refused isolation leaves nothing dispatchable behind",
  );
  await f.orchestrator.settle();
  assert.equal(f.turns.length, 0);
});

test("POST /api/manager/start restarts a failed manager in place instead of reporting a phantom", async () => {
  const f = await fixture();
  const first = (await (await fetch(`${f.base}/api/manager/start`, browser(f, { method: "POST" }))).json()) as {
    agent: CrewAgent;
  };
  await f.orchestrator.state();
  await f.server.ctx.store.withState((state) => {
    state.agents[first.agent.id].status = "failed"; // what a rate-limited turn leaves behind
  });

  const res = await fetch(`${f.base}/api/manager/start`, browser(f, { method: "POST" }));
  const body = (await res.json()) as { agent: CrewAgent; created: boolean; restarted: boolean };
  assert.equal(body.created, false, "still no second manager");
  assert.equal(body.restarted, true);
  assert.equal(body.agent.status, "idle", "the failed manager is usable again, not a dead end");
});

test("the role env var name the MCP server reads is the one the runner sets", () => {
  // Cheap guard against the two halves drifting apart: protocol.ts owns the name.
  assert.equal(ENV_AGENT_ROLE, "DOCKET_CREW_AGENT_ROLE");
});

// ---------------------------------------------------------------------------
// The CLI as a client of the endpoints above
// ---------------------------------------------------------------------------

/** Collect the orchestration commands without touching cli.ts's module-level singleton. */
function commandTable(): Map<string, CrewCommand> {
  const table = new Map<string, CrewCommand>();
  const registry: CommandRegistry = {
    register: (name, _description, handler) => void table.set(name, handler),
    list: () => [...table.keys()].map((name) => ({ name, description: "" })),
  };
  registerCrewCommands(registry);
  return table;
}

/** Point the CLI's `daemonBaseUrl` at this fixture by writing the daemon record it reads. */
async function pointCliAt(f: Fixture): Promise<void> {
  await writeFile(
    f.paths.daemonFile,
    JSON.stringify({ pid: process.pid, port: Number(new URL(f.base).port), startedAt: new Date().toISOString() }),
    "utf8",
  );
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { code: await fn(), lines };
  } finally {
    console.log = original;
  }
}

/**
 * The regression this exists for: `ask` read a `target` field off the /api/ask response that
 * the route never sent, so the `?? manager.name` fallback fired every time and the CLI told
 * the human their instruction had gone to the MANAGER when it had gone to a worker. The route
 * has always been tested (addressing.test.ts); its one CLI reader was not, which is exactly
 * where the two halves drifted. `AskResponse` now types both ends, and this pins the print.
 */
test('`ask @worker` names the WORKER it reached, not the manager', async () => {
  const f = await fixture();
  await pointCliAt(f);
  const worker = await f.orchestrator.spawnAgent("coder-codex", { name: "backend" });

  const ask = commandTable().get("ask");
  assert.ok(ask, "the orchestration layer must register `ask`");
  const { code, lines } = await captureStdout(() => ask({ args: ["@backend", "ship", "it"], paths: f.paths }));

  assert.equal(code, 0);
  const sent = lines.find((l) => l.startsWith("goal sent to "));
  assert.ok(sent, `no delivery line printed; got: ${JSON.stringify(lines)}`);
  assert.match(sent, /^goal sent to backend /, `the CLI must name the real recipient, printed: ${sent}`);

  // And it really was delivered there, not merely printed there.
  const state = await f.orchestrator.state();
  assert.ok(
    state.messages.some((m) => m.to === worker.id && m.body === "ship it"),
    "the worker's mailbox must hold the instruction the CLI claimed it delivered",
  );
  await f.orchestrator.settle();
});

test("`ask` with no target names the manager it started", async () => {
  const f = await fixture();
  await pointCliAt(f);

  const ask = commandTable().get("ask");
  assert.ok(ask);
  const { code, lines } = await captureStdout(() => ask({ args: ["add", "a", "CHANGELOG"], paths: f.paths }));

  assert.equal(code, 0);
  const state = await f.orchestrator.state();
  const manager = Object.values(state.agents).find((a) => a.role === "manager");
  assert.ok(manager, "`ask` must start a manager on demand");
  assert.ok(
    lines.some((l) => l.startsWith(`goal sent to ${manager.name} `)),
    `expected the manager's name in the delivery line; got: ${JSON.stringify(lines)}`,
  );
  await f.orchestrator.settle();
});

// ---------------------------------------------------------------------------
// Defect 1 + 3 — the human-origination boundary
// ---------------------------------------------------------------------------

/** Everything `Set-Cookie` handed back, joined — the exploit's first step was scraping this. */
function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().join("; ");
}

test("GET / does NOT hand the UI session cookie to a caller that cannot present the UI key", async () => {
  /**
   * THE EXPLOIT, step one. `GET /` answered every caller with
   * `Set-Cookie: docket_crew_ui=<token>`, with no authentication of any kind — and
   * `ctx.hasUiSession(req)` is what the daemon then used to decide "is a human behind this".
   * Any local process that can spell `curl` could mint the human's capability for itself.
   */
  const f = await fixture();
  const res = await fetch(`${f.base}/`);
  assert.equal(res.status, 200);
  const cookie = cookieHeader(res);
  assert.ok(
    !cookie.includes(f.server.ctx.uiSessionToken),
    `GET / must not hand out the UI session token; it answered with ${JSON.stringify(cookie)}`,
  );
});

test("a cookie scraped from an unauthenticated GET / cannot put a worker in the human's checkout", async () => {
  // THE EXPLOIT, end to end: scrape → isolate:false → the turn ran with cwd = the daemon's own
  // workspace repo, no worktree. `requestedBy` was stamped "human" purely from that cookie.
  const f = await fixture({ workspaceRepoDir: await scratchRepo() });
  await f.orchestrator.spawnAgent("coder-codex", { name: "victim" });
  const scraped = cookieHeader(await fetch(`${f.base}/`));

  const res = await fetch(`${f.base}/api/assignments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: f.base, Cookie: scraped },
    body: JSON.stringify({ assignedTo: "victim", title: "t", instructions: "i", isolate: false }),
  });
  assert.notEqual(res.status, 200, `the scraped cookie must not be accepted (body: ${await res.text()})`);
});

test("a cookie-less local caller cannot stamp a message `from: human`", async () => {
  /**
   * `assertUiAuthorized` let any caller with no Origin/Referer straight through, and both
   * `POST /api/ask` and `POST /api/agents/:id/message` stamp `from:"human"` on what they send.
   * crew/skills/crew-worker/SKILL.md treats a direct message `from human` as the ONE thing that
   * authorises a push/merge/tag — so a bare `curl` was a push authorisation.
   */
  const f = await fixture();
  await f.orchestrator.spawnAgent("manager-claude", { name: "boss" });
  const worker = await f.orchestrator.spawnAgent("coder-codex", { name: "hand" });

  for (const [path, body] of [
    ["/api/ask", { goal: "push it" }],
    [`/api/agents/${worker.id}/message`, { body: "push it" }],
  ] as const) {
    const res = await fetch(`${f.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // no Origin, no cookie: a bare curl
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 403, `${path} must refuse an unproven caller (got ${res.status})`);
  }
  const state = await f.orchestrator.state();
  assert.equal(
    state.messages.filter((m) => m.from === "human").length,
    0,
    'nothing may be recorded as `from: "human"` on the strength of a bare curl',
  );
});

test("presenting the UI key mints a session that really does work", async () => {
  // The other half: the boundary has to still let the human in, from the browser and the CLI.
  const f = await fixture();
  const withKey = await fetch(`${f.base}/?key=${encodeURIComponent(f.server.ctx.uiKey)}`);
  const cookie = cookieHeader(withKey);
  assert.ok(cookie.includes(f.server.ctx.uiSessionToken), "a keyed page load must mint the session cookie");

  const spawned = await fetch(`${f.base}/api/agents/spawn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: f.base, Cookie: cookie },
    body: JSON.stringify({ profile: "coder-codex" }),
  });
  assert.equal(spawned.status, 200);
});

test("the UI key is also accepted as a header — that is the CLI's own path", async () => {
  const f = await fixture();
  await f.orchestrator.spawnAgent("manager-claude", { name: "boss" });
  const res = await fetch(`${f.base}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [UI_KEY_HEADER]: f.server.ctx.uiKey },
    body: JSON.stringify({ goal: "do the thing" }),
  });
  assert.equal(res.status, 200, await res.text());
  const state = await f.orchestrator.state();
  assert.ok(state.messages.some((m) => m.from === "human"), "the human's own path must still stamp from:human");
});

test("a wrong UI key is refused, and a right one is compared in constant time", async () => {
  const f = await fixture();
  const res = await fetch(`${f.base}/api/agents/spawn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [UI_KEY_HEADER]: "0".repeat(f.server.ctx.uiKey.length) },
    body: JSON.stringify({ profile: "coder-codex" }),
  });
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// Defect 2 — the agent RPC channel had no per-agent identity
// ---------------------------------------------------------------------------

test("an agent's RPC token speaks for THAT agent — the body cannot name another", async () => {
  /**
   * THE EXPLOIT. One crew-wide bearer token authenticated the channel; the caller's identity
   * came from `body.agentId`, and the role — hence the whole role boundary — was derived from
   * it. Demonstrated: the worker's own id got `crew_spawn` refused; the SAME token with the
   * manager's id in the body answered `{"ok":true,"Spawned…"}`.
   */
  const f = await fixture();
  const manager = await spawnAgent(f, "manager-claude");
  const worker = await spawnAgent(f, "coder-codex");
  const workerToken = await tokenFor(f, worker.id);

  const impersonation = await fetch(`${f.base}${AGENT_RPC_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${workerToken}` },
    body: JSON.stringify({ agentId: manager.id, tool: "crew_spawn", args: { profile: "coder-codex" } }),
  });
  const refusal = await impersonation.text();
  assert.equal(impersonation.status, 403, refusal);
  assert.match(refusal, /speaks for/);

  // …and omitting `agentId` entirely does not turn the worker into a manager either: the
  // credential is the identity, so the role gate still answers "you are a worker".
  const anonymous = await fetch(`${f.base}${AGENT_RPC_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${workerToken}` },
    body: JSON.stringify({ tool: "crew_spawn", args: { profile: "coder-codex" } }),
  });
  assert.equal(anonymous.status, 400);
  assert.match(((await anonymous.json()) as { error: string }).error, /not available to a worker/);

  const state = await f.orchestrator.state();
  assert.equal(Object.keys(state.agents).length, 2, "no third agent may have been spawned");
});

test("every tool a manager owns is refused to a worker's token, not just crew_spawn", async () => {
  const f = await fixture();
  const manager = await spawnAgent(f, "manager-claude");
  const worker = await spawnAgent(f, "coder-codex");
  const workerToken = await tokenFor(f, worker.id);

  for (const tool of ["crew_assign", "crew_cancel", "crew_rename", "crew_send", "crew_request_review"]) {
    const res = await fetch(`${f.base}${AGENT_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${workerToken}` },
      body: JSON.stringify({ agentId: manager.id, tool, args: {} }),
    });
    assert.equal(res.status, 403, `${tool} must not be reachable with another agent's token`);
  }
});

test("a released token stops working the moment the turn that owned it ends", async () => {
  // A lease lives for one turn (createTurnRunner releases it in a `finally`), so a runtime that
  // leaks its MCP server past the turn cannot keep calling in with a credential nobody revoked.
  const f = await fixture();
  const worker = await spawnAgent(f, "coder-codex");
  const lease = await f.agentTokens.lease(worker.id);
  const before = await fetch(`${f.base}${AGENT_RPC_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${lease.token}` },
    body: JSON.stringify({ tool: "crew_inbox", args: {} }),
  });
  assert.equal(before.status, 200);

  await lease.release();
  const after = await fetch(`${f.base}${AGENT_RPC_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${lease.token}` },
    body: JSON.stringify({ tool: "crew_inbox", args: {} }),
  });
  assert.equal(after.status, 401);
});

test("the per-agent token file is 0600 and is written THROUGH a planted symlink, not into it", async () => {
  /**
   * Defect 6. `writeFile(agentTokenFile, …, {mode:0o600})` opens 'w', which FOLLOWS symlinks:
   * an agent that pointed `agent-token` at any file the user can write had that file truncated
   * and chmod'ed 0600 by the next daemon start. atomicWriteFile creates a temp file and renames
   * over the NAME, which replaces the link.
   */
  const root = await mkdtemp(join(tmpdir(), "crew-token-symlink-"));
  const dir = join(root, "agent-tokens");
  await mkdir(dir, { recursive: true });
  const victim = join(root, "precious.txt");
  await writeFile(victim, "the user's own file\n");
  await symlink(victim, join(dir, "a1.token"));

  const registry = new AgentTokenRegistry(dir);
  const lease = await registry.lease("a1");
  assert.equal(await readFile(victim, "utf8"), "the user's own file\n", "the symlink target must be untouched");
  assert.equal((await lstat(lease.file)).isSymbolicLink(), false, "the link must have been replaced by a real file");
  assert.equal((await stat(lease.file)).mode & 0o777, 0o600);
  await lease.release();
});

// ---------------------------------------------------------------------------
// The Office page goes through the same door (defect 1, the real mount)
// ---------------------------------------------------------------------------

test("the Office page mints a session only for a load that presents the UI key", async () => {
  const f = await fixture({ office: true });

  const anonymous = await fetch(`${f.base}/office`);
  assert.equal(anonymous.status, 200, "the page itself is not secret — the capability is");
  assert.ok(
    !cookieHeader(anonymous).includes(f.server.ctx.uiSessionToken),
    "an unkeyed Office load must not carry the capability",
  );

  const keyed = await fetch(`${f.base}/office?key=${encodeURIComponent(f.server.ctx.uiKey)}`);
  assert.ok(cookieHeader(keyed).includes(f.server.ctx.uiSessionToken), "the keyed load must mint the session");

  // …and the page's own JS module is still served either way, so the UI renders and can tell
  // the human why it cannot act, instead of failing blank.
  assert.equal((await fetch(`${f.base}/office/app.js`)).status, 200);
});
