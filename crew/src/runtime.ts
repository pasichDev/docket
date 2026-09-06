/**
 * Where the logical crew meets the real processes.
 *
 * orchestrator.ts decides WHAT should happen ("run one turn of this agent with this
 * prompt"); adapters/* know HOW a given CLI is invoked; supervisor.ts owns the child
 * process. This file is the only place that knows all three exist:
 *
 *   - it builds the real TurnRunner (adapter registry + supervisor, never a raw spawn);
 *   - it hands every runtime the Crew MCP server, scoped (adapters/mcp.ts);
 *   - it registers the Office control endpoints and the agent RPC endpoint on the daemon's
 *     existing router;
 *   - it provides the CLI's orchestration commands, which are thin HTTP clients of those
 *     same endpoints — so the CLI and the Office UI drive exactly one implementation.
 */

import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapters, useMcpServersEverywhere, type McpServerSpec } from "./adapters/index.js";
import { AgentToolError, callAgentTool } from "./agent-tools.js";
import { AgentTokenRegistry, agentTokensDir } from "./agent-tokens.js";
import type { CommandRegistry, CrewCommand } from "./cli.js";
import { loadConfig } from "./config.js";
import type { DeliveryMode } from "./mailbox.js";
import { resolveWorkspace } from "./discovery.js";
import { findDocketDist } from "./docket.js";
import type { EventBus } from "./events.js";
import {
  AGENT_RPC_PATH,
  ENV_AGENT_ID,
  ENV_AGENT_NAME,
  ENV_AGENT_ROLE,
  ENV_BASE_URL,
  ENV_TOKEN_FILE,
} from "./mcp/protocol.js";
import { AgentNameError, describeMatches, resolveAgentRef } from "./naming.js";
import { CrewOwnedSessions, ObservedSessions } from "./observed-sessions.js";
import { officePageHandler, registerOfficeRoutes } from "./office/index.js";
import {
  AgentNotFoundError,
  AmbiguousAgentError,
  findManager,
  ObservedAgentError,
  Orchestrator,
  StoppedAgentError,
  type TurnOutcome,
  type TurnRequest,
} from "./orchestrator.js";
import { atomicWriteFile, type CrewPaths } from "./paths.js";
import { json, UI_KEY_HEADER, type CrewRouteHandler, type CrewServer, type CrewServerContext } from "./server.js";
import type { StateStore } from "./state.js";
import type { Supervisor } from "./supervisor.js";
import { DEFAULT_CREW_PORT, type CrewAgent, type CrewConfig, type CrewEvent, type CrewMessage } from "./types.js";

// ---------------------------------------------------------------------------
// The Crew MCP server spec handed to every runtime
// ---------------------------------------------------------------------------

/** Absolute path to the built MCP server entry point (dist/mcp/server.js next to this file). */
export function crewMcpServerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "mcp", "server.js");
}

/**
 * The servers a spawned agent gets: Crew itself, plus Docket Core when its build is
 * findable — a worker is told to claim its Docket task, so it needs the todo_* tools, and
 * with claude's `--strict-mcp-config` it would otherwise have none.
 */
export async function buildMcpServerSpecs(): Promise<McpServerSpec[]> {
  const specs: McpServerSpec[] = [
    { name: "crew", command: process.execPath, args: [crewMcpServerPath()] },
  ];
  try {
    specs.push({ name: "docket", command: process.execPath, args: [join(await findDocketDist(), "index.js")] });
  } catch {
    // Docket Core isn't built here. The crew still works; workers just cannot touch todos,
    // which is visible in `doctor` rather than a mysterious missing tool.
  }
  return specs;
}

// ---------------------------------------------------------------------------
// The real TurnRunner
// ---------------------------------------------------------------------------

export interface TurnRunnerDeps {
  supervisor: Supervisor;
  baseUrl: () => string;
  /** Mints the caller's own per-agent RPC token for the duration of the turn. */
  tokens: AgentTokenRegistry;
}

export function createTurnRunner(deps: TurnRunnerDeps) {
  return async function runTurn(request: TurnRequest): Promise<TurnOutcome> {
    const { agent, runId, prompt, cwd } = request;
    if (!agent.runtime) return { ok: false, resultText: "", error: `agent ${agent.name} has no runtime` };
    const adapter = adapters[agent.runtime];
    if (!adapter) return { ok: false, resultText: "", error: `no adapter for runtime ${agent.runtime}` };

    /**
     * ONE TOKEN, THIS AGENT, THIS TURN (agent-tokens.ts). It used to be one crew-wide token
     * for every agent, with the caller's identity taken from the RPC request BODY — so any
     * agent could act as any other simply by putting a different id in its JSON.
     */
    const lease = await deps.tokens.lease(agent.id);
    try {
      /**
       * This environment is what the runtime must hand to the MCP server it spawns. The
       * secret travels as a FILE PATH, not a value: codex needs each variable spelled out on
       * its own command line (`-c mcp_servers.crew.env.X=…`), and a bearer token in argv is
       * readable by every process of the same user.
       */
      const env: Record<string, string> = {
        [ENV_BASE_URL]: deps.baseUrl(),
        [ENV_TOKEN_FILE]: lease.file,
        [ENV_AGENT_ID]: agent.id,
        [ENV_AGENT_NAME]: agent.name,
        [ENV_AGENT_ROLE]: agent.role ?? "worker",
      };

      const outcome = await deps.supervisor.runTurn(
        adapter,
        agent.id,
        {
          runId,
          prompt,
          cwd,
          model: agent.model,
          provider: agent.provider,
          env,
        },
        // Resume the agent's own logical session so it keeps context across wakes (spec §18).
        agent.nativeSessionId,
        // The orchestrator owns status transitions and lifecycle events — see Supervisor.runTurn.
        { publishLifecycle: false },
      );

      /**
       * VERIFIED: a codex resume's `turn.completed` can carry EMPTY result text while the work
       * really happened (tool/file_change events and the worktree diff are the ground truth).
       * So an empty resultText is never, on its own, a failure — only an explicit error or a
       * cancellation is.
       */
      return {
        ok: outcome.ok,
        cancelled: outcome.cancelled,
        resultText: outcome.resultText ?? "",
        error: outcome.errorMessage,
        nativeSessionId: outcome.nativeSessionId,
      };
    } finally {
      // The turn is over, so the credential is too: a lingering MCP child cannot call back in.
      await lease.release();
    }
  };
}

