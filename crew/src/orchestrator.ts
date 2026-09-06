import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { resolveSkillsForProfile } from "./skills.js";
import type {
  Assignment,
  AssignmentResult,
  CrewAgent,
  CrewConfig,
  CrewProfile,
  CrewRole,
  CrewState,
} from "./types.js";
import {
  applyTransition,
  AssignmentBook,
  releaseAssignmentClaim,
  type EventSink,
  type StateAccess,
} from "./assignments.js";
import { Mailbox, renderInbox, type SendOutcome } from "./mailbox.js";
import {
  assertAgentNameAvailable,
  describeMatches,
  resolveAgentRef,
  sanitizeMirroredName,
  uniqueDefaultName,
  uniqueMirroredName,
  validateAgentName,
  type AgentRefResolution,
} from "./naming.js";
import { collectResult, createWorktree, isGitRepo, removeWorktree, type WorktreeInfo } from "./worktrees.js";

/**
 * The manager loop (spec §13/§23/§24).
 *
 * The orchestrator owns the LOGICAL crew: which agents exist, which assignment runs where,
 * and — the reason this file exists — the automatic manager wake-up that removes manual
 * prompt-copying: when a worker reports done/failed/review/help, the idle manager is woken
 * with the result and decides what happens next, bounded by the autonomous-loop guard.
 *
 * What it deliberately does NOT own: how a runtime subprocess is actually launched and
 * parsed. That is the supervisor's job (Agent 1) behind the injected `runTurn` — the
 * orchestrator only ever says "run one turn of THIS agent with THIS prompt".
 *
 * Observed Docket sessions are registered with origin:"observed" and are never prompted,
 * cancelled, or resumed (spec §17): every scheduling path below starts from managed agents.
 */

// ---------------------------------------------------------------------------
// The seam to Agent 1's supervisor
// ---------------------------------------------------------------------------

export interface TurnRequest {
  agent: CrewAgent;
  runId: string;
  prompt: string;
  cwd: string;
}

export interface TurnOutcome {
  ok: boolean;
  /**
   * The turn was DELIBERATELY stopped (cancel/stop), not broken.
   *
   * Both are `ok:false`, and downstream that used to mean one thing: `agent.failed` on the bus,
   * and the attached assignment reported `failed` — with a retry, a manager wake and a line in
   * the human's feed saying the agent failed. A cancellation is a decision somebody made, and
   * the supervisor already distinguishes it (supervisor.ts latches the abort, and never marks a
   * turn cancelled if it produced work). This carries that distinction the last mile.
   */
  cancelled?: boolean;
  /** The runtime's final result text (AgentEvent{type:"result"} / accumulated text). */
  resultText: string;
  error?: string;
  nativeSessionId?: string;
}

export type TurnRunner = (request: TurnRequest) => Promise<TurnOutcome>;

export interface OrchestratorDeps {
  store: StateAccess;
  bus: EventSink;
  config: CrewConfig;
  runTurn: TurnRunner;
  /** Optional: abort a specific in-flight run (wired to AgentRuntimeAdapter.cancel at integration). */
  cancelRun?: (runId: string) => Promise<void>;
  /**
   * The crew-home skill root (`~/.docket/crew/skills`), added to the roots skills.ts already
   * scans — it does NOT replace the packaged `crew/skills`, which stays the lowest-precedence
   * default. The daemon passes `<crew home>/skills`; tests point it at a scratch directory.
   */
  skillsDir?: string;
  workspaceDir?: string;
  /**
   * The daemon's OWN workspace when it is a git repository — i.e. the checkout the human is
   * looking at. Non-isolated work lands here, which is why assign() treats running here
   * without a worktree as a human-only decision (see assertNonIsolatedAllowed).
   */
  workspaceRepoDir?: string;
}

export interface WorkerReport {
  agentId: string;
  assignmentId: string;
  status: "done" | "failed" | "review" | "help";
  summary: string;
  tests?: string;
  commit?: string;
}

export class Orchestrator {
  readonly assignments: AssignmentBook;
  readonly mailbox: Mailbox;
  /**
   * A CACHE, not the record. The record lives on `Assignment.worktree`, which is persisted:
   * this used to be the only copy, so a restart lost the branch, the diffstat and the answer to
   * "where IS the work?" for every isolated assignment. Kept because worktreeFor() is a
   * synchronous read on the HTTP/MCP path; it is refilled from state by resumeAfterBoot() and
   * whenever worktreeOf() looks something up.
   */
  private readonly worktrees = new Map<string, WorktreeInfo>();
  /**
   * The turns whose subprocess is alive RIGHT NOW, agent id → run id.
   *
   * State cannot express this: a cancel clears `currentRunId` while the CLI child is still
   * running, so state says "idle" for an agent that is anything but. Two turns for one agent
   * means two CLI children in the same worktree resuming the same native session — this map is
   * what makes that unrepresentable, and it is claimed synchronously so nothing can interleave.
   */
  private readonly inFlight = new Map<string, string>();
  private readonly skillCache = new Map<string, string>();
  /**
   * Background work started by a tool call (a wake, a pump). Tracked so tests — and
   * shutdown — can await the crew going quiet, WITHOUT any caller having to block on it.
   * Blocking would be a deadlock: a worker's crew_report must return in milliseconds, and
   * it is the thing that wakes the manager for a multi-minute turn.
   */
  private readonly background = new Set<Promise<unknown>>();

  constructor(private readonly deps: OrchestratorDeps) {
    this.assignments = new AssignmentBook(deps.store, deps.bus, deps.config.automation.maxRetries);
    this.mailbox = new Mailbox({
      store: deps.store,
      bus: deps.bus,
      canWake: (agentId, state) => {
        const agent = state.agents[agentId];
        // Only a MANAGED agent that can take a turn is woken; observed sessions are
        // look-don't-touch (spec §17), and an executing agent gets the message at its next
        // turn (spec §22). `failed` counts as wakeable — see canTakeATurn.
        return !!agent && agent.origin === "managed" && canTakeATurn(agent);
      },
      /**
       * Returns whether a turn WAS ACTUALLY STARTED — resolved as soon as that is decided, never
       * when the turn ends (the sender must not wait for someone else's multi-minute turn).
       *
       * The return value is the whole point: a manager wake goes through the autonomous-loop
       * guard, which legitimately refuses it (auto-wake off, paused, budget spent), and
       * mailbox.send used to report `delivery:"woken"` regardless — a status the Office then
       * repeated to the human for a turn that never ran a single token.
       */
      wake: async (agentId, reason) => {
        const state = await this.deps.store.getState();
        const agent = state.agents[agentId];
        if (!agent) return false;
        if (agent.role === "manager") {
          const why = `message from ${reason.from}`;
          const start = await this.startManagerWake(why, reason.from !== "human");
          if (start.kind !== "run") return false;
          this.track(this.runManagerWakeTurns(start.managerId, why));
          return true;
        }
        this.track(this.deliverWake(agentId));
        return true;
      },
    });
  }

  get config(): CrewConfig {
    return this.deps.config;
  }

  state(): Promise<CrewState> {
    return this.deps.store.getState();
  }

  async listAgents(): Promise<CrewAgent[]> {
    const state = await this.deps.store.getState();
    return Object.values(state.agents);
  }

