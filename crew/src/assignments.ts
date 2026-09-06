import { randomUUID } from "node:crypto";
import type {
  Assignment,
  AssignmentResult,
  AssignmentStatus,
  CrewEvent,
  CrewEventType,
  CrewState,
} from "./types.js";

/**
 * Assignment lifecycle (spec §21/§25/§45).
 *
 * The transition table and retry accounting live here as pure functions, so the state
 * machine is testable without a daemon. `AssignmentBook` is the stateful wrapper every
 * caller (orchestrator, MCP tools, Office routes) goes through; it mutates only via the
 * injected state store, so the daemon's single-writer discipline holds.
 *
 * This file also defines the two structural seams the rest of Agent 3's modules build
 * against — `StateAccess` and `EventSink`. They are deliberately structural: Agent 1's
 * real `StateStore` (state.ts) and `EventBus` (events.ts) satisfy them as-is, and tests
 * can substitute in-memory fakes without importing either.
 */

// ---------------------------------------------------------------------------
// DI seams (satisfied by state.ts's StateStore and events.ts's EventBus)
// ---------------------------------------------------------------------------

export interface StateAccess {
  getState(): Promise<CrewState>;
  withState<T>(mutator: (state: CrewState) => T | Promise<T>): Promise<T>;
}

export interface EventSink {
  publish(type: CrewEventType, fields?: Omit<CrewEvent, "id" | "type" | "at">): Promise<CrewEvent>;
  subscribe(listener: (event: CrewEvent) => void): () => void;
  readRecent(n: number): Promise<CrewEvent[]>;
}

// ---------------------------------------------------------------------------
// The state machine (spec §25): queued → running → waiting|review → done|failed|cancelled
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<AssignmentStatus, readonly AssignmentStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["waiting", "review", "done", "failed", "cancelled"],
  waiting: ["running", "failed", "cancelled"],
  // A rejected review goes back to `queued`, NOT straight to `running`: `running` means "an
  // agent is taking a turn on this right now", and after a rejection nobody is. Parked at
  // `running`, the rework was invisible to the pump (which only dispatches `queued`) and sat
  // there forever, while any later turn of that agent could be mistaken for its owner.
  review: ["queued", "running", "done", "failed", "cancelled"],
  done: [],
  failed: ["queued"], // retry only — see failAssignment()
  cancelled: [],
};