// ---------------------------------------------------------------------------
// Per-agent output ring buffers (Office [Open] view)
// ---------------------------------------------------------------------------

const OUTPUT_LINES_PER_AGENT = 200;

/**
 * Total characters of full text kept per agent. The ring holds whole replies now, not
 * 200-character stubs, so the entry count alone is no longer a memory bound: 200 × 8000
 * would be 1.6 MB per agent, replayed in one JSON response every time a panel opens.
 * Oldest entries are dropped until the buffer fits, so a chatty agent costs a bounded
 * amount of RAM and the most recent turn always survives whole.
 */
const OUTPUT_CHARS_PER_AGENT = 256_000;

/**
 * One remembered line of agent-visible output.
 *
 * `summary` is the compact one-liner (what the Team Feed and the thought bubbles render);
 * `text` is the SAME output with its structure intact — newlines, markdown, indentation —
 * which is what a human actually reads. `kind` separates an agent's own prose ("text",
 * "result") from the mechanics around it ("status", "tool"). See supervisor.ts.
 */
export interface AgentOutputEntry {
  /** ISO timestamp of the originating event. */
  at: string;
  kind: string;
  summary: string;
  text: string;
  /** Set when supervisor.ts had to clip the text at OUTPUT_TEXT_MAX. */
  truncated?: true;
  runId?: string;
}

export class OutputBuffers {
  private readonly entries = new Map<string, AgentOutputEntry[]>();

  push(agentId: string, entry: AgentOutputEntry): void {
    const existing = this.entries.get(agentId) ?? [];
    existing.push(entry);
    if (existing.length > OUTPUT_LINES_PER_AGENT) existing.splice(0, existing.length - OUTPUT_LINES_PER_AGENT);
    let chars = existing.reduce((n, e) => n + e.text.length, 0);
    while (existing.length > 1 && chars > OUTPUT_CHARS_PER_AGENT) {
      chars -= existing[0].text.length;
      existing.shift();
    }
    this.entries.set(agentId, existing);
  }

