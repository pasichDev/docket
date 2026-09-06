import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { atomicWriteFile } from "./paths.js";
import { DEFAULT_CREW_PORT, type Assignment, type CrewAgent, type CrewMessage, type CrewState } from "./types.js";

/**
 * Single-writer, atomic store for state.json (spec §31).
 *
 * One StateStore instance per daemon is the writer; everything mutates through
 * `withState()`, which serializes mutators on an internal queue so two concurrent updates
 * can never interleave read-modify-write and lose each other. Every committed change hits
 * disk via temp-file + fsync + rename before the in-memory copy advances, so a reader of
 * state.json sees either the previous state or the complete new one — never a torn write.
 */

export function freshState(workspace: string, port: number = DEFAULT_CREW_PORT): CrewState {
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    workspace,
    port,
    agents: {},
    assignments: {},
    messages: [],
    autonomousTurns: 0,
    managerPaused: false,
  };
}

/** The one schema this build understands. A bump here must come with a migration. */
export const CREW_STATE_VERSION = 1;

function isCrewState(value: unknown): value is CrewState {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    s.version === CREW_STATE_VERSION &&
    typeof s.startedAt === "string" &&
    typeof s.workspace === "string" &&
    typeof s.port === "number" &&
    typeof s.agents === "object" && s.agents !== null &&
    typeof s.assignments === "object" && s.assignments !== null &&
    Array.isArray(s.messages)
  );
}

/**
 * What was set aside when state.json could not be adopted, and roughly what that cost.
 *
 * This exists because quarantine used to be SILENT. The daemon booted looking brand new —
 * every agent, assignment, message and nativeSessionId gone, `crew/*` branches and worktrees
 * still on disk with nothing left to say what produced them — and the only trace was a file
 * nobody would ever look at. `reason` distinguishes the cases that used to be indistinguishable:
 * a torn file is a crash, an unsupported `version` is a downgrade, and they need different
 * responses from a human.
 */
export interface StateQuarantine {
  /** Where the unusable file was moved to. */
  file: string;
  reason: string;
  bytes: number;
  /** Counts of what was in the file, when it parsed well enough to count. */
  lost: { agents: number; assignments: number; messages: number } | null;
}

function describeMismatch(parsed: unknown): { reason: string; lost: StateQuarantine["lost"] } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { reason: "state.json did not contain a JSON object", lost: null };
  }
  const s = parsed as Record<string, unknown>;
  const lost = {
    agents: typeof s.agents === "object" && s.agents !== null ? Object.keys(s.agents).length : 0,
    assignments: typeof s.assignments === "object" && s.assignments !== null ? Object.keys(s.assignments).length : 0,
    messages: Array.isArray(s.messages) ? s.messages.length : 0,
  };
  if (s.version !== CREW_STATE_VERSION) {
    return {
      reason:
        typeof s.version === "number"
          ? `state.json is schema version ${s.version}; this build understands ${CREW_STATE_VERSION} (downgrade?)`
          : `state.json has no usable schema version`,
      lost,
    };
  }
  return { reason: "state.json is missing required fields", lost };
}

export class StateStore {
  private state: CrewState | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private quarantined: StateQuarantine | null = null;
  /** Next serialized size that earns a warning; doubles each time (see warnIfOversized). */
  private warnAtBytes = 8 * 1024 * 1024;

  constructor(
    private readonly file: string,
    private readonly makeFresh: () => CrewState,
  ) {}

  /**
   * Current state (loaded/recovered on first use).
   *
   * Returns a COPY. It used to hand back the live object, so a "reader" that mutated what it
   * got — however innocently — had its change adopted by the next withState() and fsynced to
   * disk, with no mutator anywhere in the stack. Nothing exploited that, and no test could
   * have caught it (the FakeStore in testsupport clones); it was a loaded gun, and this is
   * the safety.
   */
  async getState(): Promise<CrewState> {
    return this.enqueue(async () => {
      if (!this.state) this.state = await this.load();
      return structuredClone(this.state);
    });
  }

  /**
   * Set when the state file on disk had to be set aside. Non-null means real loss: the daemon
   * is running on a fresh state and somebody must be told (cli.ts reports it into
   * `crew.started` and onto stderr).
   */
  get quarantine(): StateQuarantine | null {
    return this.quarantined;
  }