export function canTransition(from: AssignmentStatus, to: AssignmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class AssignmentTransitionError extends Error {
  constructor(
    public readonly id: string,
    public readonly from: AssignmentStatus,
    public readonly to: AssignmentStatus,
  ) {
    super(`assignment ${id}: illegal transition ${from} → ${to}`);
    this.name = "AssignmentTransitionError";
  }
}

export interface CreateAssignmentInput {
  title: string;
  instructions: string;
  workspace: string;
  assignedBy: string;
  assignedTo: string;
  docketTodoId?: string;
  /**
   * Stamped at creation, atomically, when a HUMAN chose to run this without isolation in the
   * crew's own checkout. It is the only thing that lets a worker turn start there (see
   * Orchestrator.resolveTurnPlacement), so it must exist before the assignment is dispatchable —
   * setting it afterwards would leave a window in which the pump saw unauthorised work.
   */
  nonIsolatedApprovedBy?: "human";
}

export function createAssignment(input: CreateAssignmentInput, now = new Date().toISOString()): Assignment {
  if (!input.title.trim()) throw new Error("assignment title is required");
  const assignment: Assignment = {
    id: randomUUID().slice(0, 8),
    title: input.title.trim(),
    instructions: input.instructions,
    workspace: input.workspace,
    assignedBy: input.assignedBy,
    assignedTo: input.assignedTo,
    status: "queued",
    createdAt: now,
    attempts: 0,
  };
  if (input.docketTodoId) assignment.docketTodoId = input.docketTodoId;
  if (input.nonIsolatedApprovedBy) assignment.nonIsolatedApprovedBy = input.nonIsolatedApprovedBy;
  return assignment;
}

/**
 * Hand a `queued → running` claim BACK, because the turn it was made for never started.
 *
 * Deliberately not a lifecycle transition (`running → queued` is not a legal move, and must not
 * become one): this is the claim being undone, so the attempt it booked is undone with it. A
 * turn that was merely refused — the assignee was already executing, the machine was full —
 * must not spend the retry budget of a failure that never happened, and an assignment left
 * `running` with nobody running it is invisible to the pump forever.
 */
export function releaseAssignmentClaim(assignment: Assignment): Assignment {
  if (assignment.status !== "running") return assignment;
  assignment.status = "queued";
  assignment.attempts = Math.max(0, assignment.attempts - 1);
  delete assignment.startedAt;
  return assignment;
}

/** Mutates `assignment` in place (callers pass the withState draft). Throws on an illegal move. */
export function applyTransition(assignment: Assignment, to: AssignmentStatus, now = new Date().toISOString()): Assignment {
  if (!canTransition(assignment.status, to)) {
    throw new AssignmentTransitionError(assignment.id, assignment.status, to);
  }
  assignment.status = to;
  if (to === "running") {
    assignment.attempts += 1;
    assignment.startedAt = now;
    delete assignment.finishedAt;
  }
  if (to === "done" || to === "failed" || to === "cancelled") {
    assignment.finishedAt = now;
  }
  return assignment;
}

/**
 * Retry accounting (spec §45): a failed run is retried automatically while
 * `attempts <= maxRetries` — i.e. with the default maxRetries=1 the first attempt plus one
 * automatic retry. After that the assignment stays failed and the MANAGER decides.
 *
 * REWORK IS NOT A RETRY. Every `→ running` counts an attempt, including the one a reviewer's
 * rejection causes, so one clean run plus one rejection reached `attempts: 2` and the FIRST
 * genuine failure then got no retry at all — §45's automatic retry silently never happened.
 * Rework is counted on its own (`reworks`) and subtracted here, so the budget means what it
 * says: attempts that FAILED.
 */
export function shouldRetry(assignment: Assignment, maxRetries: number): boolean {
  return assignment.attempts - (assignment.reworks ?? 0) <= Math.max(0, maxRetries);
}

// ---------------------------------------------------------------------------
// AssignmentBook — the stateful operations, all through StateAccess
// ---------------------------------------------------------------------------

export interface FailOutcome {
  assignment: Assignment;
  /** true → the assignment went back to `queued` for an automatic retry. */
  retried: boolean;
}

export class AssignmentBook {
  constructor(
    private readonly store: StateAccess,
    private readonly bus: EventSink,
    private readonly maxRetries: number,
  ) {}

  async create(input: CreateAssignmentInput): Promise<Assignment> {
    const assignment = await this.store.withState((state) => {
      const created = createAssignment(input);
      state.assignments[created.id] = created;
      return created;
    });
    await this.bus.publish("assignment.created", {
      assignmentId: assignment.id,
      summary: `${assignment.assignedBy} → ${assignment.assignedTo}: ${assignment.title}`,
    });
    return assignment;
  }

  async get(id: string): Promise<Assignment | null> {
    const state = await this.store.getState();
    return state.assignments[id] ?? null;
  }

  async list(): Promise<Assignment[]> {
    const state = await this.store.getState();
    return Object.values(state.assignments).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async start(id: string, agentId?: string): Promise<Assignment> {
    const assignment = await this.mutate(id, (a) => applyTransition(a, "running"));
    await this.bus.publish("assignment.started", {
      assignmentId: id,
      agentId,
      summary: `${assignment.assignedTo} started: ${assignment.title} (attempt ${assignment.attempts})`,
    });
    return assignment;
  }

  async complete(id: string, result: AssignmentResult): Promise<Assignment> {
    const assignment = await this.mutate(id, (a) => {
      applyTransition(a, "done");
      a.result = result;
      return a;
    });
    await this.bus.publish("assignment.completed", {
      assignmentId: id,
      summary: `${assignment.assignedTo} finished: ${assignment.title}`,
    });
    return assignment;
  }

  /**
   * Fail — and requeue for an automatic retry while the budget allows (spec §45). The retry
   * puts the item back at `queued`; whoever schedules queued work picks it up again.
   */
  async fail(id: string, result: AssignmentResult): Promise<FailOutcome> {
    const outcome = await this.store.withState((state) => {
      const a = state.assignments[id];
      if (!a) throw new Error(`no assignment ${id}`);
      applyTransition(a, "failed");
      a.result = result;
      if (shouldRetry(a, this.maxRetries)) {
        applyTransition(a, "queued");
        return { assignment: a, retried: true };
      }
      return { assignment: a, retried: false };
    });
    await this.bus.publish("assignment.failed", {
      assignmentId: id,
      summary: outcome.retried
        ? `${outcome.assignment.title} failed (attempt ${outcome.assignment.attempts}) — retrying`
        : `${outcome.assignment.title} failed after ${outcome.assignment.attempts} attempt(s) — manager must decide`,
      data: { retried: outcome.retried },
    });
    return outcome;
  }

  async requestReview(id: string, result?: AssignmentResult): Promise<Assignment> {
    const assignment = await this.mutate(id, (a) => {
      applyTransition(a, "review");
      if (result) a.result = result;
      return a;
    });
    await this.bus.publish("review.requested", {
      assignmentId: id,
      summary: `review requested: ${assignment.title}`,
    });
    return assignment;
  }

  /**
   * Reviewer verdict (spec §15): approve → done, reject → back to the QUEUE for rework.
   *
   * Not back to `running`: nobody is running it at that moment, and the pump only dispatches
   * `queued`, so a rejection parked the assignment where nothing would ever pick it up again.
   * The rework is counted separately from `attempts` — see shouldRetry.
   */
  async completeReview(id: string, approved: boolean, notes: string): Promise<Assignment> {
    const assignment = await this.mutate(id, (a) => {
      applyTransition(a, approved ? "done" : "queued");
      if (!approved) a.reworks = (a.reworks ?? 0) + 1;
      a.result = { ...(a.result ?? { summary: "" }), summary: `${a.result?.summary ?? ""}\nreview: ${notes}`.trim() };
      return a;
    });
    await this.bus.publish("review.completed", {
      assignmentId: id,
      summary: `review ${approved ? "approved" : "rejected"}: ${assignment.title}`,
      data: { approved },
    });
    return assignment;
  }

  /**
   * Park an assignment pending an answer. Idempotent: an agent that calls crew_request_help
   * and then also reports `help` is describing one blockage, not two, and must not get an
   * "illegal transition waiting → waiting" thrown back at it.
   */
  async wait(id: string): Promise<Assignment> {
    return this.mutate(id, (a) => (a.status === "waiting" ? a : applyTransition(a, "waiting")));
  }

  async resume(id: string): Promise<Assignment> {
    return this.mutate(id, (a) => applyTransition(a, "running"));
  }

  async cancel(id: string): Promise<Assignment> {
    const assignment = await this.mutate(id, (a) => applyTransition(a, "cancelled"));
    await this.bus.publish("assignment.failed", {
      assignmentId: id,
      summary: `cancelled: ${assignment.title}`,
      data: { cancelled: true },
    });
    return assignment;
  }

  private async mutate(id: string, fn: (a: Assignment) => Assignment): Promise<Assignment> {
    return this.store.withState((state) => {
      const a = state.assignments[id];
      if (!a) throw new Error(`no assignment ${id}`);
      return structuredClone(fn(a));
    });
  }
}