  /**
   * Feed straight from the event bus — the ring is a projection of agent.output events and
   * never a second source of truth. Anything else on the bus is ignored.
   */
  pushEvent(event: CrewEvent): void {
    if (event.type !== "agent.output" || !event.agentId) return;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const summary = typeof event.summary === "string" ? event.summary : "";
    const text = typeof data.text === "string" ? data.text : summary;
    if (!summary && !text) return;
    this.push(event.agentId, {
      at: event.at,
      kind: typeof data.kind === "string" ? data.kind : "text",
      summary,
      text,
      ...(data.truncated === true ? { truncated: true as const } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
    });
  }

  /**
   * The legacy `"<ISO> <summary>"` lines, unchanged — GET /api/agents/:id still returns
   * these as `output` and the Office parses them (office/client/render.ts parseOutputLine).
   * Full text lives in list() / the `outputEntries` field beside it.
   */
  get(agentId: string): string[] {
    return (this.entries.get(agentId) ?? []).map((e) => `${e.at} ${e.summary}`);
  }

  /** The same buffer at full fidelity. */
  list(agentId: string): AgentOutputEntry[] {
    return this.entries.get(agentId) ?? [];
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing shared by the control + RPC routes
// ---------------------------------------------------------------------------

const BODY_LIMIT = 512 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `"${key}" is required`);
  return value.trim();
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Is a HUMAN behind this control request, as opposed to any local process that can reach
 * loopback?
 *
 * THREE ways to qualify, and they are all the same secret:
 *
 *   1. the Office page's per-process UI session cookie — which is now only minted for a page
 *      load that itself presented the UI key (server.ts, UI_KEY_HEADER);
 *   2. the UI key directly, as `X-Crew-UI-Key` — the CLI's own path, since the CLI has no
 *      browser and no cookie jar.
 *
 * WHAT THIS GUARANTEES: nothing that only has what Crew hands a spawned agent — the daemon's
 * URL and its own RPC token — can qualify. The capability is no longer obtainable by asking
 * the daemon for it.
 *
 * WHAT IT DOES NOT GUARANTEE: that a human is really there. The key lives in a 0600 file in a
 * 0700 crew home, and Crew's adversary runs as the same uid with a shell. It can read that
 * file, exactly as the CLI does. "Only a human can do X" cannot be made true here without OS
 * sandboxing Crew does not have — see docs/OPERATIONS.md. This raises the bar; it does not
 * close the hole.
 */
export function isHumanOriginated(req: IncomingMessage, ctx: CrewServerContext, url?: URL): boolean {
  return ctx.hasUiSession(req) || ctx.hasUiKey(req, url);
}

/**
 * The headless opt-in, and DELIBERATELY not part of isHumanOriginated.
 *
 * `DOCKET_CREW_ALLOW_UNISOLATED=1` says one specific thing — "I accept workers running in this
 * checkout" — and it is read from the DAEMON's environment, so it is on for every request the
 * daemon ever sees. Folding it into the general boundary would turn a narrow "yes, no worktree"
 * into a blanket authentication bypass for `/api/ask`, `/api/agents/:id/message` and everything
 * else, for the whole life of the daemon. It stays scoped to the decision it was written for.
 */
function allowsUnisolatedByOptIn(): boolean {
  const optIn = process.env.DOCKET_CREW_ALLOW_UNISOLATED?.trim();
  return optIn === "1" || optIn === "true";
}

/**
 * The guard on EVERY mutating control route.
 *
 * It used to be `assertUiAuthorized`, which required the UI session cookie only from browser
 * requests and let a caller with no Origin/Referer through untouched — "that is the CLI's own
 * path". Two demonstrated consequences: `GET /` handed the cookie to anyone who asked, so the
 * browser half was free too; and a bare `curl` could POST to `/api/ask` and
 * `/api/agents/:id/message`, both of which stamp `from: "human"` on what they send — the exact
 * string crew/skills/crew-worker/SKILL.md treats as authorisation to push, merge or tag.
 *
 * There is now ONE bar, and the CLI clears it the same way a browser does (by presenting the
 * UI key), rather than by being exempt from it.
 */
function assertHumanOriginated(req: IncomingMessage, ctx: CrewServerContext, url?: URL): void {
  if (isHumanOriginated(req, ctx, url)) return;
  throw new HttpError(
    403,
    "crew: this request is not proven to come from the human. Open the Office with the URL " +
      "`docket-crew start` printed (it carries ?key=…), or send the X-Crew-UI-Key header — " +
      "the CLI does this for you.",
  );
}

/** `<crew home>/ui-key` — 0600, and never sent over HTTP. See server.ts UI_KEY_HEADER. */
export function uiKeyFile(paths: CrewPaths): string {
  return join(paths.root, "ui-key");
}

/** The key the running daemon will accept, for the CLI's own requests. Empty when unreadable. */
export async function readUiKey(paths: CrewPaths): Promise<string> {
  try {
    return (await readFile(uiKeyFile(paths), "utf8")).trim();
  } catch {
    return "";
  }
}

/**
 * Mount the Office UI behind the human-origination boundary.
 *
 * The Office's own page handler sets the `docket_crew_ui` cookie unconditionally — which is
 * correct for the page a human loaded, and was the whole of defect 1 for everybody else. The
 * gate goes in FRONT of it rather than inside it, so the rule lives in one place and applies
 * to any future route that would hand the capability out:
 *
 *   - proven human (UI key, or an existing valid session) → fall through; the Office page sets
 *     the real cookie exactly as before;
 *   - anyone else → the SAME page, served with a cookie value that authorizes nothing. There is
 *     nothing secret on the page; what it must not carry is the capability. Mutations then
 *     answer 403 with the sentence that says how to get in.
 */
export function registerGatedOfficeRoutes(server: CrewServer): void {
  const gate: CrewRouteHandler = (req, res, url, ctx) => {
    if (ctx.hasUiKey(req, url) || ctx.hasUiSession(req)) return false;
    return officePageHandler(req, res, url, { ...ctx, uiSessionToken: "" });
  };
  for (const path of ["/", "/office", "/office/"]) server.router.register("GET", path, gate);
  registerOfficeRoutes(server.router);
}

/**
 * The `:id` segment of `/api/agents/:id/<action>`. Called a REF rather than an id since
 * renaming shipped: every one of these routes now accepts a display name too, so the Office
 * can act on the agent the human just clicked (or typed) without holding an id.
 */
function agentRefFromPath(pathname: string): string {
  const match = /^\/api\/agents\/([^/]+)\//.exec(pathname);
  return match ? decodeURIComponent(match[1]) : "";
}

// ---------------------------------------------------------------------------
// Wiring it all onto the daemon
// ---------------------------------------------------------------------------

export interface AttachInput {
  server: CrewServer;
  store: StateStore;
  bus: EventBus;
  supervisor: Supervisor;
  config: CrewConfig;
  paths: CrewPaths;
}

export interface CrewRuntime {
  orchestrator: Orchestrator;
  /** Per-agent RPC credentials. Exposed so shutdown can revoke every one of them. */
  agentTokens: AgentTokenRegistry;
  mcpServers: McpServerSpec[];
  /** The §17 discovery loop. Exposed so `stop` and tests can shut it down deterministically. */
  observed: ObservedSessions;
}

let attached: CrewRuntime | null = null;

/** Exposed for tests and for the CLI's in-process paths. Null until attachToDaemon runs. */
export function currentRuntime(): CrewRuntime | null {
  return attached;
}

export async function attachToDaemon(input: AttachInput): Promise<CrewRuntime> {
  const { server, store, bus, supervisor, config, paths } = input;
  const workspace = await resolveWorkspace(process.cwd());

  /**
   * Per-agent RPC credentials, minted per turn (agent-tokens.ts). The single crew-wide
   * `agent-token` file this replaces is removed on the way past: it was written with
   * `writeFile(…, 'w')`, which follows symlinks, and it outlived `stop` — a stale 0600
   * secret-shaped file, and the symlink target of a planted one.
   */
  const agentTokens = new AgentTokenRegistry(agentTokensDir(paths.root));
  await agentTokens.revokeAll();
  await rm(join(paths.root, "agent-token"), { force: true }).catch(() => {});

  /**
   * The UI key on disk, 0600 inside the 0700 crew root — see server.ts UI_KEY_HEADER for what
   * it does and does not buy. atomicWriteFile rather than writeFile for the same
   * symlink-following reason as above.
   */
  await atomicWriteFile(uiKeyFile(paths), server.ctx.uiKey + "\n", 0o600);

  const outputs = new OutputBuffers();

  const baseUrl = () => `http://127.0.0.1:${server.port() || Number(process.env.DOCKET_CREW_PORT ?? DEFAULT_CREW_PORT)}`;

  const orchestrator = new Orchestrator({
    store,
    bus,
    config,
    runTurn: createTurnRunner({ supervisor, baseUrl, tokens: agentTokens }),
    cancelRun: async (runId) => {
      await supervisor.cancelRun(runId);
    },
    workspaceDir: workspace.root ?? process.cwd(),
    // Only a git checkout is guarded against agent-chosen non-isolated runs; resolveWorkspace
    // falls back to plain cwd, and Orchestrator.assign checks the git-ness itself.
    workspaceRepoDir: workspace.root ?? undefined,
    skillsDir: join(paths.root, "skills"),
  });

  // Recent per-agent output for the Office [Open] view, fed from the same events the SSE
  // stream carries — no second source of truth.
  bus.subscribe((event) => outputs.pushEvent(event));

  const mcpServers = await buildMcpServerSpecs();
  const registration = useMcpServersEverywhere(mcpServers);
  await bus.publish("crew.started", {
    summary: `crew MCP server registered with ${registration.configured.join(", ")}`,
    data: {
      mcpServers: mcpServers.map((s) => s.name),
      configuredRuntimes: registration.configured,
      unsupportedRuntimes: registration.unsupported,
    },
  });

  /**
   * Observed-session discovery (spec §17). Started here rather than inside the Orchestrator
   * because it is a DAEMON concern — it needs this process's pid to tell Crew's own runtime
   * children apart from the human's sessions, and the crew root to recognise worktree runs.
   *
   * The first pass runs now so the Office has the window populated before anyone loads the
   * page; it is awaited only far enough to not race the page, and its failures are events,
   * never a boot failure — a Crew that refuses to start because Docket Core isn't built would
   * be trading the whole product for a decoration.
   */
  const observed = new ObservedSessions({
    orchestrator,
    owned: new CrewOwnedSessions({ rootPid: process.pid, worktreesDir: paths.worktreesDir }),
    intervalMs: observeIntervalMs(),
    onError: (err) => {
      void bus.publish("agent.failed", { summary: `crew: observed-session discovery failed: ${err.message}` }).catch(() => {});
    },
  });
  await observed.tick().catch(() => {});
  observed.start();

  registerCrewRoutes({ server, orchestrator, config, agentTokens, outputs, workspaceRepoDir: workspace.root ?? undefined });

  /**
   * Mount the Office UI LAST, because its `GET /` claims the root: routes are consulted in
   * registration order, so the API routes above always win over the page. It adds no API
   * and no second security model — it is served through the same loopback/Host/same-origin
   * guards and issues the same `docket_crew_ui` cookie the control routes check.
   */
  registerGatedOfficeRoutes(server);

  attached = { orchestrator, agentTokens, mcpServers, observed };

  /**
   * Pick up what the previous daemon left behind (spec §46).
   *
   * Boot used to start NOTHING but the observed-session loop above: a `queued` assignment and a
   * manager inbox full of finished results sat there for as long as the daemon ran, while the
   * Office showed a crew that was "about to start". Boot is simply another moment at which work
   * becomes runnable, so it sweeps the queue and — only if the manager actually has unread mail —
   * wakes it, through the ordinary guard. LAST, and deliberately not awaited: it starts real
   * turns, and every route, the Office and `currentRuntime()` must already be in place before
   * one of them calls back in.
   */
  void orchestrator.resumeAfterBoot().catch((err: unknown) => {
    void bus
      .publish("agent.failed", { summary: `crew: resuming after restart failed: ${(err as Error).message}` })
      .catch(() => {});
  });

  return attached;
}

/**
 * `DOCKET_CREW_OBSERVE_INTERVAL_MS` overrides the discovery cadence; `0` disables the loop
 * entirely (the startup pass still runs, so state is correct — it just stops refreshing).
 * There for a user who does not want a background pgrep every few seconds, and for smoke runs
 * that want to drive `tick()` by hand.
 */
function observeIntervalMs(): number | undefined {
  const raw = process.env.DOCKET_CREW_OBSERVE_INTERVAL_MS?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed === 0 ? 0 : Math.max(parsed, 250);
}

/**
 * The `POST /api/ask` response body, shared by the route below and the `ask` CLI command that
 * prints it. Declared once because the two DID drift: the CLI read a `target` field the route
 * never sent, so `ask @worker` reported the goal as delivered to the manager. A typed contract
 * makes that a compile error rather than a confident lie to the human.
 */
export interface AskResponse {
  ok: true;
  direct: boolean;
  /** ALWAYS present on a 200: who actually received this, not who the caller asked for. */
  deliveredTo: { id: string; name: string; role: string };
  message: CrewMessage;
  delivery: DeliveryMode;
  managerNotified: boolean;
}

export interface RouteDeps {
  server: CrewServer;
  orchestrator: Orchestrator;
  config: CrewConfig;
  /** Server-side token→agentId bindings for the agent RPC channel (agent-tokens.ts). */
  agentTokens: AgentTokenRegistry;
  outputs: OutputBuffers;
  workspaceRepoDir?: string;
}

/** Exported so tests can mount the control surface without a whole daemon. */
export function registerCrewRoutes(deps: RouteDeps): void {
  const { server, orchestrator, config, agentTokens, outputs, workspaceRepoDir } = deps;
  const router = server.router;

  /** Wrap a handler so thrown HttpError/AgentToolError become clean JSON, not a 500. */
  const handler =
    (fn: (req: IncomingMessage, res: ServerResponse, url: URL, ctx: CrewServerContext) => Promise<void>) =>
    async (req: IncomingMessage, res: ServerResponse, url: URL, ctx: CrewServerContext): Promise<void> => {
      try {
        await fn(req, res, url, ctx);
      } catch (err) {
        if (err instanceof HttpError) return json(res, err.status, { error: err.message });
        if (err instanceof AgentToolError) return json(res, 400, { error: err.message });
        /**
         * Addressing failures get their own statuses so a caller (the Office, the CLI) can
         * tell "you typed a name nobody has" (404) from "that agent exists but Crew may not
         * drive it" (409) from "your JSON was wrong" (400) — the same three answers every
         * other control route gives, rather than one undifferentiated 400.
         */
        if (err instanceof AgentNotFoundError) return json(res, 404, { error: err.message });
        if (err instanceof AmbiguousAgentError || err instanceof ObservedAgentError || err instanceof StoppedAgentError) {
          return json(res, 409, { error: err.message });
        }
        if (err instanceof AgentNameError) return json(res, err.status, { error: err.message });
        json(res, 400, { error: (err as Error).message });
      }
    };

  // ------------------------------------------------------------ agent RPC
  // Bearer-token only, and deliberately NOT behind the UI session: this is the runtime
  // subprocess channel, a different principal from the browser (spec §43).
  router.register(
    "POST",
    AGENT_RPC_PATH,
    handler(async (req, res) => {
      /**
       * THE CALLER IS THE CREDENTIAL, not the payload.
       *
       * There used to be one crew-wide token; the identity came from `body.agentId`, and the
       * role — the whole role boundary — was derived from that. Demonstrated: a worker's token
       * plus the MANAGER's id in the body returned `{"ok":true,"Spawned…"}`. `body.agentId` is
       * no longer an identity source; it is only cross-checked, so a mismatch is a loud 403
       * rather than a quiet success (agent-tokens.ts).
       */
      const auth = req.headers.authorization ?? "";
      const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
      const agentId = presented ? agentTokens.agentFor(presented) : undefined;
      if (!agentId) throw new HttpError(401, "crew: bad or missing agent token");
      const body = await readJsonBody(req);
      const claimed = typeof body.agentId === "string" ? body.agentId.trim() : "";
      if (claimed && claimed !== agentId) {
        throw new HttpError(403, `crew: this token speaks for ${agentId}, not ${claimed} — you cannot act as another agent`);
      }
      const tool = requireString(body, "tool");
      const args = (body.args ?? {}) as Record<string, unknown>;
      if (typeof args !== "object" || args === null || Array.isArray(args)) throw new HttpError(400, '"args" must be an object');
      const result = await callAgentTool({ orchestrator, workspaceRepoDir }, agentId, tool, args);
      json(res, 200, result);
    }),
  );

  // ------------------------------------------------------------- profiles
  router.register(
    "GET",
    "/api/profiles",
    handler(async (_req, res) => {
      json(res, 200, { profiles: Object.values(config.profiles), manager: config.manager.profile });
    }),
  );

  /**
   * ------------------------------------------------------------------ ask
   *
   * `POST /api/ask { goal, to? }` — the human's one way in.
   *
   *   - no `to`            → the manager, byte-for-byte the behaviour this endpoint has
   *                          always had (spec §24: reset the loop guard, lift the pause,
   *                          wake it with the goal). The Office's existing call is unchanged.
   *   - `to` = id or NAME  → that specific agent ("@backend do X"), case- and
   *                          whitespace-insensitive. Naming `to` the manager is the same as
   *                          omitting it, so the guard reset is not lost by being explicit.
   *
   * Unknown name → 404, ambiguous → 409, observed session → 409 (spec §17). Delivery to a
   * worker follows the one mailbox rule; the manager is told either way. See
   * Orchestrator.directMessage for both.
   */
  router.register(
    "POST",
    "/api/ask",
    handler(async (req, res, url, ctx) => {
      assertHumanOriginated(req, ctx, url);
      const body = await readJsonBody(req);
      const goal = requireString(body, "goal");
      const to = typeof body.to === "string" ? body.to.trim() : "";

      /**
       * An unresolvable `to` is an ERROR, never a silent fallback to the manager. Accepting
       * it and answering 200 would turn "you, bro, do this" into a lie the caller cannot
       * detect: the human deliberately bypassed the manager and would be told it worked while
       * the manager got the message. Misrouting silently is worse than not supporting `to`.
       */
      if (to) {
        const target = await requireAddressableAgent(orchestrator, to);
        if (target.role !== "manager") {
          const result = await orchestrator.directMessage(target.id, goal);
          return json(res, 200, {
            ok: true,
            direct: true,
            deliveredTo: { id: result.target.id, name: result.target.name, role: result.target.role ?? "worker" },
            message: result.outcome.message,
            delivery: result.outcome.delivery,
            managerNotified: result.managerNotified,
          } satisfies AskResponse);
        }
        // `to` named the MANAGER: that is the manager path, not a fallback — falling through
        // keeps the §24 guard reset that being explicit must not cost you.
      }

      // Human input always overrides the loop guard and resets the counter (spec §24).
      const outcome = await orchestrator.humanInput(goal);
      const manager = (await orchestrator.listAgents()).find((a) => a.id === outcome.message.to);
      json(res, 200, {
        ok: true,
        direct: false,
        deliveredTo: manager
          ? { id: manager.id, name: manager.name, role: manager.role ?? "manager" }
          : { id: outcome.message.to, name: outcome.message.to, role: "manager" },
        message: outcome.message,
        delivery: outcome.delivery,
        managerNotified: true,
      } satisfies AskResponse);
    }),
  );

  /**
   * Rename a managed agent. This is what makes every `to:"backend"` above work — the human
   * names an agent for the job it owns, and from then on addresses it by that name.
   */
  router.register(
    "POST",
    /^\/api\/agents\/[^/]+\/rename$/,
    handler(async (req, res, url, ctx) => {
      assertHumanOriginated(req, ctx, url);
      const ref = agentRefFromPath(url.pathname);
      // requireManagedAgent answers the §17 refusal (409) before any name is validated.
      const existing = await requireManagedAgent(orchestrator, ref);
      const name = requireString(await readJsonBody(req), "name");
      const agent = await orchestrator.renameAgent(existing.id, name);
      json(res, 200, { agent, previousName: existing.name });
    }),
  );

  // --------------------------------------------------------------- agents
  router.register(
    "POST",
    "/api/agents/spawn",
    handler(async (req, res, url, ctx) => {
      assertHumanOriginated(req, ctx, url);
      const body = await readJsonBody(req);
      const profile = requireString(body, "profile");
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
      const agent = await orchestrator.spawnAgent(profile, { name });
      json(res, 200, { agent });
    }),
  );

  /**
   * Convenience for the Office's "start the crew" button: idempotently ensure a manager
   * exists. Returns the existing one rather than spawning a second — two managers would
   * both be woken by every worker result.
   */
  router.register(
    "POST",
    "/api/manager/start",
    handler(async (req, res, url, ctx) => {
      assertHumanOriginated(req, ctx, url);
      // The shared predicate (orchestrator.findManager), which counts a manager whose last
      // turn failed — the same agent this route then restarts in place, just below.
      const existing = findManager(await orchestrator.state());
      if (existing) {
        /**
         * A manager whose last turn failed used to be returned as-is: "created:false" with an
         * agent nothing could wake, so the button reported success and the crew stayed stuck
         * until the user stopped the agent by hand. Restart it in place instead.
         */
        const restarted = await orchestrator.restartFailedAgent(existing.id);
        const agent = restarted ? (await orchestrator.state()).agents[existing.id] : existing;
        return json(res, 200, { agent, created: false, restarted });
      }
      const agent = await orchestrator.spawnAgent(config.manager.profile);
      json(res, 200, { agent, created: true });
    }),
  );

  router.register(
    "GET",
    /^\/api\/agents\/[^/]+$/,
    handler(async (_req, res, url) => {
      const ref = decodeURIComponent(url.pathname.slice("/api/agents/".length));
      const state = await orchestrator.state();
      // Names resolve here too, so the Office can deep-link an agent the human named.
      // Observed sessions ARE readable — §17 forbids driving them, not looking at them.
      const found = resolveAgentRef(state.agents, ref);
      if (!found.ok) {
        if (found.problem === "ambiguous") {
          throw new HttpError(409, `"${ref}" matches ${found.matches.length} agents (${describeMatches(found.matches)}) — use the id`);
        }
        throw new HttpError(404, `no agent ${ref}`);
      }
      const agent = found.agent;
      const id = agent.id;
      const assignment = agent.currentAssignmentId ? state.assignments[agent.currentAssignmentId] : null;
      json(res, 200, {
        agent,
        assignment,
        // `output` is the legacy compact form (kept so nothing that reads it breaks);
        // `outputEntries` is the same buffer with the agent's real, unflattened text.
        output: outputs.get(id),
        outputEntries: outputs.list(id),
        inbox: state.messages.filter((m) => m.to === id && !m.readAt),
        worktree: agent.currentAssignmentId ? (orchestrator.worktreeFor(agent.currentAssignmentId) ?? null) : null,
      });
    }),
  );

  router.register(
    "POST",
    /^\/api\/agents\/[^/]+\/message$/,
    handler(async (req, res, url, ctx) => {
      assertHumanOriginated(req, ctx, url);
      const ref = agentRefFromPath(url.pathname);
      const agent = await requireAddressableAgent(orchestrator, ref);
      const body = requireString(await readJsonBody(req), "body");

      /**
       * A human message to a WORKER through this endpoint is the same act as `/api/ask` with
       * `to` — the Office's per-agent box and its "@name" line must not differ in what the
       * crew learns from them. So it goes through the one implementation: same mailbox rule,
       * same `goal.created` event, and the same system note telling the manager its picture
       * just changed. Two human→agent paths with different manager visibility is exactly the
       * second delivery path this design exists to avoid.
       *
       * A message to the MANAGER stays on the plain mailbox path: there is nobody to notify,
       * and this endpoint has never been the thing that resets the §24 loop guard — `/api/ask`
       * is. Changing that here would move a guard rule into a side door.
       */
      if (agent.role !== "manager") {
        const result = await orchestrator.directMessage(agent.id, body);
        return json(res, 200, {
          ok: true,
          deliveredTo: { id: result.target.id, name: result.target.name, role: result.target.role ?? "worker" },
          message: result.outcome.message,
          delivery: result.outcome.delivery,
          managerNotified: result.managerNotified,
        });
      }

      const state = await orchestrator.state();
      const outcome = await orchestrator.mailbox.send({
        from: "human",
        to: agent.id,
        workspace: state.workspace,
        kind: "message",
        body,
      });
      json(res, 200, {
        ok: true,
        deliveredTo: { id: agent.id, name: agent.name, role: "manager" },
        message: outcome.message,
        delivery: outcome.delivery,
        managerNotified: true,
      });
    }),
  );

  router.register(
    "POST",
    /^\/api\/agents\/[^/]+\/cancel$/,
    handler(async (req, res, url, ctx) => {
      assertHumanOriginated(req, ctx, url);
      const ref = agentRefFromPath(url.pathname);
      const agent = await requireManagedAgent(orchestrator, ref);
      const cancelled = await orchestrator.cancelAgentRun(agent.id);
      json(res, 200, { ok: true, cancelled });
    }),
  );

  router.register(
    "POST",
    /^\/api\/agents\/[^/]+\/stop$/,
    handler(async (req, res, url, ctx) => {
      assertHumanOriginated(req, ctx, url);
      const ref = agentRefFromPath(url.pathname);
      const agent = await requireManagedAgent(orchestrator, ref);
      await orchestrator.stopAgent(agent.id);
      json(res, 200, { ok: true });
    }),
  );

  // ---------------------------------------------------------- assignments
  router.register(
    "POST",
    "/api/assignments",
    handler(async (req, res, url, ctx) => {
      assertHumanOriginated(req, ctx, url);
      const body = await readJsonBody(req);
      const to = requireString(body, "assignedTo");
      const target = await requireManagedAgent(orchestrator, to);
      const isolate = typeof body.isolate === "boolean" ? body.isolate : target.role === "worker";
      if (isolate && !workspaceRepoDir) {
        throw new HttpError(400, "isolate was requested but the crew is not running inside a git repository");
      }
      const assignment = await orchestrator.assign({
        to: target.id,
        title: requireString(body, "title"),
        instructions: requireString(body, "instructions"),
        assignedBy: "human",
        /**
         * Running WITHOUT a worktree edits the checkout the human is looking at, so it needs a
         * real human behind the request — not merely a local process (spec §43's trust levels).
         *
         * Kept as its OWN check even though assertHumanOriginated above already refused anyone
         * who cannot prove it: this is the property the Orchestrator enforces, and it must not
         * silently become "whatever the route happened to let through". The env opt-in is
         * consulted only here (see allowsUnisolatedByOptIn) — it authorises no-worktree runs for
         * a headless human, and nothing else.
         */
        requestedBy: isHumanOriginated(req, ctx, url) || allowsUnisolatedByOptIn() ? "human" : "agent",
        docketTodoId: typeof body.docketTodoId === "string" ? body.docketTodoId : undefined,
        isolate: isolate && workspaceRepoDir ? { repoDir: workspaceRepoDir } : undefined,
      });
      json(res, 200, { assignment });
    }),
  );

  // --------------------------------------------------------- manager loop
  router.register(
    "POST",
    "/api/manager/pause",
    handler(async (req, res, url, ctx) => {
      assertHumanOriginated(req, ctx, url);
      await orchestrator.pauseManager("paused by the human from the Office");
      json(res, 200, { ok: true, managerPaused: true });
    }),
  );

  router.register(
    "POST",
    "/api/manager/resume",
    handler(async (req, res, url, ctx) => {
      assertHumanOriginated(req, ctx, url);
      await orchestrator.resumeManager();
      json(res, 200, { ok: true, managerPaused: false });
    }),
  );
}

/**
 * Resolve an id OR a display name to a MANAGED agent, or answer with the right status.
 *
 * Accepting the name is what lets the Office (and the CLI) act on "backend" without carrying
 * an id around. Ambiguity is a 409 rather than a guess: picking one of two agents called
 * "backend" would deliver a human's instruction to the wrong process, silently.
 */
async function requireManagedAgent(orchestrator: Orchestrator, ref: string): Promise<CrewAgent> {
  const state = await orchestrator.state();
  const found = resolveAgentRef(state.agents, ref);
  if (!found.ok) {
    if (found.problem === "ambiguous") {
      throw new HttpError(
        409,
        `"${ref}" matches ${found.matches.length} agents (${describeMatches(found.matches)}) — address one by its id`,
      );
    }
    // Echo the name back: a caller that mistyped "@codxe" needs to see what Crew looked for.
    throw new HttpError(404, `no agent named "${ref}" — check the roster (GET /api/state) for ids and names`);
  }
  if (found.agent.origin === "observed") {
    throw new HttpError(
      409,
      `${found.agent.name} is an observed Docket session — Crew did not launch it and cannot message, rename, cancel or stop it (spec §17)`,
    );
  }
  return found.agent;
}

/** As above, plus "and it can actually take an instruction right now". */
async function requireAddressableAgent(orchestrator: Orchestrator, ref: string): Promise<CrewAgent> {
  const agent = await requireManagedAgent(orchestrator, ref);
  if (agent.status === "stopped") {
    throw new HttpError(409, `${agent.name} is stopped — start it (or address another agent) before sending it work`);
  }
  return agent;
}

// ---------------------------------------------------------------------------
// CLI commands (spec §34) — thin clients of the endpoints above
// ---------------------------------------------------------------------------

interface DaemonRecord {
  pid: number;
  port: number;
}

/**
 * An error caused by how the user invoked the CLI, not by a bug. cli.ts prints these as a
 * single line — a stack trace for "the daemon isn't running" is noise that hides the
 * sentence that actually tells them what to do.
 */
export class CrewUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrewUserError";
  }
}

