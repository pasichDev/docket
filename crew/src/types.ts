/**
 * Frozen shared contracts for Docket Crew.
 *
 * Every module in crew/ builds against this file. It is deliberately dependency-free so the
 * daemon, the adapters, the MCP server and the Office UI can all import it without pulling
 * anything else in. Runtime-specific knowledge (how `claude`/`codex`/`opencode` are actually
 * invoked and what they emit) belongs in crew/src/adapters/* and is documented, with real
 * observed output, in crew/docs/RUNTIME-CONTRACTS.md — nothing outside an adapter may know
 * those details (spec §6).
 */

// ---------------------------------------------------------------------------
// Runtimes
// ---------------------------------------------------------------------------

export type RuntimeId = "claude" | "codex" | "opencode";

export interface RuntimeDetection {
  id: RuntimeId;
  installed: boolean;
  /** Absolute path to the binary, when found on PATH. */
  executable?: string;
  /** Raw `--version` output, trimmed. Never parsed for feature decisions — see capabilities(). */
  version?: string;
  /** Why detection failed, for `docket crew doctor` output. */
  error?: string;
}

/**
 * What an installed runtime can actually do, probed from the real binary rather than assumed
 * from its version number (spec §5: "Do not silently assume specific CLI capabilities").
 */
export interface RuntimeCapabilities {
  nonInteractive: boolean;
  structuredOutput: boolean;
  /** Native conversation resume (claude --resume / codex exec resume / opencode -s). */
  resume: boolean;
  /** Runtime accepts an explicit working directory flag rather than inheriting cwd. */
  workingDirectoryFlag: boolean;
  modelSelection: boolean;
  /** Provider routing through the runtime (opencode: openrouter/ollama/...). */
  providerSelection: boolean;
}

// ---------------------------------------------------------------------------
// Agent events — the normalized stream every adapter yields (spec §38)
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "status"; status: string }
  | { type: "tool"; name: string; detail?: unknown }
  | { type: "result"; text: string }
  | { type: "error"; message: string }
  /**
   * Emitted once per turn as soon as the runtime reveals its own session identifier, so the
   * supervisor can persist it for resume without each caller knowing where in the stream it
   * appears (claude: every event; codex: thread.started; opencode: every event).
   */
  | { type: "session"; nativeSessionId: string };