  /**
   * Serialized read-modify-write. The mutator receives a deep copy; only when it returns
   * without throwing is the copy persisted and adopted, so a half-applied mutation can
   * neither reach disk nor poison the in-memory state.
   */
  async withState<T>(mutator: (state: CrewState) => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (!this.state) this.state = await this.load();
      const draft = structuredClone(this.state);
      const result = await mutator(draft);
      const serialized = JSON.stringify(draft, null, 2) + "\n";
      this.warnIfOversized(serialized.length, draft);
      await atomicWriteFile(this.file, serialized);
      this.state = draft;
      return result;
    });
  }

  /**
   * The real bound on state.json, made visible instead of assumed away.
   *
   * Every mutation rewrites this file WHOLE and fsyncs it, and `messages[]` is a ledger that
   * is never pruned — so the cost of a turn grows with the length of the conversation
   * (quadratic over a session). The supervisor already throttles `lastSeenAt` to 5 s to
   * survive it. Nothing here prunes, deliberately: `state.messages` is the authoritative copy
   * of every message body and the Office renders the whole conversation from it, so dropping
   * old entries would silently delete the user's chat history — a worse failure than a big
   * file. Trimming it for real means moving the ledger out of state.json (a schema change,
   * and types.ts is frozen). Until then: say so, loudly, once per doubling.
   */
  private warnIfOversized(bytes: number, state: CrewState): void {
    if (bytes < this.warnAtBytes) return;
    console.error(
      `crew: ${this.file} is ${(bytes / 1_048_576).toFixed(1)} MB (${state.messages.length} messages, ` +
        `${Object.keys(state.assignments).length} assignments) and is rewritten + fsynced on EVERY mutation. ` +
        `Turns will get slower as it grows; start a fresh crew home, or archive this one, before it hurts.`,
    );
    this.warnAtBytes = bytes * 2;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    // Keep the chain alive whether or not the task failed; the caller still sees the rejection.
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Missing file → fresh state (first run). Corrupt file → set it aside as
   * state.json.corrupt-<ts>-<rand> and start fresh: a daemon that refuses to boot over a torn
   * file helps nobody, but silently overwriting the evidence would hide a real bug — and
   * silently *starting over* hides an even bigger one, so the loss is recorded in
   * `quarantine`, shouted on stderr, and surfaced by the caller.
   */
  private async load(): Promise<CrewState> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return this.makeFresh();
      throw err;
    }
    let reason = "state.json is not parseable JSON (torn write?)";
    let lost: StateQuarantine["lost"] = null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isCrewState(parsed)) return parsed;
      ({ reason, lost } = describeMismatch(parsed));
    } catch {
      // fall through to quarantine with the "unparseable" reason
    }
    // Date.now() alone collides for two quarantines inside one millisecond, which is exactly
    // what a restart loop produces — and a collision would overwrite the earlier evidence.
    const quarantine = `${this.file}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await rename(this.file, quarantine).catch(() => {});
    this.quarantined = { file: quarantine, reason, bytes: Buffer.byteLength(text, "utf8"), lost };
    console.error(
      `crew: ${reason} — moved it to ${quarantine} and started from an EMPTY state. ` +
        (lost
          ? `Lost from the daemon's view: ${lost.agents} agent(s), ${lost.assignments} assignment(s), ${lost.messages} message(s). `
          : "") +
        `Any crew/* branches and worktrees on disk now have no record of what produced them.`,
    );
    return this.makeFresh();
  }
}

export interface InterruptionReport {
  /** Agents whose in-flight run was cut off by the daemon dying. */
  interruptedAgents: string[];
  /** Assignments that were running and are now failed. */
  interruptedAssignments: string[];
  /** Message ids un-delivered because the turn that drained them never happened (see below). */
  restoredMessages: string[];
}

/**
 * Daemon-restart recovery (spec §46): anything that was mid-run when the previous daemon
 * died is marked failed — NEVER successful. Applied inside a withState() mutator so it
 * commits atomically with the rest of startup.
 *
 * Managed agents lose their pid/runId (the child is gone or orphaned — the supervisor's
 * process-group sweep deals with orphans); their nativeSessionId is deliberately KEPT, so
 * the manager can decide to resume the conversation. Observed agents are merely marked
 * stopped: Crew never controlled them and cannot judge what happened.
 */
export function recoverInterruptedRuns(state: CrewState, note = "interrupted: crew daemon restarted mid-run"): InterruptionReport {
  const report: InterruptionReport = { interruptedAgents: [], interruptedAssignments: [], restoredMessages: [] };
  const now = new Date().toISOString();
  for (const agent of Object.values(state.agents) as CrewAgent[]) {
    const wasRunning = agent.status === "working" || agent.status === "starting" || agent.currentRunId !== undefined;
    if (!wasRunning) continue;
    agent.status = agent.origin === "managed" ? "failed" : "stopped";
    agent.lastSeenAt = now;
    delete agent.pid;
    delete agent.currentRunId;
    report.interruptedAgents.push(agent.id);
  }
  for (const assignment of Object.values(state.assignments) as Assignment[]) {
    if (assignment.status !== "running") continue;
    assignment.status = "failed";
    assignment.finishedAt = now;
    // Keep any partial result fields, but the summary states the interruption: whatever a
    // partial result claimed, an interrupted run is not a success.
    assignment.result = { ...(assignment.result ?? {}), summary: note };
    report.interruptedAssignments.push(assignment.id);
  }
  for (const agentId of report.interruptedAgents) {
    for (const message of restoreLastDrainedBatch(state, agentId)) report.restoredMessages.push(message.id);
  }
  return report;
}

/**
 * Un-deliver the mail the interrupted turn had already drained (spec §22, and the third time
 * this bug class has been fixed).
 *
 * mailbox.drain() marks messages read at the START of a turn, before the runtime has seen a
 * token; runAgentTurn puts them back when that turn fails, but only IN-PROCESS. A daemon that
 * dies mid-turn therefore left a worker's result marked delivered to a manager that never read
 * it: no event, no retry, no trace — finished work silently destroyed. Recovery marks the turn
 * interrupted, so it must undo the delivery the same way a failed turn does.
 *
 * "What that turn drained" is identifiable without a new field (types.ts is frozen): drain()
 * stamps one batch with a single `readAt`, so the newest readAt among an agent's messages IS
 * the last batch handed to it — and for an agent that was mid-run, that batch is the one its
 * dead turn was holding. The cost of being wrong (the interrupted turn drained nothing, so
 * the newest batch belonged to an earlier, completed turn) is that the recipient reads a
 * message twice. The cost of NOT doing it is a result nobody ever sees. Given this project's
 * rule — never fail silently — a duplicate delivery is the correct side to err on, and the
 * restored ids are reported so it is visible either way.
 */
function restoreLastDrainedBatch(state: CrewState, agentId: string): CrewMessage[] {
  const read = state.messages.filter((m) => m.to === agentId && m.readAt);
  if (read.length === 0) return [];
  const newest = read.reduce((max, m) => (m.readAt! > max ? m.readAt! : max), read[0].readAt!);
  const batch = read.filter((m) => m.readAt === newest);
  for (const message of batch) delete message.readAt;
  return batch;
}