async function daemonBaseUrl(paths: CrewPaths): Promise<string> {
  try {
    const record = JSON.parse(await readFile(paths.daemonFile, "utf8")) as DaemonRecord;
    if (typeof record.port === "number") return `http://127.0.0.1:${record.port}`;
  } catch {
    // fall through
  }
  throw new CrewUserError("crew daemon is not running — start it with `docket-crew start`");
}

async function api<T>(paths: CrewPaths, method: string, path: string, body?: unknown): Promise<T> {
  const base = await daemonBaseUrl(paths);
  /**
   * The CLI clears the SAME bar a browser does, rather than being exempt from it.
   *
   * It used to be exempt: `assertUiAuthorized` waved through anything with no Origin header,
   * which is what let a bare `curl` stamp `from: "human"`. The CLI reads the daemon's UI key
   * off disk (0600, in a 0700 crew home) and presents it — which is honestly no more than any
   * same-uid process could do, and is exactly why docs/OPERATIONS.md states the residual risk
   * rather than claiming this is a human-only path.
   */
  const uiKey = await readUiKey(paths);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(uiKey ? { [UI_KEY_HEADER]: uiKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`crew daemon returned a non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new CrewUserError((parsed as { error?: string }).error ?? `HTTP ${res.status}`);
  return parsed as T;
}

/**
 * `docket-crew ask "<goal>"`            → the manager, as always.
 * `docket-crew ask @backend "<goal>"`   → that agent directly, by name or id.
 *
 * The `@name` form is the CLI spelling of the Office's "@backend do X": the manager is still
 * started (it must exist to be told what the human did) but the instruction goes straight to
 * the named agent.
 */
const askCommand: CrewCommand = async ({ args, paths }) => {
  const rest = [...args];
  let to = "";
  if (rest[0]?.startsWith("@") && rest[0].length > 1) to = rest.shift()!.slice(1);
  else if (rest[0] === "--to" && rest[1]) {
    rest.shift();
    to = rest.shift()!;
  }
  const goal = rest.join(" ").trim();
  if (!goal) {
    console.error('usage: docket-crew ask "<goal>"   |   docket-crew ask @<agent> "<goal>"');
    return 2;
  }
  // Spawning the manager on demand is the whole point of `ask`: the user should not have to
  // know that a manager agent is a thing they must start first. Even a direct message needs
  // one, because the manager is told about it so its picture of the crew stays true.
  const { agent, created } = await api<{ agent: CrewAgent; created: boolean }>(paths, "POST", "/api/manager/start");
  if (created) console.log(`started manager ${agent.name} (${agent.id})`);
  const sent = await api<AskResponse>(paths, "POST", "/api/ask", to ? { goal, to } : { goal });
  const base = await daemonBaseUrl(paths);
  /**
   * Report who ACTUALLY received it, from the response's `deliveredTo` — never from the `to`
   * we asked for or from the manager we happen to have a name for. This printed the manager's
   * name for every `ask @worker` until the field name was corrected: the endpoint returns
   * `deliveredTo`, and reading a `target` that was never in the payload silently fell back to
   * the manager, telling the human their instruction went somewhere it did not.
   */
  const targetName = sent.deliveredTo?.name ?? agent.name;
  const how = sent.delivery === "woken" ? "it was idle and started a turn now" : "queued — it will read this at the start of its next turn";
  console.log(`goal sent to ${targetName} (${how}). Watch it work: ${base}/`);
  return 0;
};

const agentsCommand: CrewCommand = async ({ paths }) => {
  const { state } = await api<{ state: { agents: Record<string, CrewAgent> } }>(paths, "GET", "/api/state");
  const agents = Object.values(state.agents);
  if (agents.length === 0) {
    console.log("no agents — `docket-crew agent start <profile>` or `docket-crew ask \"...\"`");
    return 0;
  }
  for (const agent of agents) {
    const origin = agent.origin === "observed" ? "observed" : `${agent.runtime}/${agent.role}`;
    console.log(
      `${agent.id.padEnd(10)} ${agent.name.padEnd(22)} ${origin.padEnd(18)} ${agent.status}${
        agent.currentAssignmentId ? `  on ${agent.currentAssignmentId}` : ""
      }`,
    );
  }
  return 0;
};