export interface StartTurnInput {
  runId: string;
  prompt: string;
  cwd: string;
  /** Adapter-specific model identifier, passed through opaquely (spec §10). */
  model?: string;
  /** opencode only: provider portion when not already encoded in `model`. */
  provider?: string;
  /** Extra environment for the child process. Never used to pass provider credentials (spec §44). */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ResumeTurnInput extends StartTurnInput {
  /** The runtime's own session id, as previously surfaced by an AgentEvent{type:"session"}. */
  nativeSessionId: string;
}

/** Spec §6. Runtime-specific command construction stays inside implementations of this. */
export interface AgentRuntimeAdapter {
  id: RuntimeId;
  detect(): Promise<RuntimeDetection>;
  capabilities(): Promise<RuntimeCapabilities>;
  startTurn(input: StartTurnInput): AsyncIterable<AgentEvent>;
  resumeTurn(input: ResumeTurnInput): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Profiles (spec §10)
// ---------------------------------------------------------------------------

export type CrewRole = "manager" | "worker" | "reviewer";

export interface CrewProfile {
  name: string;
  runtime: RuntimeId;
  role: CrewRole;
  model?: string;
  provider?: string;
  skills?: string[];
}

export interface CrewConfig {
  manager: { profile: string };
  profiles: Record<string, CrewProfile>;
  automation: {
    managerAutoWake: boolean;
    maxAutonomousTurns: number;
    maxAgents: number;
    maxConcurrentRuns: number;
    /** Automatic retries of a failed assignment before the manager must decide (spec §45). */
    maxRetries: number;
    /**
     * How long a turn may emit NO output at all before the supervisor kills it, in
     * milliseconds. A SILENCE budget, not a wall-clock cap: a turn streaming text and tool
     * calls is alive however long it has run, and capping total time is the surest way to
     * throw away a legitimate multi-minute assignment. 0 disables the watchdog.
     *
     * Optional because this contract is shared and every other field predates it — omitted, it
     * falls back to supervisor.ts's DEFAULT_TURN_IDLE_TIMEOUT_MS, which is where the choice of
     * default and the reasoning behind it live.
     */
    turnIdleTimeoutMs?: number;
  };
}

// ---------------------------------------------------------------------------
// Agents (spec §17/§18)
// ---------------------------------------------------------------------------

export type AgentStatus = "starting" | "idle" | "working" | "failed" | "stopped";

/**
 * MANAGED = Crew spawned it and may prompt/cancel/resume it.
 * OBSERVED = a passive Docket MCP session Crew did not launch; Crew must never assume it can
 * control it (spec §17).
 */
export type AgentOrigin = "managed" | "observed";

export interface CrewAgent {
  id: string;
  /** Display name, e.g. "Codex #1". */
  name: string;
  origin: AgentOrigin;
  profile?: string;
  runtime?: RuntimeId;
  role?: CrewRole;
  model?: string;
  provider?: string;
  status: AgentStatus;
  workspace?: string;
  cwd?: string;
  /** Native runtime session id, persisted so turns can resume across processes (spec §46). */
  nativeSessionId?: string;
  /**
   * The same session ids, KEYED BY THE DIRECTORY THEY WERE CREATED IN.
   *
   * `nativeSessionId` alone is a per-agent pin, and an agent legitimately moves between trees
   * (its own worktree per assignment). `codex exec resume` takes its cwd from the spawn cwd and
   * filters resumable sessions by that cwd (docs/RUNTIME-CONTRACTS.md), so resuming a session in
   * a directory it was not created in either fails to find it or runs the turn in the wrong
   * tree. Keying by cwd makes that unrepresentable instead of relying on an unpin step that
   * something else could undo.
   */
  sessions?: Record<string, string>;
  currentAssignmentId?: string;
  currentRunId?: string;
  pid?: number;
  startedAt?: string;
  lastSeenAt?: string;
}

// ---------------------------------------------------------------------------
// Assignments (spec §25)
// ---------------------------------------------------------------------------

export type AssignmentStatus =
  | "queued"
  | "running"
  | "waiting"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

/**
 * The isolated checkout an assignment owns (spec §27/§29).
 *
 * Declared here, on the frozen contract, because it is PERSISTED ON THE ASSIGNMENT: it used to
 * live only in an orchestrator Map, so a daemon restart lost the record of where the work is —
 * the branch survived on disk and nothing could say its name any more.
 */
export interface AssignmentWorktree {
  /** The originating repository (main checkout). */
  repoDir: string;
  assignmentId: string;
  branch: string;
  /** The isolated checkout the worker runs in. */
  path: string;
  /** Commit the branch was created from — the diff base for collectResult. */
  baseCommit: string;
}

export interface AssignmentResult {
  summary: string;
  /** Worktree branch the work landed on, when the assignment was isolated (spec §27/§29). */
  branch?: string;
  worktree?: string;
  diffStat?: string;
  commit?: string;
  tests?: string;
  exitCode?: number;
  stderrSummary?: string;
}

export interface Assignment {
  id: string;
  /** Docket remains the canonical task store — this is a reference, not a copy (spec §26). */
  docketTodoId?: string;
  title: string;
  instructions: string;
  workspace: string;
  assignedBy: string;
  assignedTo: string;
  status: AssignmentStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  /**
   * Times a REVIEWER sent this back for rework. Counted apart from `attempts` because a
   * rejection is not a failure: folding the two together spent the automatic-retry budget
   * (spec §45) before the first genuine failure ever happened.
   */
  reworks?: number;
  /** Where this assignment's work happens, when it was isolated. Persisted; see AssignmentWorktree. */
  worktree?: AssignmentWorktree;
  /**
   * Set ONLY when a human deliberately chose to run this assignment without isolation, in the
   * crew's own workspace repository. It is the single authorisation that lets a worker turn
   * start in the human's checkout (see Orchestrator.resolveTurnCwd); an agent cannot produce it,
   * because `requestedBy` is structural — the crew_assign path hard-codes "agent".
   */
  nonIsolatedApprovedBy?: "human";
  result?: AssignmentResult;
}

// ---------------------------------------------------------------------------
// Mailbox (spec §21/§22)
// ---------------------------------------------------------------------------

export type CrewMessageKind =
  | "message"
  | "assignment"
  | "result"
  | "review-request"
  | "help-request"
  | "system";

export interface CrewMessage {
  id: string;
  from: string;
  to: string;
  workspace: string;
  kind: CrewMessageKind;
  body: string;
  createdAt: string;
  readAt?: string;
}

// ---------------------------------------------------------------------------
// Events (spec §32) — appended to events.jsonl and streamed to Office over SSE
// ---------------------------------------------------------------------------

export type CrewEventType =
  | "crew.started"
  | "crew.stopped"
  | "goal.created"
  | "agent.spawned"
  | "agent.started"
  | "agent.output"
  | "agent.idle"
  | "agent.failed"
  | "agent.stopped"
  | "assignment.created"
  | "assignment.started"
  | "assignment.completed"
  | "assignment.failed"
  | "message.sent"
  | "message.delivered"
  | "manager.woken"
  | "manager.paused"
  | "review.requested"
  | "review.completed";

export interface CrewEvent {
  id: string;
  type: CrewEventType;
  at: string;
  agentId?: string;
  assignmentId?: string;
  runId?: string;
  /** Human-readable one-liner for the Team Feed (spec §39). */
  summary?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Daemon state (spec §31) — single-writer, atomic writes
// ---------------------------------------------------------------------------

export interface CrewState {
  version: 1;
  startedAt: string;
  workspace: string;
  /** Loopback bind only for MVP (spec §33/§43). */
  port: number;
  agents: Record<string, CrewAgent>;
  assignments: Record<string, Assignment>;
  messages: CrewMessage[];
  /** Consecutive autonomous manager turns, reset by human input (spec §24). */
  autonomousTurns: number;
  managerPaused: boolean;
}

export const DEFAULT_CREW_PORT = 8790;