  /** Run `promise` in the background, swallowing failures into the event log. */
  private track<T>(promise: Promise<T>): void {
    const tracked = promise.catch(async (err) => {
      // A background turn that blew up must be VISIBLE, not silent.
      await this.deps.bus
        .publish("agent.failed", { summary: `crew: background task failed: ${(err as Error).message}` })
        .catch(() => {});
    });
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  /**
   * Await every background wake/pump currently in flight, and anything they start in turn.
   * Deliberately timer-free: a pending timer would keep the Node event loop alive, so a CLI
   * or a test that called settle() would hang instead of exiting.
   */
  async settle(maxRounds = 1000): Promise<void> {
    for (let round = 0; round < maxRounds && this.background.size > 0; round++) {
      await Promise.allSettled([...this.background]);
      // Yield once so the tracked promises' finally() handlers can deregister themselves
      // before the next round looks at the set.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Dispatch queued assignments without blocking the caller (used by crew_assign). */
  schedulePump(): void {
    this.track(this.pump());
  }

  /**
   * Pick up where the previous daemon left off (spec §46).
   *
   * A restart used to start NOTHING: attachToDaemon only began the observed-session loop, so a
   * `queued` assignment and a manager inbox full of finished results sat there forever while the
   * Office cheerfully showed "about to start". Boot is just another moment at which work can
   * become runnable, so it does exactly what a finished turn does — sweep the queue — plus one
   * CONDITIONAL wake: the manager is woken only if it actually has unread mail, because
   * spending an autonomous manager turn on an empty inbox every time the daemon restarts is its
   * own kind of wrong. The wake still goes through wakeManager, so the pause and the
   * autonomous-loop budget apply exactly as they do at any other time.
   */
  async resumeAfterBoot(): Promise<void> {
    // The worktree cache is in-memory and therefore empty in a fresh process; the assignments
    // themselves remember where their work is, so re-populate from them.
    const state = await this.deps.store.getState();
    for (const assignment of Object.values(state.assignments)) {
      if (assignment.worktree) this.worktrees.set(assignment.id, assignment.worktree);
    }

    this.schedulePump();

    const manager = findManager(state);
    if (!manager) return;
    const unread = state.messages.filter((m) => m.to === manager.id && !m.readAt).length;
    if (unread === 0) return;
    this.track(this.wakeManager(`${unread} message(s) unread since the daemon restarted`));
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  async spawnAgent(profileName: string, opts: { name?: string; cwd?: string } = {}): Promise<CrewAgent> {
    const profile = this.deps.config.profiles[profileName];
    if (!profile) throw new Error(`crew: no such profile "${profileName}"`);
    /**
     * A name is an ADDRESS now (see naming.ts), so it is validated at BIRTH, not only at
     * rename: an agent spawned as a duplicate would be unaddressable from its first breath.
     * Validation happens outside withState so a bad name never half-enters the roster.
     */
    const requested = opts.name === undefined ? undefined : validateAgentName(opts.name);
    const agent = await this.deps.store.withState((state) => {
      const managed = Object.values(state.agents).filter((a) => a.origin === "managed" && a.status !== "stopped");
      if (managed.length >= this.deps.config.automation.maxAgents) {
        throw new Error(
          `crew: maxAgents limit reached (${this.deps.config.automation.maxAgents}) — stop an agent before spawning another`,
        );
      }
      /**
       * A name the CALLER chose is rejected when taken; a name CREW invented is bumped until
       * it is free. The default counter is "live managed agents + 1", which repeats itself
       * as soon as an agent is stopped — that collision is Crew's own bookkeeping, not the
       * caller's mistake, so it is Crew's to fix silently.
       */
      if (requested !== undefined) assertAgentNameAvailable(state.agents, requested, "");
      const name =
        requested ?? uniqueDefaultName(state.agents, `${profile.runtime} ${profile.role}`, managed.length + 1);
      const created: CrewAgent = {
        id: randomUUID().slice(0, 8),
        name,
        origin: "managed",
        profile: profileName,
        runtime: profile.runtime,
        role: profile.role,
        status: "idle",
        workspace: state.workspace,
        cwd: opts.cwd ?? this.deps.workspaceDir ?? process.cwd(),
        startedAt: new Date().toISOString(),
      };
      if (profile.model) created.model = profile.model;
      if (profile.provider) created.provider = profile.provider;
      state.agents[created.id] = created;
      return created;
    });
    await this.deps.bus.publish("agent.spawned", {
      agentId: agent.id,
      summary: `spawned ${agent.name} (${agent.runtime}, ${agent.role})`,
    });
    return agent;
  }

  /**
   * Rename a MANAGED agent (spec §17 keeps observed sessions out of it).
   *
   * The point is addressing, not decoration: after this, "@backend do X" from the human and
   * `crew_assign to:"backend"` from the manager both reach this agent, and its next turn
   * prompt introduces it to itself under the new name. So the name is validated and must be
   * unique on the live roster — a rename that produced a second "backend" would turn every
   * later message to "backend" into a coin flip (naming.ts).
   *
   * Renaming an OBSERVED session is refused: Crew did not launch it and does not own its
   * identity — the same rule that stops it being messaged, cancelled or assigned.
   *
   * Persistence is free and deliberate: the name lives in CrewState.agents[id].name, which
   * the single-writer store fsyncs to state.json, so it survives a daemon restart.
   */
  async renameAgent(agentRef: string, rawName: string): Promise<CrewAgent> {
    const name = validateAgentName(rawName);
    const { agent, previousName, changed } = await this.deps.store.withState((state) => {
      const found = resolveAgentRef(state.agents, agentRef);
      if (!found.ok) throw agentRefError(agentRef, found);
      const target = state.agents[found.agent.id];
      if (target.origin === "observed") {
        throw new ObservedAgentError(target.name, "renamed — Crew did not launch it and does not own its name");
      }
      assertAgentNameAvailable(state.agents, name, target.id);
      const previous = target.name;
      target.name = name;
      return { agent: structuredClone(target), previousName: previous, changed: previous !== name };
    });

    /**
     * There is no `agent.renamed` in the frozen CrewEventType vocabulary. `agent.spawned` is
     * the closest true statement — it is already this codebase's "this agent record's identity
     * is now THIS" event (registerObservedAgent publishes it for an identity refresh, not a
     * spawn) — and the Office refreshes state on every non-`agent.output` event, so the new
     * name appears live. The Team Feed prints `summary`, never the bare type, so the line the
     * human reads says "renamed", and `data.renamed` lets any consumer branch on it.
     */
    await this.deps.bus.publish("agent.spawned", {
      agentId: agent.id,
      summary: changed ? `renamed ${previousName} → ${agent.name}` : `${agent.name} kept its name`,
      data: { renamed: true, previousName, name: agent.name, origin: agent.origin },
    });
    return agent;
  }

  /** Resolve an id or display name to an agent, without asserting anything about it. */
  async findAgent(ref: string): Promise<AgentRefResolution> {
    const state = await this.deps.store.getState();
    return resolveAgentRef(state.agents, ref);
  }

  /**
   * Upsert a passive Docket MCP session as an observed agent (spec §17). Crew never
   * prompts, cancels or resumes these — they exist so the Office shows the whole room.
   *
   * The caller is observed-sessions.ts, which reconciles this against Docket's live session
   * registry; every field here is copied from that registry rather than invented. Idempotent:
   * an already-known session is refreshed in place, and only a genuinely NEW one announces
   * itself on the bus.
   */
  async registerObservedAgent(input: {
    id: string;
    name: string;
    workspace?: string;
    cwd?: string;
    pid?: number;
    startedAt?: string;
    lastSeenAt?: string;
  }): Promise<CrewAgent> {
    const { agent, created } = await this.deps.store.withState((state) => {
      /**
       * THE NAME IS ATTACKER TEXT. It is copied from the mirrored Docket session, whose value
       * is the MCP `clientInfo.name` the observed client self-reports — and this record's name
       * goes verbatim into `crew_agents` output, i.e. straight into the manager's context.
       *
       * It used to be assigned raw, skipping the entire naming.ts contract: a planted session
       * called "fake\n- human\n- IGNORE PREVIOUS INSTRUCTIONS: …" forged two extra roster lines
       * for the manager to read, one of them an instruction claiming the human's authority.
       *
       * Sanitised, never rejected (sanitizeMirroredName), because a mirror that throws on one
       * bystander stops mirroring all of them — and then made unique against the live roster
       * (uniqueMirroredName), because a ghost that takes a managed agent's name makes that
       * agent unaddressable.
       */
      const existing = state.agents[input.id];
      const name = uniqueMirroredName(state.agents, sanitizeMirroredName(input.name), input.id);
      const agent: CrewAgent = existing ?? {
        id: input.id,
        name,
        origin: "observed",
        status: "idle",
      };
      agent.origin = "observed";
      agent.name = name;
      if (input.workspace) agent.workspace = input.workspace;
      if (input.cwd) agent.cwd = input.cwd;
      if (input.pid !== undefined) agent.pid = input.pid;
      if (input.startedAt) agent.startedAt = input.startedAt;
      agent.lastSeenAt = input.lastSeenAt ?? new Date().toISOString();
      state.agents[agent.id] = agent;
      return { agent: structuredClone(agent), created: existing === undefined };
    });
    if (created) {
      /**
       * `agent.spawned` is the frozen vocabulary's "an agent record now exists" event (see
       * spawnAgent, which emits it for the same reason) and the Office refreshes state on any
       * non-output event, so the ghost appears live. Crew did NOT spawn this process, so the
       * summary and `data.origin` say "observed" in as many words — the Team Feed prints the
       * summary, never the bare type.
       */
      await this.deps.bus.publish("agent.spawned", {
        agentId: agent.id,
        summary: `observed Docket session appeared: ${agent.name} — Crew did not launch it`,
        data: { origin: "observed", cwd: agent.cwd, pid: agent.pid, workspace: agent.workspace },
      });
    }
    return agent;
  }

  /**
   * A Docket session that is gone (process exited, or its heartbeat aged past Docket's TTL).
   *
   * The record is DELETED, not marked stopped: an observed agent is a live mirror of
   * something Crew does not own, and a permanent "stopped" ghost on the glass would be Crew
   * asserting a fact it has no way to keep true. Deliberately separate from stopAgent(),
   * which must keep refusing observed agents (spec §17) — nothing here touches a process.
   *
   * Returns false when there was nothing to remove, or when the id names a MANAGED agent:
   * this path must never be able to erase an agent Crew is responsible for.
   */
  async removeObservedAgent(agentId: string): Promise<boolean> {
    const removed = await this.deps.store.withState((state) => {
      const agent = state.agents[agentId];
      if (!agent || agent.origin !== "observed") return null;
      delete state.agents[agentId];
      return agent;
    });
    if (!removed) return false;
    await this.deps.bus.publish("agent.stopped", {
      agentId,
      summary: `observed Docket session ended: ${removed.name}`,
      data: { origin: "observed" },
    });
    return true;
  }

  /**
   * Stop MEANS stop.
   *
   * This used to set `stopped` and then await the cancellation — and the cancelled turn's own
   * epilogue, arriving a moment later, wrote `failed` over it. `failed` is wakeable
   * (canTakeATurn) and still counts as a manager (findManager), so a human who stopped an agent
   * misbehaving in their tree had it restarted by the next worker report. Two things prevent it
   * now: the epilogue is a compare-and-set on the run id (finishTurn), and `stopped` is terminal
   * against a stale epilogue. The re-assert below is the third: whatever raced, the state after
   * this call is the one the human asked for.
   */
  async stopAgent(agentId: string): Promise<void> {
    const runId = await this.deps.store.withState((state) => {
      const agent = state.agents[agentId];
      if (!agent) throw new Error(`crew: no agent ${agentId}`);
      if (agent.origin === "observed") {
        throw new Error(`crew: ${agent.name} is an observed session — Crew did not launch it and cannot stop it (spec §17)`);
      }
      const running = agent.currentRunId;
      agent.status = "stopped";
      delete agent.currentRunId;
      return running;
    });
    if (runId && this.deps.cancelRun) await this.deps.cancelRun(runId);
    await this.deps.store.withState((state) => {
      const agent = state.agents[agentId];
      if (!agent) return;
      agent.status = "stopped";
      delete agent.currentRunId;
    });
    await this.deps.bus.publish("agent.stopped", { agentId, summary: `stopped ${agentId}` });
  }

  // -------------------------------------------------------------------------
  // Assigning work
  // -------------------------------------------------------------------------

  async assign(input: {
    to: string;
    title: string;
    instructions: string;
    assignedBy: string;
    docketTodoId?: string;
    /** Coding assignment: isolate the worker in a fresh worktree of this repo (spec §27/§28). */
    isolate?: { repoDir: string };
    /**
     * WHO chose this, structurally — not who is named in `assignedBy`. Only the human control
     * surface passes "human"; the crew_assign tool path always passes "agent" and no tool
     * argument can influence it. Defaults to "agent": fail closed.
     */
    requestedBy?: "human" | "agent";
  }): Promise<Assignment> {
    const state = await this.deps.store.getState();
    const target = state.agents[input.to];
    if (!target) throw new Error(`crew: no agent ${input.to}`);
    if (target.origin === "observed") {
      throw new Error(`crew: ${target.name} is an observed session — it cannot be assigned work (spec §17)`);
    }
    // Before anything is recorded: an agent may not put a worker in the human's own checkout.
    if (!input.isolate) await this.assertNonIsolatedAllowed(input.requestedBy ?? "agent", input.assignedBy, target);

    const assignment = await this.assignments.create({
      title: input.title,
      instructions: input.instructions,
      workspace: state.workspace,
      assignedBy: input.assignedBy,
      assignedTo: input.to,
      docketTodoId: input.docketTodoId,
      /**
       * The human's authorisation to run in their own checkout, recorded ON THE ASSIGNMENT and
       * stamped at creation so it exists before anything can dispatch it. Scoped to this one
       * assignment on purpose: it is not a standing permission for the agent, so the door closes
       * again the moment this work is finished.
       */
      ...(!input.isolate && (input.requestedBy ?? "agent") === "human"
        ? { nonIsolatedApprovedBy: "human" as const }
        : {}),
    });

    if (input.isolate) {
      // Fails LOUDLY on a dirty repo (WorktreeDirtyError, spec §28) before anything runs.
      let info: WorktreeInfo;
      try {
        info = await createWorktree({
          repoDir: input.isolate.repoDir,
          assignmentId: assignment.id,
          runtime: target.runtime ?? "claude",
          worktreesDir: this.worktreesRoot(),
        });
      } catch (err) {
        /**
         * Isolation was refused (dirty repo) or broke. The assignment already exists and is
         * `queued`, and a queued assignment is dispatchable: the next pump would have run it
         * with NO worktree, i.e. in the human's own checkout — the exact outcome the refusal
         * above exists to prevent. Cancel it, so a refusal leaves nothing runnable behind.
         */
        await this.assignments.cancel(assignment.id).catch(() => {});
        throw err;
      }
      /**
       * The worktree belongs to the ASSIGNMENT, and is recorded on it.
       *
       * What used to happen instead: `agent.cwd` was re-pinned to the newest worktree on every
       * assign(), and the turn preferred that pin over the assignment's own tree. Two queued
       * assignments then shared one checkout — the first one's work was committed on the
       * second one's branch under the second one's title, and its own report said
       * "(no committed changes)" on an empty branch. A human reading that report concludes the
       * worker did nothing. The pin is gone; resolveTurnPlacement reads the assignment.
       *
       * The session pin the old code juggled here is gone with it: sessions are keyed by the
       * directory they were created in (CrewAgent.sessions), because `codex exec resume` takes
       * its cwd from the spawn cwd and filters sessions by it (docs/RUNTIME-CONTRACTS.md). An
       * unpin step that some other write could undo is now an invariant that cannot be.
       */
      this.worktrees.set(assignment.id, info);
      await this.deps.store.withState((state) => {
        const a = state.assignments[assignment.id];
        if (a) a.worktree = info;
      });
      assignment.worktree = info;
    }

    /**
     * NOT sent as mail. An assignment reaches its worker through the turn prompt that
     * pump() builds (buildTurnPrompt's "Current assignment" section) — mailing it as well
     * would wake the worker for a turn that has no assignment attached yet, and pump()
     * would then run a SECOND turn for the same work.
     */
    this.schedulePump();
    return assignment;
  }

  /**
   * Spec §28's other half (defect 2).
   *
   * §28 refuses to isolate a worker while the human's repo is dirty. The hole that left: the
   * manager could read that 400 and simply re-send the same assignment with `isolate:false`,
   * which drops a real coding agent straight into the human's working tree — the very
   * "worker sees a different tree than the human" hazard, arrived at by the other door.
   *
   * So non-isolated execution IN THE DAEMON'S OWN WORKSPACE REPO is a human decision. The
   * distinction is structural, not a string an agent can spell: `requestedBy` is "human" only
   * on the human control surface (an Office request carrying the UI session cookie, or the
   * DOCKET_CREW_ALLOW_UNISOLATED opt-in), and crew_assign hard-codes "agent" where no tool
   * argument can reach it.
   *
   * Deliberately narrow: only the workspace the daemon itself is running in, and only when it
   * really is a git repo. A scratch repo elsewhere, or a plain directory where isolation is
   * impossible anyway, stays permissive — a guard that also blocked those would be a dead end
   * rather than a protection.
   */
  private async assertNonIsolatedAllowed(requestedBy: "human" | "agent", assignedBy: string, target: CrewAgent): Promise<void> {
    const repo = this.deps.workspaceRepoDir;
    if (!repo || requestedBy === "human") return;
    if (!(await isGitRepo(repo))) return;

    const error = new NonIsolatedWorkspaceError(repo, target.name);
    // Visible, not just returned to the agent that asked: the human watching the Office sees
    // what the crew tried to do to their checkout.
    await this.deps.bus
      .publish("agent.failed", {
        agentId: assignedBy,
        summary: `refused isolate:false for ${target.name} in the crew's own workspace ${repo} — only the human can choose that`,
        data: { refusedIsolateFalse: true, repoDir: repo, assignedTo: target.id },
      })
      .catch(() => {});
    throw error;
  }

  private crewHomeRoot(): string {
    const env = process.env.DOCKET_CREW_HOME?.trim();
    return env ? resolve(env) : join(process.env.HOME ?? process.cwd(), ".docket", "crew");
  }

  private worktreesRoot(): string {
    return join(this.crewHomeRoot(), "worktrees");
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  /**
   * Run one real turn for a managed agent. Pending mailbox messages are drained INTO the
   * prompt at the start of the turn (spec §22) — never injected into a running process.
   */
  async runAgentTurn(agentId: string, extraPrompt: string): Promise<TurnOutcome> {
    const runId = randomUUID().slice(0, 8);
    /**
     * Admission control, taken with NO await between the check and the claim, so two callers
     * cannot both pass it. See `inFlight`: a cancelled-but-still-alive child leaves state saying
     * "idle", and the old code started a second turn on top of it.
     */
    if (this.inFlight.has(agentId)) throw new AgentBusyError(agentId);
    this.inFlight.set(agentId, runId);
    try {
      return await this.runOneTurn(agentId, runId, extraPrompt);
    } finally {
      this.releaseInFlight(agentId, runId);
    }
  }

  /**
   * Give up this run's claim on the agent — and only THIS run's: something else may already
   * hold it. Called the moment the child process is done (runOneTurn), not at the end of the
   * epilogue: the epilogue itself legitimately starts the agent's next turn (queued mail, a
   * manager re-wake), and holding the claim across it would make the crew swallow that mail.
   */
  private releaseInFlight(agentId: string, runId: string): void {
    if (this.inFlight.get(agentId) === runId) this.inFlight.delete(agentId);
  }

  private async runOneTurn(agentId: string, runId: string, extraPrompt: string): Promise<TurnOutcome> {
    const { agent, assignment } = await this.deps.store.withState((state) => {
      const a = state.agents[agentId];
      if (!a) throw new Error(`crew: no agent ${agentId}`);
      if (a.origin === "observed") throw new Error(`crew: refusing to run a turn of observed session ${a.name} (spec §17)`);
      if (a.status === "working") throw new AgentBusyError(a.name);
      // A stop is a decision about the AGENT, not about one turn: nothing may start another.
      if (a.status === "stopped") throw new StoppedAgentError(a.name);
      const running = Object.values(state.agents).filter((x) => x.currentRunId).length;
      if (running >= this.deps.config.automation.maxConcurrentRuns) {
        throw new ConcurrencyLimitError(this.deps.config.automation.maxConcurrentRuns);
      }
      a.status = "working";
      a.currentRunId = runId;
      a.lastSeenAt = new Date().toISOString();
      const asg = a.currentAssignmentId ? state.assignments[a.currentAssignmentId] : undefined;
      return { agent: structuredClone(a), assignment: asg ? structuredClone(asg) : undefined };
    });

    /**
     * WHERE this turn runs is decided HERE, at the point a turn actually starts, and nowhere
     * else. It used to be decided in assign(), which left every other door open: a `crew_send`
     * from the manager woke a worker whose cwd was still the human's checkout — no worktree, no
     * dirty check, no consent, no event — and so did an HTTP message and `ask @worker`. A guard
     * that lives on one call path is not a guard; this one no future caller can route around.
     */
    let placement: { cwd: string; refusedRepoDir?: string };
    try {
      placement = await this.resolveTurnPlacement(agent, assignment);
    } catch (err) {
      /**
       * The turn cannot be placed (no scratch directory could be made, git is unreachable). The
       * claim above already marked the agent `working` and took a run slot, so hand both back
       * before propagating — a leaked slot is invisible and permanent. Refusing the turn is the
       * right outcome: the alternative placement is the human's checkout.
       */
      await this.finishTurn(agentId, runId, agent.cwd ?? "", { ok: false, resultText: "", error: (err as Error).message });
      throw err;
    }
    const cwd = placement.cwd;
    if (placement.refusedRepoDir) {
      await this.deps.bus
        .publish("agent.failed", {
          agentId,
          runId,
          summary:
            `refused to start ${agent.name} in the crew's own workspace ${placement.refusedRepoDir} — ` +
            `a worker turn there edits the checkout the human is looking at. Ran it in ${cwd} instead; ` +
            `isolate the assignment (crew_assign isolate:true) to give it a real tree to work in.`,
          data: { refusedWorkspaceRun: true, repoDir: placement.refusedRepoDir, cwd, role: agent.role ?? "worker" },
        })
        .catch(() => {});
    }
    /**
     * A runtime session may only ever be resumed in the directory it was created in, so the
     * agent handed to the runner carries the session for THIS cwd — or none at all.
     */
    const session = sessionForCwd(agent, cwd);
    if (session) agent.nativeSessionId = session;
    else delete agent.nativeSessionId;

    await this.deps.bus.publish("agent.started", { agentId, runId, summary: `${agent.name} started a turn` });

    const inbox = await this.mailbox.drain(agentId);
    const prompt = await this.buildTurnPrompt(agent, assignment, renderInbox(inbox), extraPrompt);

    let outcome: TurnOutcome;
    try {
      outcome = await this.deps.runTurn({ agent, runId, prompt, cwd });
    } catch (err) {
      outcome = { ok: false, resultText: "", error: (err as Error).message };
    }

    /**
     * The turn died with mail it had already drained. It never read it, so put it back: mail
     * marked delivered by a turn that then failed is how a worker's finished result vanishes
     * without a trace. The retry (or the next wake) gets the same inbox.
     */
    if (!outcome.ok && inbox.length > 0) {
      await this.mailbox.restore(inbox.map((m) => m.id));
    }

    await this.finishTurn(agentId, runId, cwd, outcome);
    // The subprocess is done, so the agent is free — everything below is bookkeeping, and some
    // of it (queued mail, a manager re-wake) deliberately starts this agent's NEXT turn.
    this.releaseInFlight(agentId, runId);
    /**
     * A CANCELLED turn is not a failed one. `agent.stopped` is the frozen vocabulary's word for
     * "this run was ended on purpose" — the same event cancelAgentRun publishes — and saying
     * `agent.failed` here put "X failed: undefined" in the human's feed for something the human
     * had just clicked cancel on.
     */
    await this.deps.bus.publish(outcome.ok ? "agent.idle" : outcome.cancelled ? "agent.stopped" : "agent.failed", {
      agentId,
      runId,
      summary: outcome.ok
        ? `${agent.name} finished its turn`
        : outcome.cancelled
          ? `${agent.name}'s turn was cancelled`
          : `${agent.name} failed: ${outcome.error ?? "unknown error"}`,
    });

    // Mail that arrived WHILE the manager was executing queued (spec §22). The manager is
    // idle again now, so those queued results must wake it — still through the loop guard.
    if (outcome.ok && agent.role === "manager") {
      const state = await this.deps.store.getState();
      const unread = state.messages.filter((m) => m.to === agentId && !m.readAt);
      if (unread.length > 0) {
        this.track(this.wakeManager(`${unread.length} message(s) queued during the last turn`));
      }
    }

    if (agent.role !== "manager" && assignment) {
      /**
       * ONLY the assignment this turn was BUILT WITH, and only while it is still running.
       *
       * This used to SCAN for `assignedTo === me && status === "running"`, which is a different
       * question: any assignment stranded in `running` by something else was picked up by the
       * next unrelated turn. Reproduced: a "say hi" turn moved somebody else's work to `review`
       * with "ended its turn without calling crew_report, UNVERIFIED" on it.
       */
      const state = await this.deps.store.getState();
      const current = state.assignments[assignment.id];
      const attached = current && current.status === "running" && current.assignedTo === agentId ? current : undefined;
      if (attached && outcome.cancelled) {
        /**
         * DELIBERATELY STOPPED, not broken. This used to fall into the `!outcome.ok` branch
         * below and be reported `failed`, which spends a retry from the §45 budget, wakes the
         * manager with "turn failed", and tells the human their own cancel button broke
         * something. The supervisor guarantees a cancelled turn carries no finished work
         * (supervisor.ts latches the abort and refuses to call a productive turn cancelled), so
         * there is nothing to salvage and nothing to judge — the assignment goes back to the
         * queue as `cancelled`, which is a terminal status the manager can see and re-decide.
         */
        await this.assignments.cancel(attached.id).catch(() => {});
        await this.deps.bus.publish("assignment.failed", {
          agentId,
          runId,
          assignmentId: attached.id,
          summary: `${attached.title}: cancelled — the run was stopped on purpose, not by a failure`,
          data: { cancelled: true },
        });
      } else if (attached && !outcome.ok) {
        // The turn DIED with an assignment attached: that assignment did not succeed,
        // whatever it planned to report. Normal failure path — retry accounting + wake.
        await this.report({
          agentId,
          assignmentId: attached.id,
          status: "failed",
          summary: `turn failed: ${outcome.error ?? "unknown error"}`,
        });
      } else if (attached) {
        /**
         * The turn ended cleanly but the worker never called crew_report. We genuinely do
         * not know whether the work is done — an empty/absent report is NOT evidence of
         * failure (a codex resume can finish real work with empty result text), and it is
         * certainly not evidence of success either. So: no verdict. It goes to `review`
         * with the turn's own output and the worktree diff attached, and the manager is
         * woken to judge — which is exactly what `review` means.
         */
        await this.report({
          agentId,
          assignmentId: attached.id,
          status: "review",
          summary:
            `${agent.name} ended its turn without calling crew_report, so this outcome is UNVERIFIED — ` +
            `check the diff below before accepting it.\n\nFinal output: ${outcome.resultText || "(none)"}`,
        });
      }
    }

    /**
     * A run slot just freed. If a wake was REFUSED for capacity while this turn held a slot
     * (typically the worker's own crew_report waking the manager at maxConcurrentRuns), its
     * mail is unread with nothing scheduled to look at it again — a finished result sitting
     * in an idle manager's inbox forever. Redeem exactly that owed wake; a wake that is
     * merely still in flight is NOT re-issued, or every result would be delivered twice.
     */
    const owed = this.owedWakeReason;
    if (owed && agent.role !== "manager") {
      this.owedWakeReason = null;
      this.track(this.wakeManager(`${owed} (retried once a run slot freed)`));
    }

    /**
     * The worker/reviewer half of "busy → queued → delivered at the start of the next turn".
     *
     * The manager already had this (just above): mail that arrived mid-turn re-wakes it.
     * Nothing did it for a worker, and that was a real hole the moment a human could address
     * a worker directly — a message queued behind a busy worker's last assignment turn had
     * NOTHING scheduled to open it. The worker would go idle holding unread human instructions
     * forever, which reads exactly like Crew dropping the message.
     *
     * Terminating by construction: a turn drains its inbox before the runtime sees a token, so
     * the woken turn finds nothing left and does not wake another.
     */
    if (outcome.ok && agent.role !== "manager") {
      const state = await this.deps.store.getState();
      if (state.messages.some((m) => m.to === agentId && !m.readAt)) {
        this.track(this.deliverQueuedMail(agentId));
      }
    }

    // This agent is idle again, so work that was queued while it was busy — most importantly
    // an automatic retry, which is queued from INSIDE the failing turn — can now start.
    this.schedulePump();
    return outcome;
  }

  /**
   * Start a turn purely to hand a non-manager agent the mail that queued while it was busy.
   * Busy / out-of-slots is not a failure here: the turn already running drains the same
   * inbox, and the pump that follows every finished turn comes back for the rest.
   */
  private async deliverQueuedMail(agentId: string): Promise<void> {
    const state = await this.deps.store.getState();
    const agent = state.agents[agentId];
    if (!agent || agent.origin !== "managed" || !canTakeATurn(agent)) return;
    if (!state.messages.some((m) => m.to === agentId && !m.readAt)) return;
    await this.deliverWake(agentId);
  }

  /**
   * Start a turn because mail arrived. Busy / out of slots / stopped are not failures here: the
   * turn already running drains the same inbox, the pump that follows every finished turn comes
   * back for the rest, and a stopped agent is a decision, not an error.
   */
  private async deliverWake(agentId: string): Promise<void> {
    try {
      await this.runAgentTurn(agentId, "");
    } catch (err) {
      if (err instanceof AgentBusyError || err instanceof ConcurrencyLimitError || err instanceof StoppedAgentError) return;
      throw err;
    }
  }

  /**
   * WHERE a turn may run. The whole isolation decision, in one place, evaluated every time a
   * turn starts (see runOneTurn).
   *
   * Resolution order — the ASSIGNMENT's own worktree first, `agent.cwd` only as a fallback. It
   * was the other way round, and since assign() re-pinned `agent.cwd` to the newest worktree,
   * two queued assignments ran in one tree and the first one's work landed on the second one's
   * branch (defect D).
   *
   * Then the rule the README promises and only assign() used to enforce: a non-manager turn is
   * never started in the crew's own workspace repository — the checkout the human is looking at
   * — unless a HUMAN authorised that specific assignment (Assignment.nonIsolatedApprovedBy,
   * which no agent-facing path can set). The manager is exempt by design: managing IS work in
   * the human's repo, it is spawned there deliberately, and it does not write code.
   *
   * A refused turn is MOVED, not killed: the message still gets answered, in a scratch directory
   * of the agent's own, and the human is told on the bus. Refusing outright would turn a
   * mis-addressed message into a dead crew; handing over the checkout is the thing we will not do.
   */
  private async resolveTurnPlacement(
    agent: CrewAgent,
    assignment: Assignment | undefined,
  ): Promise<{ cwd: string; refusedRepoDir?: string }> {
    const isolated =
      assignment?.worktree?.path ??
      (agent.currentAssignmentId ? this.worktrees.get(agent.currentAssignmentId)?.path : undefined);
    const cwd = isolated ?? agent.cwd ?? this.deps.workspaceDir ?? process.cwd();

    const repo = this.deps.workspaceRepoDir;
    if (!repo) return { cwd };
    if ((agent.role ?? "worker") === "manager") return { cwd };
    // CONTAINMENT, not equality: `<repo>/src` is the human's checkout every bit as much as
    // `<repo>` is. Crew worktrees live under the crew home, outside the repo, so they are
    // unaffected by this.
    if (!isInside(cwd, repo)) return { cwd };
    if (assignment?.nonIsolatedApprovedBy === "human") return { cwd };
    // Only a real git checkout is protected: where isolation is impossible anyway, a refusal
    // would be a dead end rather than a protection (same rule as assertNonIsolatedAllowed).
    if (!(await isGitRepo(repo))) return { cwd };
    return { cwd: await this.agentScratchDir(agent.id), refusedRepoDir: repo };
  }

  /**
   * The agent's own directory under the crew home. Somewhere real to run that is emphatically
   * not the human's checkout; created on demand, and a failure to create it fails the turn
   * rather than falling back to the repository.
   */
  private async agentScratchDir(agentId: string): Promise<string> {
    const dir = join(this.crewHomeRoot(), "agents", agentId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * The epilogue, as a COMPARE-AND-SET on the run id.
   *
   * A turn's ending may only write the state of the run it actually IS. Without that check it
   * overwrote a human's `stop` with `failed` (making the agent wakeable again, so the next
   * worker report restarted it), deleted a SUCCESSOR run's `currentRunId` (so the concurrency
   * counter read zero and a second child was started), and wrote back a session id that a
   * deliberate unpin had just dropped.
   */
  private async finishTurn(agentId: string, runId: string, cwd: string, outcome: TurnOutcome): Promise<void> {
    await this.deps.store.withState((state) => {
      const a = state.agents[agentId];
      if (!a) return;
      /**
       * The session id is a fact about THIS DIRECTORY, so it is recorded even by a turn that has
       * already been superseded — but only under its own cwd. That is what makes it safe: it can
       * never be resumed anywhere else (sessionForCwd).
       */
      if (outcome.nativeSessionId) {
        a.sessions = trimSessions({ ...(a.sessions ?? {}), [cwd]: outcome.nativeSessionId });
      }
      if (a.currentRunId !== runId) return; // superseded by a stop, a cancel or a restart
      if (outcome.nativeSessionId) a.nativeSessionId = outcome.nativeSessionId;
      delete a.currentRunId;
      a.lastSeenAt = new Date().toISOString();
      if (a.status === "stopped") return; // the human decided; a turn does not overrule that
      a.status = outcome.ok ? "idle" : "failed";
    });
  }

  /**
   * Pick up queued work: START each queued assignment whose assignee is idle — and resolve as
   * soon as they are all STARTED, not when they have finished. Use settle() to wait for the
   * turns themselves; they are tracked background work like every other turn.
   *
   * SINGLE-FLIGHT, still, but for a smaller reason than before. It was introduced when two
   * concurrent pumps could both see the same `queued` item and both start it ("illegal
   * transition running → running" in a live run); that hole is now closed one layer down, by
   * the atomic claim in pumpOnce, which is what actually makes double-dispatch
   * unrepresentable. What the lock is still worth:
   *   - it COALESCES: a burst of pumps (assign + a finished turn + a retry, all at once)
   *     becomes one sweep plus a dirty flag, instead of N sweeps re-reading the whole state;
   *   - it keeps `skipped` meaningful: one sweep, one set of "not startable right now" items,
   *     so an unclaimable assignment cannot spin;
   *   - it keeps the capacity read in pumpOnce from being made N times against the same
   *     stale snapshot, which would over-claim and then have to hand the claims back.
   * What it must NOT do any more is serialize the TURNS — that was the defect.
   */
  async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return this.pumping;
    }
    this.pumping = (async () => {
      try {
        do {
          this.pumpAgain = false;
          await this.pumpOnce();
        } while (this.pumpAgain);
      } finally {
        this.pumping = null;
      }
    })();
    return this.pumping;
  }

  private pumping: Promise<void> | null = null;
  private pumpAgain = false;
  /** A manager wake that was refused for lack of a run slot and must be re-issued (see runAgentTurn). */
  private owedWakeReason: string | null = null;

  /**
   * One sweep of the queue.
   *
   * SWEEPS, rather than stopping at the head. It used to take only the oldest queued assignment
   * and `return` the moment its claim failed — and since the claim fails identically on every
   * later pump when the assignee is stopped, observed or gone, ONE unclaimable item blocked
   * every other assignment in the crew, permanently, whatever woke the pump.
   */
  private async pumpOnce(): Promise<void> {
    const skipped = new Set<string>();
    const limit = this.deps.config.automation.maxConcurrentRuns;
    for (;;) {
      const state = await this.deps.store.getState();
      /**
       * Don't claim what cannot be started. runOneTurn's own check is still THE limiter (it is
       * the one taken atomically with the status write, and it covers wakes as well as the
       * pump) — this is the sweep declining to book work it already knows there is no room for.
       *
       * Two sources, because neither alone is complete for a turn that has been STARTED but has
       * not reached its first `withState` yet: `inFlight` is claimed synchronously by
       * runAgentTurn, so it sees turns state has not heard about; `currentRunId` covers runs
       * this process did not start (a restart's leftovers). Without this the sweep would claim
       * every queued item, watch each turn throw ConcurrencyLimitError, and hand every claim
       * back — churn on the state file for nothing.
       */
      const running = Math.max(this.inFlight.size, Object.values(state.agents).filter((a) => a.currentRunId).length);
      if (running >= limit) return; // the machine is full — the next pump (every turn ends in one) retries
      const next = Object.values(state.assignments)
        .filter((a) => a.status === "queued" && !skipped.has(a.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!next) return;

      /**
       * Claim ATOMICALLY: the "is it still queued / is the agent still idle" check and the
       * queued→running transition happen inside one withState, so the decision can never be
       * made against a state that changed underneath it.
       */
      const claim = await this.deps.store.withState((s) => {
        const assignment = s.assignments[next.id];
        if (!assignment || assignment.status !== "queued") return null;
        const agent = s.agents[assignment.assignedTo];
        // `failed` is claimable (canTakeATurn): the automatic retry a crashed turn books is
        // queued while its worker is still marked failed, and a claim that insisted on `idle`
        // left that retry sitting in the queue forever with nothing to re-trigger it.
        if (!agent || agent.origin !== "managed" || !canTakeATurn(agent)) return null;
        applyTransition(assignment, "running");
        agent.currentAssignmentId = assignment.id;
        return { assignment: structuredClone(assignment), agentId: agent.id };
      });
      if (!claim) {
        // Not startable right now (assignee busy, stopped, observed, gone, or someone else took
        // it). Skip it for THIS sweep and keep going: the rest of the queue is not its hostage.
        skipped.add(next.id);
        continue;
      }

      await this.deps.bus.publish("assignment.started", {
        assignmentId: claim.assignment.id,
        agentId: claim.agentId,
        summary: `${claim.agentId} started: ${claim.assignment.title} (attempt ${claim.assignment.attempts})`,
      });

      /**
       * START the turn; do not WAIT for it. This `await` was the whole of defect 10: it held
       * the single-flight pump for the entire multi-minute turn, so the sweep dispatched one
       * assignment at a time and `maxConcurrentRuns` was decoration — three idle workers with
       * three queued assignments peaked at one turn in flight.
       *
       * Admission control is unaffected: runAgentTurn takes the agent's `inFlight` claim
       * SYNCHRONOUSLY (its body runs to the first await before this call returns), so the next
       * iteration of this loop already sees it, and runOneTurn's concurrency check is taken
       * atomically with the status write. Nothing here can race it.
       */
      const started = this.runAgentTurn(claim.agentId, "").then(
        () => undefined,
        async (err: unknown) => {
          /**
           * The claim and the turn are two transactions, and several things legitimately start a
           * turn in between — deliverQueuedMail and a mailbox wake, both fired by the previous
           * turn's epilogue. The claim must never outlive the turn it was made for: an
           * AgentBusyError escaping used to leave the assignment `running` with nobody running
           * it — invisible to every future pump (which dispatches only `queued`), with
           * "background task failed" as the human's only clue. Hand the claim back instead —
           * releaseAssignmentClaim gives back the attempt it booked with it.
           */
          // Marked BEFORE the release, never after: the release puts the assignment back to
          // `queued`, and a sweep that is still running must not be able to see it queued and
          // un-skipped in the window between the two — that would be a spin.
          skipped.add(claim.assignment.id);
          await this.releaseClaim(claim.assignment.id, claim.agentId);
          if (
            err instanceof ConcurrencyLimitError ||
            err instanceof AgentBusyError ||
            err instanceof StoppedAgentError
          ) {
            return; // not startable right now; the pump that follows every finished turn retries
          }
          throw err; // a real failure — track() surfaces it on the bus
        },
      );
      this.track(started);
    }
  }

  /** Undo a claim whose turn never started, so the assignment is dispatchable again. */
  private async releaseClaim(assignmentId: string, agentId: string): Promise<void> {
    await this.deps.store.withState((state) => {
      const agent = state.agents[agentId];
      if (agent && agent.currentAssignmentId === assignmentId) delete agent.currentAssignmentId;
      const assignment = state.assignments[assignmentId];
      // Only if it is still the claim we made: anything else already moved it on.
      if (!assignment || assignment.status !== "running" || assignment.assignedTo !== agentId) return;
      releaseAssignmentClaim(assignment);
    });
  }

  // -------------------------------------------------------------------------
  // Worker reports → assignment transitions → automatic manager wake (spec §23)
  // -------------------------------------------------------------------------

  async report(input: WorkerReport): Promise<Assignment> {
    const partial: AssignmentResult = { summary: input.summary };
    if (input.tests) partial.tests = input.tests;
    if (input.commit) partial.commit = input.commit;

    // Fold in worktree evidence (branch/diffstat/commit) for humans to inspect — Crew
    // records, never merges (spec §29).
    const wt = await this.worktreeOf(input.assignmentId);
    if (wt) {
      try {
        Object.assign(partial, await collectResult(wt), input.commit ? { commit: input.commit } : {});
      } catch (err) {
        /**
         * The worktree could not be read (removed, repo moved, git unavailable). SAY SO in the
         * result: swallowing it produced a report indistinguishable from ordinary non-isolated
         * work, with nothing to suggest that the branch it does not name is the only place the
         * work exists. The branch and path are still known, so they are still reported.
         */
        partial.branch = wt.branch;
        partial.worktree = wt.path;
        partial.diffStat = `(crew could not read the worktree at ${wt.path}: ${(err as Error).message})`;
      }
    }

    let assignment: Assignment;
    let wakeKind: "result" | "review-request" | "help-request" = "result";
    let retried = false;

    switch (input.status) {
      case "done":
        assignment = await this.assignments.complete(input.assignmentId, partial);
        break;
      case "failed": {
        const outcome = await this.assignments.fail(input.assignmentId, partial);
        assignment = outcome.assignment;
        retried = outcome.retried;
        break;
      }
      case "review":
        assignment = await this.assignments.requestReview(input.assignmentId, partial);
        wakeKind = "review-request";
        break;
      case "help":
        assignment = await this.assignments.wait(input.assignmentId);
        wakeKind = "help-request";
        break;
    }

    await this.deps.store.withState((state) => {
      const agent = state.agents[input.agentId];
      if (agent && agent.currentAssignmentId === input.assignmentId && assignment.status !== "running") {
        delete agent.currentAssignmentId;
      }
    });

    if (retried) {
      // The retry re-queued it; the scheduler runs it again without bothering the manager.
      this.schedulePump();
      return assignment;
    }

    // Spec §23 — THE feature: the manager is woken automatically with the outcome.
    const state = await this.deps.store.getState();
    const manager = findManager(state);
    if (!manager) {
      await this.announceUndeliveredResult(input.agentId, assignment, input.summary);
    }
    if (manager) {
      await this.mailbox.send({
        from: input.agentId,
        to: manager.id,
        workspace: state.workspace,
        kind: wakeKind,
        body:
          `Assignment ${assignment.id} (“${assignment.title}”) → ${assignment.status}\n\n${input.summary}` +
          (partial.branch ? `\n\nbranch: ${partial.branch}\nworktree: ${partial.worktree}\ndiffstat:\n${partial.diffStat}` : ""),
      });
      // If the manager was executing, the message queued; if idle, mailbox.wake routed
      // through wakeManager() below, which applied the loop guard.
    }
    return assignment;
  }

  /** A worker asked for help: park the assignment so nothing re-dispatches it (spec §25). */
  async markWaiting(assignmentId: string): Promise<Assignment> {
    return this.assignments.wait(assignmentId);
  }

  /**
   * Manager hands finished work to a reviewer (spec §15). The reviewer is given the
   * assignment as its current one so its turn prompt carries the full brief and diff
   * location, then messaged — which wakes it if it is idle.
   */
  async requestReview(assignmentId: string, reviewerId: string, notes = ""): Promise<Assignment> {
    const existing = await this.assignments.get(assignmentId);
    if (!existing) throw new Error(`crew: no assignment ${assignmentId}`);
    const assignment = existing.status === "review" ? existing : await this.assignments.requestReview(assignmentId);

    const state = await this.deps.store.withState((s) => {
      const reviewer = s.agents[reviewerId];
      if (reviewer) reviewer.currentAssignmentId = assignmentId;
      return structuredClone(s);
    });
    const wt = await this.worktreeOf(assignmentId);
    await this.mailbox.send({
      from: "manager",
      to: reviewerId,
      workspace: state.workspace,
      kind: "review-request",
      body:
        `Review assignment ${assignment.id}: ${assignment.title}\n\n` +
        `Worker's report: ${assignment.result?.summary ?? "(none)"}\n` +
        (wt ? `Branch: ${wt.branch}\nWorktree: ${wt.path}\nBase commit: ${wt.baseCommit}\n` : "") +
        (notes ? `\nWhat to check: ${notes}\n` : "") +
        `\nChallenge the change; do not reimplement it. Report with crew_report_review.`,
    });
    return assignment;
  }

  /** Reviewer verdict → assignment transition, then the manager is woken with the outcome. */
  async completeReview(reviewerId: string, assignmentId: string, approved: boolean, notes: string): Promise<Assignment> {
    const assignment = await this.assignments.completeReview(assignmentId, approved, notes);
    await this.deps.store.withState((state) => {
      const reviewer = state.agents[reviewerId];
      if (reviewer && reviewer.currentAssignmentId === assignmentId) delete reviewer.currentAssignmentId;
    });
    // A rejection re-queued the work (AssignmentBook.completeReview). Nothing else would come
    // back for it — the manager's wake below is a message, not a dispatcher.
    if (!approved) this.schedulePump();
    const state = await this.deps.store.getState();
    const manager = findManager(state);
    if (manager) {
      await this.mailbox.send({
        from: reviewerId,
        to: manager.id,
        workspace: state.workspace,
        kind: "result",
        body: `Review of ${assignment.id} (“${assignment.title}”): ${approved ? "APPROVED" : "REJECTED"}\n\n${notes}`,
      });
    } else {
      // Same rule as a worker's result: a verdict nobody receives is news, not a no-op.
      await this.announceUndeliveredResult(reviewerId, assignment, `review ${approved ? "APPROVED" : "REJECTED"}: ${notes}`);
    }
    return assignment;
  }

  // -------------------------------------------------------------------------
  // Manager wake-up + autonomous-loop guard (spec §23/§24)
  // -------------------------------------------------------------------------

  /**
   * Wake the manager for an autonomous reason (worker result, queued mail). Applies the
   * loop guard FIRST: once `maxAutonomousTurns` consecutive autonomous turns have run
   * with no human input, the manager is paused instead of woken — no infinite loops.
   */
  async wakeManager(reason: string, opts: { countsAsAutonomous?: boolean } = {}): Promise<"ran" | "paused" | "skipped"> {
    const start = await this.startManagerWake(reason, opts.countsAsAutonomous ?? true);
    if (start.kind !== "run") return start.kind;
    return this.runManagerWakeTurns(start.managerId, reason);
  }

  /**
   * The DECISION half of a manager wake: apply the guard, pause and announce if the budget is
   * spent, and say whether a turn is going to happen.
   *
   * Split out because the answer is needed synchronously by mailbox.send, which must report an
   * honest `delivery` — and must NOT wait for the turn itself. Every refusal that used to be
   * invisible to the sender (auto-wake off, paused, budget spent) is one of the non-"run"
   * answers below.
   */
  private async startManagerWake(
    reason: string,
    counts: boolean,
  ): Promise<{ kind: "run"; managerId: string } | { kind: "paused" } | { kind: "skipped" }> {
    if (!this.deps.config.automation.managerAutoWake && counts) return { kind: "skipped" };

    const decision = await this.deps.store.withState((state) => {
      const manager = findManager(state);
      if (!manager) return { kind: "skipped" as const };
      // Busy is not a dropped wake: the mail is queued and drained at the start of the
      // manager's next turn (spec §22), and runAgentTurn re-wakes it when that turn ends.
      if (manager.status === "working") return { kind: "skipped" as const };
      if (state.managerPaused && counts) return { kind: "skipped" as const };
      if (counts && state.autonomousTurns >= this.deps.config.automation.maxAutonomousTurns) {
        state.managerPaused = true;
        return { kind: "paused" as const, managerId: manager.id };
      }
      if (counts) state.autonomousTurns += 1;
      return { kind: "run" as const, managerId: manager.id, turn: state.autonomousTurns };
    });

    if (decision.kind === "skipped") return { kind: "skipped" };
    if (decision.kind === "paused") {
      await this.deps.bus.publish("manager.paused", {
        agentId: decision.managerId,
        summary: "Manager paused. Human input required.",
        data: { maxAutonomousTurns: this.deps.config.automation.maxAutonomousTurns },
      });
      return { kind: "paused" };
    }

    await this.deps.bus.publish("manager.woken", {
      agentId: decision.managerId,
      summary: `manager woken: ${reason}`,
      data: { autonomousTurn: counts ? decision.turn : 0 },
    });
    return { kind: "run", managerId: decision.managerId };
  }

  /** The TURN half of a manager wake: the bounded retry, and the loud failure if it never lands. */
  private async runManagerWakeTurns(managerId: string, reason: string): Promise<"ran" | "paused" | "skipped"> {
    /**
     * A manager turn now has its OWN retry budget. Until this, only assignments had one, so a
     * single rate-limited manager turn was terminal: the result it was woken with had already
     * been drained into that dead turn, and nothing ever retried. The budget reuses
     * automation.maxRetries (one extra attempt by default) — the failed turn restores its own
     * mail (runAgentTurn), so attempt 2 sees the same result rather than an empty prompt.
     */
    const attempts = Math.max(1, this.deps.config.automation.maxRetries + 1);
    let lastError = "unknown error";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.restartFailedAgent(managerId);
      let outcome: TurnOutcome;
      try {
        outcome = await this.runAgentTurn(managerId, "");
      } catch (err) {
        /**
         * Busy or out of run slots is NOT a failed wake and must not spend the budget: the
         * mail stays unread and is picked up either by the turn already running or by the
         * wake that runAgentTurn fires when a slot frees. Anything else really is a failure.
         */
        if (err instanceof AgentBusyError || err instanceof ConcurrencyLimitError) {
          // Busy agent: its own turn drains this mail (spec §22), nothing owed. Out of run
          // slots: nothing else is scheduled to come back for it, so book the wake to be
          // redeemed by the next turn that finishes.
          if (err instanceof ConcurrencyLimitError) this.owedWakeReason = reason;
          return "skipped";
        }
        outcome = { ok: false, resultText: "", error: (err as Error).message };
      }
      if (outcome.ok) return "ran";
      lastError = outcome.error ?? "unknown error";
    }

    await this.announceUndeliverableWake(managerId, reason, lastError, attempts);
    return "paused";
  }

  /**
   * Bring a MANAGED agent whose last turn failed back to `idle` so it can be used again.
   * Returns whether it actually was in that state — the caller can then say "restarted"
   * truthfully rather than pretending nothing was wrong.
   */
  async restartFailedAgent(agentId: string): Promise<boolean> {
    const restarted = await this.deps.store.withState((state) => {
      const agent = state.agents[agentId];
      if (!agent || agent.origin !== "managed" || agent.status !== "failed") return false;
      agent.status = "idle";
      delete agent.currentRunId;
      return true;
    });
    if (restarted) {
      await this.deps.bus.publish("agent.idle", {
        agentId,
        summary: `${agentId} restarted in place after a failed turn`,
        data: { restartedFrom: "failed" },
      });
    }
    return restarted;
  }

  /**
   * The wake could not be delivered after every attempt. This is the failure mode that used
   * to be silent — real work finished and nobody was told — so it is announced twice over:
   * a failure line in the Team Feed carrying the reason, and managerPaused, which the Office
   * renders as "human input required" and which `ask` (human input) clears.
   */
  private async announceUndeliverableWake(managerId: string, reason: string, error: string, attempts: number): Promise<void> {
    await this.deps.store.withState((state) => {
      state.managerPaused = true;
    });
    /**
     * Carry the WAITING MAIL itself into the feed. The point of this event is that finished
     * work went unacknowledged, so a human must be able to read what was reported without
     * digging through state — the mail is still unread (a failed turn restores what it
     * drained), and it is delivered for real the moment the manager takes a turn again.
     */
    const state = await this.deps.store.getState();
    const waiting = state.messages
      .filter((m) => m.to === managerId && !m.readAt)
      .slice(-3)
      .map((m) => `${m.from}: ${m.body.replace(/\s+/g, " ").slice(0, 300)}`)
      .join(" | ");
    const summary =
      `manager wake NOT DELIVERED after ${attempts} attempt(s) — ${reason}. Last error: ${error}. ` +
      `Still waiting to be read: ${waiting || "(nothing queued)"}. ` +
      `The work itself is recorded on its assignment; nobody has acted on it. ` +
      `Check the manager, then use ask/Resume to hand it over.`;
    await this.deps.bus.publish("agent.failed", { agentId: managerId, summary, data: { undeliveredWake: true, reason, error } });
    await this.deps.bus.publish("manager.paused", {
      agentId: managerId,
      summary: `Manager paused. Human input required. (${summary})`,
      data: { undeliveredWake: true },
    });
  }

  /**
   * A worker reported, and there is no manager to receive it. Never silent: the result is on
   * the assignment, but "nobody was told" is itself news the human has to see. No pause flag
   * here — nothing is paused when nothing exists to pause; the fix is to start a manager.
   */
  private async announceUndeliveredResult(agentId: string, assignment: Assignment, summary: string): Promise<void> {
    await this.deps.bus.publish("agent.failed", {
      agentId,
      assignmentId: assignment.id,
      summary:
        `result for ${assignment.id} (“${assignment.title}” → ${assignment.status}) was NOT delivered: ` +
        `no manager agent is running. Start one (docket-crew ask "…") to have it acted on. Reported: ${summary}`,
      data: { undeliveredResult: true, status: assignment.status },
    });
  }

  /**
   * Stop the autonomous loop on purpose (the Office's Pause button). Distinct from tripping
   * the guard only in WHY; the state and the event are the same, so the UI has one thing to
   * render and one thing to undo.
   */
  async pauseManager(reason = "paused by the human"): Promise<void> {
    const managerId = await this.deps.store.withState((state) => {
      state.managerPaused = true;
      return findManager(state)?.id;
    });
    await this.deps.bus.publish("manager.paused", {
      agentId: managerId,
      summary: `Manager paused. Human input required. (${reason})`,
      data: { reason },
    });
  }

  /** Lift the pause and reset the autonomous budget, without sending the manager anything. */
  async resumeManager(): Promise<void> {
    const managerId = await this.deps.store.withState((state) => {
      state.managerPaused = false;
      state.autonomousTurns = 0;
      return findManager(state)?.id;
    });
    await this.deps.bus.publish("manager.woken", {
      agentId: managerId,
      summary: "manager resumed by the human — autonomous turn budget reset",
    });
  }

  /** Cancel whatever run an agent has in flight, leaving the agent itself alive and idle. */
  async cancelAgentRun(agentId: string): Promise<boolean> {
    const runId = await this.deps.store.withState((state) => {
      const agent = state.agents[agentId];
      if (!agent) throw new Error(`crew: no agent ${agentId}`);
      if (agent.origin === "observed") {
        throw new Error(`crew: ${agent.name} is an observed session — Crew cannot cancel its work (spec §17)`);
      }
      return agent.currentRunId;
    });
    if (!runId) return false;
    if (this.deps.cancelRun) await this.deps.cancelRun(runId);
    await this.deps.store.withState((state) => {
      const agent = state.agents[agentId];
      if (agent && agent.currentRunId === runId) {
        agent.status = "idle";
        delete agent.currentRunId;
      }
    });
    await this.deps.bus.publish("agent.stopped", { agentId, runId, summary: `cancelled run ${runId}` });
    return true;
  }

  /**
   * Human input ALWAYS overrides (spec §24): it resets the autonomous-turn counter, lifts
   * the pause, and wakes the manager — this turn does not count against the guard.
   */
  async humanInput(text: string): Promise<SendOutcome> {
    const managerId = await this.deps.store.withState((state) => {
      state.autonomousTurns = 0;
      state.managerPaused = false;
      const manager = findManager(state);
      return manager?.id ?? null;
    });
    await this.deps.bus.publish("goal.created", { summary: `human: ${text.slice(0, 140)}` });
    if (!managerId) throw new Error("crew: no managed manager agent is running — spawn one from the manager profile first");
    return this.mailbox.send({
      from: "human",
      to: managerId,
      workspace: (await this.deps.store.getState()).workspace,
      kind: "message",
      body: text,
    });
  }

  /**
   * The human talks to ONE agent directly — "ти бро роби те": `POST /api/ask {goal, to}`.
   *
   * DELIVERY uses the one mailbox rule and nothing else (spec §22): idle (or failed, which is
   * a fact about a turn, not a tombstone) → a turn starts now carrying the message; executing
   * → it is queued and drained into the prompt at the START of its next turn. Nothing is ever
   * written into a running subprocess's stdin, and there is no second delivery path — a direct
   * human message is the same `Mailbox.send` a `crew_send` from the manager uses.
   *
   * MANAGER VISIBILITY is the part that is easy to get wrong. The manager is the thing that
   * decides who does what; if the human quietly retasks a worker, the manager's plan is stale
   * and its next move may be to assign that same worker something else. So it is told — as a
   * `system` message in its mailbox rather than as an interrupt:
   *
   *   - a mailbox note is PERSISTENT and lands at the top of the manager's next turn prompt,
   *     which is precisely the moment before it decides anything, whereas a bare event is
   *     something the manager can only see if it happens to look;
   *   - it is sent with `wake:false` so a human saying "bro, do X" to a worker does not spend
   *     a whole manager turn (tokens, and a re-plan nobody asked for). The manager reads it
   *     the next time something legitimately wakes it — which is the next time it decides.
   *
   * The autonomous-turn counter is reset (a human IS present, so the "N turns with no human
   * input" guard should not fire on stale credit) but an explicit pause is NOT lifted: the
   * human addressed a worker, not the manager, and silently restarting the manager loop they
   * had deliberately stopped would be Crew inventing an instruction.
   */
  async directMessage(
    agentRef: string,
    text: string,
    opts: { from?: string } = {},
  ): Promise<{ target: CrewAgent; outcome: SendOutcome; managerNotified: boolean }> {
    const body = text.trim();
    if (!body) throw new Error("crew: an empty instruction is not a message");
    const from = opts.from ?? "human";

    const target = await this.deps.store.withState((state) => {
      const found = resolveAgentRef(state.agents, agentRef);
      if (!found.ok) throw agentRefError(agentRef, found);
      const agent = state.agents[found.agent.id];
      if (agent.origin === "observed") {
        throw new ObservedAgentError(agent.name, "given work directly — Crew did not launch it and cannot prompt it");
      }
      if (agent.status === "stopped") {
        throw new StoppedAgentError(agent.name);
      }
      if (from === "human") state.autonomousTurns = 0;
      return structuredClone(agent);
    });

    await this.deps.bus.publish("goal.created", {
      agentId: target.id,
      summary: `${from} → ${target.name}: ${body.slice(0, 140)}`,
      data: { direct: true, to: target.id, toName: target.name, from },
    });

    const state = await this.deps.store.getState();
    const outcome = await this.mailbox.send({
      from,
      to: target.id,
      workspace: state.workspace,
      kind: "message",
      body,
    });

    const manager = findManager(state);
    const managerNotified = Boolean(manager && manager.id !== target.id);
    if (manager && managerNotified) {
      await this.mailbox.send({
        from,
        to: manager.id,
        workspace: state.workspace,
        kind: "system",
        body:
          `DIRECT ASSIGNMENT — the ${from} spoke to ${target.name} (id ${target.id}) without going through you.\n\n` +
          `What was said:\n${body}\n\n` +
          (outcome.delivery === "woken"
            ? `${target.name} was idle, so it started a turn on this immediately.`
            : `${target.name} was busy, so it will read this at the start of its next turn — it is still finishing what it had.`) +
          `\n\nYour plan may be stale. Re-check crew_agents before you delegate anything else, and do NOT assign ` +
          `${target.name} more work on the assumption it is still doing what you last gave it.`,
        // No wake: this is context for the manager's NEXT decision, not a reason to spend a
        // manager turn every time the human speaks to a worker.
        wake: false,
      });
    }

    return { target, outcome, managerNotified };
  }

  // -------------------------------------------------------------------------
  // Cancellation & worktree teardown
  // -------------------------------------------------------------------------

  async cancelAssignment(assignmentId: string): Promise<Assignment> {
    const assignment = await this.assignments.cancel(assignmentId);
    const runId = await this.deps.store.withState((state) => {
      const agent = state.agents[assignment.assignedTo];
      if (agent && agent.currentAssignmentId === assignmentId) {
        delete agent.currentAssignmentId;
        return agent.currentRunId;
      }
      return undefined;
    });
    if (runId && this.deps.cancelRun) await this.deps.cancelRun(runId);
    return assignment;
  }

  /**
   * Remove an assignment's worktree. Refuses while an agent's session is still pinned to it
   * (agent.cwd): a resumed codex turn is spawned from that exact directory, so deleting it
   * would break every future turn of that agent rather than just tidying up.
   */
  async teardownWorktree(assignmentId: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const info = await this.worktreeOf(assignmentId);
    if (!info) return false;
    if (!opts.force) {
      const state = await this.deps.store.getState();
      // "In use" is now two things: an agent still pinned there by cwd, and — since a turn takes
      // its directory from the ASSIGNMENT — an agent currently holding this assignment.
      const pinned = Object.values(state.agents).find(
        (a) => a.status !== "stopped" && (a.cwd === info.path || a.currentAssignmentId === assignmentId),
      );
      if (pinned) {
        throw new Error(
          `crew: ${pinned.name}'s session is pinned to ${info.path} — stop the agent (or pass force) before removing its worktree`,
        );
      }
    }
    await removeWorktree(info, opts);
    this.worktrees.delete(assignmentId);
    /**
     * The checkout is gone, so the pointer to it goes too — otherwise crew_assignment keeps
     * telling a worker to "work THERE" in a directory that no longer exists. The record of the
     * work itself is not lost: the branch survives (spec §29) and the assignment's `result`
     * already carries its name, worktree path and diffstat.
     */
    await this.deps.store.withState((state) => {
      const assignment = state.assignments[assignmentId];
      if (assignment) delete assignment.worktree;
    });
    return true;
  }

  /** Synchronous read for the HTTP/MCP path; the cache behind it is kept warm by worktreeOf(). */
  worktreeFor(assignmentId: string): WorktreeInfo | undefined {
    return this.worktrees.get(assignmentId);
  }

  /**
   * This assignment's worktree, from the ASSIGNMENT — the copy that outlives the daemon that
   * made it. The in-memory cache is refilled on the way past, so the synchronous worktreeFor()
   * above answers correctly after a restart too.
   */
  private async worktreeOf(assignmentId: string): Promise<WorktreeInfo | undefined> {
    const state = await this.deps.store.getState();
    const stored = state.assignments[assignmentId]?.worktree;
    if (stored) {
      this.worktrees.set(assignmentId, stored);
      return stored;
    }
    return this.worktrees.get(assignmentId);
  }

  // -------------------------------------------------------------------------
  // Prompt building — behaviour comes from crew/skills/*/SKILL.md, not from code
  // -------------------------------------------------------------------------

  private async buildTurnPrompt(
    agent: CrewAgent,
    assignment: Assignment | undefined,
    inboxBlock: string,
    extra: string,
  ): Promise<string> {
    const role = agent.role ?? "worker";
    const skill = await this.loadSkill(agent);
    const sections = [
      skill,
      `## You\n\nYou are crew agent "${agent.name}" (id ${agent.id}), role: ${role}, workspace: ${agent.workspace ?? "unfiled"}.` +
        `\nUse your crew_* MCP tools to coordinate; use Docket for the canonical task list.`,
      assignment
        ? `## Current assignment ${assignment.id}\n\n${assignment.title}\n\n${assignment.instructions}` +
          (assignment.docketTodoId ? `\n\nDocket todo: ${assignment.docketTodoId} — claim it before starting, complete or release it when you stop.` : "")
        : "",
      inboxBlock,
      extra,
    ].filter((s) => s.trim());
    return sections.join("\n\n---\n\n");
  }

  /**
   * Resolves the skills this agent should be given: its role skill plus whatever its profile
   * declares (`CrewProfile.skills`), composed across every skill root — see skills.ts.
   *
   * Cached per profile+role rather than per role alone: two profiles sharing a role can
   * declare different skill sets, and keying on the role only would hand the second one the
   * first one's rules.
   */
  private async loadSkill(agent: CrewAgent): Promise<string> {
    const role: CrewRole = agent.role ?? "worker";
    const key = `${agent.profile ?? ""} ${role}`;
    const cached = this.skillCache.get(key);
    if (cached !== undefined) return cached;
    const profile = agent.profile ? this.deps.config.profiles[agent.profile] : undefined;
    const resolved = await resolveSkillsForProfile(
      { role, skills: profile?.skills },
      { crewHomeDir: this.deps.skillsDir },
    );
    // A named-but-missing skill is a config typo the operator has to see; it must not be
    // swallowed, but it must not throw either — that would kill every turn and leave no
    // agent alive to report it. resolveSkillsForProfile also appends a visible notice to the
    // prompt so the agent itself knows its instructions are incomplete.
    if (resolved.hasErrors) {
      for (const d of resolved.diagnostics) {
        if (d.severity === "error") console.warn(`crew: ${d.message}`);
      }
    }
    this.skillCache.set(key, resolved.text);
    return resolved.text;
  }
}

/**
 * An agent tried to select a non-isolated run inside the crew's own workspace repository.
 * The message is written FOR THE MANAGER: it says what was refused, why, and — the part that
 * stops a retry spiral — what it can do instead.
 */
export class NonIsolatedWorkspaceError extends Error {
  constructor(
    readonly repoDir: string,
    targetName: string,
  ) {
    super(
      `crew: isolate:false is not available to agents. Putting ${targetName} in the crew's own workspace ` +
        `(${repoDir}) means it edits the human's real checkout — the tree they are looking at right now — ` +
        `so only the human can choose it (the Office assign form, or DOCKET_CREW_ALLOW_UNISOLATED=1).\n` +
        `What you can do instead:\n` +
        `  1. If isolation was refused because the repository has uncommitted changes, do NOT work around it: ` +
        `say so and wait for the human to commit or stash, then reassign with isolate:true.\n` +
        `  2. Delegate work that does not need this checkout (research, design, reviewing an existing crew/ branch).\n` +
        `  3. Use crew_request_review to have a reviewer inspect work that already exists — that needs no new tree.\n` +
        `Retrying this same call will fail the same way.`,
    );
    this.name = "NonIsolatedWorkspaceError";
  }
}

/**
 * Nobody on the roster answers to that id or name. A distinct type so the HTTP surface can
 * answer 404 (and the MCP tools a readable "call crew_agents") instead of a generic 400 that
 * looks like the caller's JSON was malformed.
 */
export class AgentNotFoundError extends Error {
  constructor(readonly ref: string) {
    super(`crew: no agent "${ref}" — check the roster (crew_agents / the Office) for ids and names`);
    this.name = "AgentNotFoundError";
  }
}

/** Two live agents answer to that name. Uniqueness is enforced at spawn/rename, so this is rare. */
export class AmbiguousAgentError extends Error {
  constructor(
    readonly ref: string,
    readonly matches: CrewAgent[],
  ) {
    super(`crew: "${ref}" matches ${matches.length} agents (${describeMatches(matches)}) — address one by its id`);
    this.name = "AmbiguousAgentError";
  }
}

/** The §17 refusal, as a type: Crew does not own an observed session's identity or its turns. */
export class ObservedAgentError extends Error {
  constructor(agentName: string, what: string) {
    super(`crew: ${agentName} is an observed Docket session and cannot be ${what} (spec §17)`);
    this.name = "ObservedAgentError";
  }
}

export class StoppedAgentError extends Error {
  constructor(agentName: string) {
    super(`crew: ${agentName} is stopped — start an agent before addressing it`);
    this.name = "StoppedAgentError";
  }
}

/** Turn a failed name/id lookup into the right typed error. */
export function agentRefError(ref: string, resolution: AgentRefResolution & { ok: false }): Error {
  return resolution.problem === "ambiguous" ? new AmbiguousAgentError(ref, resolution.matches) : new AgentNotFoundError(ref);
}

export class ConcurrencyLimitError extends Error {
  constructor(limit: number) {
    super(`crew: maxConcurrentRuns limit reached (${limit})`);
    this.name = "ConcurrencyLimitError";
  }
}

/**
 * The agent is mid-turn. A distinct type (same message as before) because "busy" and
 * "the turn failed" must not be confused: a wake that lands on a busy agent is not a lost
 * wake — the mail is queued and drained at the start of its next turn — so it must not spend
 * the wake retry budget or trip the undeliverable alarm.
 */
export class AgentBusyError extends Error {
  constructor(agentName: string) {
    super(`crew: agent ${agentName} is already executing`);
    this.name = "AgentBusyError";
  }
}

/**
 * The crew's manager, INCLUDING one whose last turn failed.
 *
 * `failed` describes a TURN, not the agent: a Crew agent is a state record plus a resumable
 * runtime session, so a manager that hit a rate limit can simply take another turn. Skipping
 * it here used to mean a worker's finished result found no manager and the wake was dropped
 * on the floor, while `manager/start` still reported that very agent as running — a dead end
 * only `agent stop` could clear. A failed manager is recovered in place instead
 * (restartFailedAgent), and a wake that genuinely cannot be delivered is announced loudly.
 */
export function findManager(state: CrewState): CrewAgent | undefined {
  return Object.values(state.agents).find(
    (a) => a.origin === "managed" && a.role === "manager" && a.status !== "stopped",
  );
}

/**
 * Can this agent start a turn right now? `working` cannot (one turn at a time; mail queues
 * for the next one, spec §22) and `starting`/`stopped` cannot. `failed` CAN: its last turn
 * died, which is a fact about that turn, not a tombstone for the agent.
 */
export function canTakeATurn(agent: CrewAgent): boolean {
  return agent.status === "idle" || agent.status === "failed";
}

/**
 * The runtime session this agent may resume IN THIS DIRECTORY — or none.
 *
 * VERIFIED RUNTIME CONSTRAINT (crew/docs/RUNTIME-CONTRACTS.md, probed live): `codex exec resume`
 * accepts neither `--sandbox` nor `-C/--cd`; it uses the spawn cwd, and codex filters resumable
 * sessions BY cwd. A session is therefore bound for life to the directory that created it, and
 * resuming one anywhere else either finds nothing or runs the turn in the wrong tree.
 *
 * That used to be enforced by an unpin step in assign() — which the turn epilogue then undid by
 * writing the old id straight back. Keying sessions by their directory makes the bad state
 * unrepresentable instead: there is no id to hand back for a directory that never created one.
 */
/**
 * A long-lived agent gets one worktree per assignment, so this map is otherwise unbounded — and
 * it is PERSISTED, so it would grow state.json for the life of the crew. Oldest entries go
 * first: a session whose tree was torn down long ago cannot be resumed anyway. Re-inserting an
 * existing key keeps its original position, which is fine — the cap is about size, not recency.
 */
/** Is `child` the same directory as `parent`, or somewhere beneath it? */
function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

const MAX_REMEMBERED_SESSIONS = 20;

function trimSessions(sessions: Record<string, string>): Record<string, string> {
  const keys = Object.keys(sessions);
  if (keys.length <= MAX_REMEMBERED_SESSIONS) return sessions;
  const kept: Record<string, string> = {};
  for (const key of keys.slice(keys.length - MAX_REMEMBERED_SESSIONS)) kept[key] = sessions[key];
  return kept;
}

export function sessionForCwd(agent: CrewAgent, cwd: string): string | undefined {
  const mapped = agent.sessions?.[cwd];
  if (mapped) return mapped;
  /**
   * The flat `nativeSessionId` is what records written before this — and the supervisor's own
   * mid-turn write — leave behind. It describes the agent's pinned cwd, so it is usable only
   * when that IS this directory.
   */
  if (agent.nativeSessionId && (agent.cwd ?? cwd) === cwd) return agent.nativeSessionId;
  return undefined;
}