const profilesCommand: CrewCommand = async ({ paths }) => {
  // Works with or without a daemon: profiles come from config.yml either way.
  try {
    const { profiles, manager } = await api<{ profiles: { name: string; runtime: string; role: string; model?: string }[]; manager: string }>(
      paths,
      "GET",
      "/api/profiles",
    );
    for (const p of profiles) console.log(`${p.name.padEnd(20)} ${p.runtime.padEnd(9)} ${p.role}${p.model ? `  ${p.model}` : ""}`);
    console.log(`\nmanager profile: ${manager}`);
  } catch {
    const config = await loadConfig(paths);
    for (const p of Object.values(config.profiles)) {
      console.log(`${p.name.padEnd(20)} ${p.runtime.padEnd(9)} ${p.role}${p.model ? `  ${p.model}` : ""}`);
    }
    console.log(`\nmanager profile: ${config.manager.profile}  (daemon not running — read from config.yml)`);
  }
  return 0;
};

const agentCommand: CrewCommand = async ({ args, paths }) => {
  const [sub, value] = args;
  if (sub === "start") {
    if (!value) {
      console.error("usage: docket-crew agent start <profile>");
      return 2;
    }
    const { agent } = await api<{ agent: CrewAgent }>(paths, "POST", "/api/agents/spawn", { profile: value });
    console.log(`started ${agent.name} (${agent.id}, ${agent.runtime}/${agent.role})`);
    return 0;
  }
  if (sub === "stop") {
    if (!value) {
      console.error("usage: docket-crew agent stop <id|name>");
      return 2;
    }
    await api(paths, "POST", `/api/agents/${encodeURIComponent(value)}/stop`);
    console.log(`stopped ${value}`);
    return 0;
  }
  if (sub === "rename") {
    const name = args.slice(2).join(" ").trim();
    if (!value || !name) {
      console.error('usage: docket-crew agent rename <id|name> "<new name>"');
      return 2;
    }
    const { agent, previousName } = await api<{ agent: CrewAgent; previousName: string }>(
      paths,
      "POST",
      `/api/agents/${encodeURIComponent(value)}/rename`,
      { name },
    );
    console.log(`renamed ${previousName} → ${agent.name} (${agent.id}) — address it with: docket-crew ask @${agent.name} "..."`);
    return 0;
  }
  console.error('usage: docket-crew agent start <profile> | agent stop <id|name> | agent rename <id|name> "<new name>"');
  return 2;
};

const officeCommand: CrewCommand = async ({ paths }) => {
  const base = await daemonBaseUrl(paths);
  const url = await officeUrl(paths, base);
  console.log(url);
  await openInBrowser(url);
  return 0;
};

/**
 * The Office URL that actually mints a session: the page only sets the `docket_crew_ui` cookie
 * for a load that presents the UI key, and a browser NAVIGATION cannot carry a header — so the
 * key rides in the query string, the way a local notebook server's token does.
 *
 * Without a readable key the bare URL is still printed: the page renders, and the human is told
 * by the first refused mutation rather than by a CLI that silently prints nothing.
 */
export async function officeUrl(paths: CrewPaths, base: string): Promise<string> {
  const key = await readUiKey(paths);
  return key ? `${base}/?key=${encodeURIComponent(key)}` : `${base}/`;
}

export function openInBrowser(url: string): Promise<void> {
  const opener =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  return new Promise((resolvePromise) => {
    execFile(opener[0] as string, opener[1] as string[], () => resolvePromise());
  });
}

export function registerCrewCommands(registry: CommandRegistry): void {
  registry.register(
    "ask",
    'give the manager a goal ("add a CHANGELOG"), or one agent directly: ask @backend "fix the login route"',
    askCommand,
  );
  registry.register("office", "print and open the Office UI URL", officeCommand);
  registry.register("agents", "list agents (managed and observed)", agentsCommand);
  registry.register("profiles", "list agent profiles from config.yml", profilesCommand);
  registry.register("agent", 'agent start <profile> | agent stop <id|name> | agent rename <id|name> "<new name>"', agentCommand);
}
