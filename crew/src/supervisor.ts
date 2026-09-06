import { execFile } from "node:child_process";
import { constants, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EventBus } from "./events.js";
import { assertInsideRoot, type CrewPaths } from "./paths.js";
import type { StateStore } from "./state.js";
import type { AgentEvent, AgentRuntimeAdapter, StartTurnInput } from "./types.js";

/**
 * Process supervision (spec §30).
 *
 * The supervisor is deliberately adapter-agnostic: it receives an AgentRuntimeAdapter (the
 * concrete ones live in crew/src/adapters/* and are never imported here — the layers stay
 * decoupled) and drives one turn through it, translating the adapter's normalized
 * AgentEvent stream into CrewEvents, persisting the native session id the moment it
 * appears, and logging the raw stream under logs/<runId>.log.
 *
 * Cancellation is a contract, not a hope: cancelRun() tells the adapter to kill its child
 * AND aborts the shared AbortSignal, then waits for the event stream to actually end.
 * stopAll() additionally sweeps every process descendant of this daemon and SIGKILLs
 * stragglers — `docket-crew stop` must leave zero Crew-owned children (spec §30), including
 * ones a misbehaving runtime left behind.
 */

const execFileP = promisify(execFile);

export class MaxConcurrentRunsError extends Error {
  constructor(limit: number) {
    super(`crew: maxConcurrentRuns (${limit}) reached — refuse to start another run`);
    this.name = "MaxConcurrentRunsError";
  }
}

export interface TurnOutcome {
  runId: string;
  agentId: string;
  ok: boolean;
  cancelled: boolean;
  /** Final result text, when the runtime produced one. Absent on failure/cancel. */
  resultText?: string;
  errorMessage?: string;
  nativeSessionId?: string;
}

interface ActiveRun {
  runId: string;
  agentId: string;
  adapter: AgentRuntimeAdapter;
  abort: AbortController;
  done: Promise<void>;
  finish: () => void;
}

export interface SupervisorOptions {
  store: StateStore;
  bus: EventBus;
  paths: CrewPaths;
  maxConcurrentRuns: number;
  /**
   * The SILENCE budget of one turn, in milliseconds. See DEFAULT_TURN_IDLE_TIMEOUT_MS.
   * Optional so a Supervisor built without it is still protected; 0 disables the watchdog.
   */
  turnIdleTimeoutMs?: number;
}

/**
 * How long a turn may produce NO AgentEvent at all before the supervisor kills it.
 *
 * Deliberately generous, and deliberately a SILENCE bound rather than a wall-clock one.
 *
 * Why silence: a turn that is streaming text, tool calls and status every few seconds is
 * alive at minute ten and killing it destroys real work; a turn that has said nothing for ten
 * minutes is wedged regardless of how long it has been running. Real turns in this project
 * take 20-60s and a large codex assignment runs for minutes — a naive wall-clock cap is the
 * option most likely to kill good work, so there deliberately is not one. (The case this does
 * not catch is a runtime that chatters forever without finishing; that is a livelock, visible
 * in the feed, and a human or `crew_cancel` can end it — unlike a silent wedge, which is
 * invisible and ends nothing.)
 *
 * Why ten minutes: the longest legitimate silence is one model response that streams nothing
 * until it is complete, which is minutes at the very worst. Ten minutes of ZERO events is not
 * a slow turn; it is a runtime that is never coming back, and until this existed it held its
 * agent at `working`, its mailbox undrained and a maxConcurrentRuns slot occupied, for the
 * life of the daemon.
 */
export const DEFAULT_TURN_IDLE_TIMEOUT_MS = 600_000;

const SUMMARY_MAX = 200;

/**
 * `summary` is the COMPACT line — flattened to one line and clipped — for anything that
 * renders a single row (Team Feed, thought bubbles, `docket-crew` CLI output). It is a
 * lossy derivative and always has been; the mistake was that it used to be the ONLY thing
 * an agent.output event carried, so an agent's actual answer was destroyed at emit time and
 * survived nowhere. Every emitter below now pairs it with the full text in `data` (see
 * outputData) — same event, two fidelities, callers pick.
 */
function summarize(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > SUMMARY_MAX ? oneLine.slice(0, SUMMARY_MAX - 1) + "…" : oneLine;
}

/**
 * Upper bound on the full text carried inside a CrewEvent.
 *
 * Deliberately generous — 8000 characters is roughly 1200 words, i.e. a complete manager
 * turn with a formatted list in it, forty times the old 200-character cut. It is still a
 * bound, because a CrewEvent is written to events.jsonl (which EventBus.readRecent reads
 * whole, on every /api/events call) and pushed down every open SSE socket, so one agent
 * that decides to echo a 2 MB file must not be able to bloat the log or the stream.
 *
 * The log and the live stream share this one limit on purpose: events.ts persists and then
 * fans out the SAME object, and "the Team Feed's history and its live stream are the same
 * log" is the invariant that file is built on. Nothing is truly lost either way — the raw,
 * uncapped adapter stream is already written verbatim to logs/<runId>.log by runTurn below,
 * so a clipped event is a rendering bound, not the end of the evidence.
 */
export const OUTPUT_TEXT_MAX = 8_000;

/**
 * The `data` payload of an agent-visible event: the text as the runtime produced it —
 * newlines, markdown, indentation intact — plus what kind of output it is.
 *
 * `kind` exists so a UI can separate an agent's actual prose from the mechanics around it:
 *   text   — the agent's own reply. This is what a human wants to read.
 *   result — the turn's final result text (same channel, end of turn).
 *   status — runtime lifecycle noise ("init").
 *   tool   — "used <tool>" bookkeeping; `tool` carries the bare tool name.
 *   error  — the failure text of a turn that ended badly.
 *
 * The text is passed through RAW: no escaping, no markdown rendering, no re-wrapping. The
 * renderer owns presentation and the Office owns escaping (office/client/render.ts) — doing
 * any of it here would corrupt the record for every other consumer.
 */
export type AgentOutputKind = "text" | "result" | "status" | "tool" | "error";

export interface AgentOutputData extends Record<string, unknown> {
  kind: AgentOutputKind;
  /** Full text, unflattened, clipped to OUTPUT_TEXT_MAX. A prefix of the original, never decorated. */
  text: string;
  /** Present only when the text was clipped, with the original length, so a UI can say so. */
  truncated?: true;
  fullLength?: number;
}

function outputData(kind: AgentOutputKind, text: string): AgentOutputData {
  const full = text ?? "";
  if (full.length <= OUTPUT_TEXT_MAX) return { kind, text: full };
  return { kind, text: full.slice(0, OUTPUT_TEXT_MAX), truncated: true, fullLength: full.length };
}

export class Supervisor {
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly opts: SupervisorOptions) {}

  get runningCount(): number {
    return this.active.size;
  }

  activeRunIds(): string[] {
    return [...this.active.keys()];
  }

  /**
   * Run one turn of `agentId` through `adapter`. Resolves with the outcome when the
   * runtime's event stream ends (successfully, with an error, or because it was cancelled).
   * The adapter's own errors surface as a failed outcome, not a throw — only misuse
   * (concurrency limit, duplicate runId) throws.
   */
  async runTurn(
    adapter: AgentRuntimeAdapter,
    agentId: string,
    input: StartTurnInput,
    resumeSessionId?: string,
    /**
     * When the ORCHESTRATOR drives the turn it already owns the agent's status transitions
     * and the agent.started/idle/failed events (it knows about assignments, which this
     * layer deliberately does not). Passing `publishLifecycle:false` keeps the supervisor's
     * real jobs — spawning, log capture, mid-turn nativeSessionId persistence, cancellation
     * — without emitting a duplicate of every lifecycle event into the Office feed.
     * Defaults to true so a direct caller still gets the full behaviour.
     */
    options: { publishLifecycle?: boolean } = {},
  ): Promise<TurnOutcome> {
    const publishLifecycle = options.publishLifecycle ?? true;
    const { store, bus, paths, maxConcurrentRuns } = this.opts;
    if (this.active.size >= maxConcurrentRuns) throw new MaxConcurrentRunsError(maxConcurrentRuns);
    if (this.active.has(input.runId)) throw new Error(`crew: run ${input.runId} is already active`);

    const abort = new AbortController();
    /**
     * Cancellation is LATCHED here, at the moment the abort lands, rather than sampled from
     * `abort.signal.aborted` after the stream has ended.
     *
     * The bug that shape caused: an abort arriving while a turn was finishing marked a
     * COMPLETED turn cancelled — `{ok:false, cancelled:true, resultText:"real work, finished"}`
     * — which downstream became `ok:false, error:undefined`, a failed agent, and a failed
     * assignment that then got retried. Real, finished work thrown away by a race.
     */
    let streamEnded = false;
    let abortedWhileStreaming = false;
    const latchAbort = () => {
      if (!streamEnded) abortedWhileStreaming = true;
    };
    if (abort.signal.aborted) latchAbort();
    else abort.signal.addEventListener("abort", latchAbort, { once: true });
    if (input.signal) {
      if (input.signal.aborted) abort.abort();
      else input.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }
    let finish!: () => void;
    const done = new Promise<void>((resolvePromise) => (finish = resolvePromise));
    const run: ActiveRun = { runId: input.runId, agentId, adapter, abort, done, finish };

    const outcome: TurnOutcome = { runId: input.runId, agentId, ok: false, cancelled: false };
    let log: WriteStream | undefined;
    /**
     * Set by the silence watchdog below, and read by the outcome computation AFTER the stream
     * block — the watchdog's own kill goes through cancelRun, so `abortedWhileStreaming` will be
     * true and the latch above would otherwise report a wedged runtime as a deliberate
     * cancellation: no retry, no manager wake, a permanent stall reported as a human's choice.
     */
    let timedOut = false;

    /**
     * Everything from the moment the run slot is claimed lives inside this try/finally.
     *
     * `active.set` used to sit ABOVE the try, with the log stream, the first `withState` and
     * the first `bus.publish` between it and the guard — so an unwritable logs/ or a full disk
     * threw out of runTurn with the slot still occupied and `run.done` never resolved: the
     * concurrency budget leaked permanently and cancelRun/stopAll would wait on that run
     * forever. A setup failure is now just a failed outcome, like any other.
     */
    this.active.set(input.runId, run);
    try {
      // Raw runtime output log. runId comes from our own id generator, but guard the derived
      // path anyway — nothing may escape the crew root.
      const logPath = assertInsideRoot(paths, join(paths.logsDir, `${input.runId.replace(/[^A-Za-z0-9._-]/g, "_")}.log`));
      /**
       * O_NOFOLLOW, same class as the events.jsonl append: this log holds the turn's raw
       * runtime output, and 'a' alone would happily write it through a symlink an agent
       * planted in logs/. An unwritable log already degrades gracefully (the 'error' handler
       * below), so refusing the link costs nothing.
       */
      const APPEND_NOFOLLOW = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
      // Node accepts a numeric flag mask here; @types/node only spells the string form.
      log = createWriteStream(logPath, { flags: APPEND_NOFOLLOW as unknown as string, mode: 0o600 });
      /**
       * A WriteStream with no 'error' listener turns any fs error into an uncaught exception
       * — and an uncaught exception in the daemon kills supervision of every running agent and
       * orphans their children. An unwritable run log degrades the record, nothing more.
       */
      let logBroken: string | null = null;
      log.on("error", (err: Error) => {
        if (logBroken) return;
        logBroken = err.message;
        console.error(`crew: run log ${logPath} is unwritable: ${err.message} — the run continues, unlogged`);
      });
      const logLine = (line: string) => {
        if (logBroken) return;
        try {
          log!.write(line.endsWith("\n") ? line : line + "\n");
        } catch {
          logBroken = "write failed";
        }
      };

      const startedAt = new Date().toISOString();
      if (publishLifecycle) {
        await store.withState((state) => {
          const agent = state.agents[agentId];
          if (agent) {
            agent.status = "working";
            agent.currentRunId = input.runId;
            agent.cwd = input.cwd;
            agent.startedAt = startedAt;
            agent.lastSeenAt = startedAt;
          }
        });
        await bus.publish("agent.started", {
          agentId,
          runId: input.runId,
          summary: `${agentId} started a ${resumeSessionId ? "resumed " : ""}turn in ${input.cwd}`,
          data: { cwd: input.cwd, resumed: Boolean(resumeSessionId) },
        });
      }

      logLine(`# crew run ${input.runId} agent=${agentId} adapter=${adapter.id} started=${startedAt}`);

      // lastSeenAt is a liveness hint, not a ledger — throttle it so a chatty runtime
      // doesn't turn every streamed token into a state.json rewrite.
      let lastTouch = 0;
      const touchAgent = async () => {
        const now = Date.now();
        if (now - lastTouch < 5_000) return;
        lastTouch = now;
        await store.withState((state) => {
          const agent = state.agents[agentId];
          if (agent) agent.lastSeenAt = new Date().toISOString();
        });
      };

      /**
       * The silence watchdog. Rearmed by EVERY AgentEvent — a `tool` or a `status` proves the
       * runtime is alive just as well as prose does — and, when it fires, it makes the turn
       * stop WAITING on the stream. That last part is the point: a wedged child never emits
       * `close`, so `for await` would never return however hard we killed it, and everything
       * downstream (the run slot, the in-flight map, the mailbox restore, the run log) would
       * stay pinned behind it.
       */
      const idleMs = this.opts.turnIdleTimeoutMs ?? DEFAULT_TURN_IDLE_TIMEOUT_MS;
      const turnStartedMs = Date.now();
      let idleTimer: NodeJS.Timeout | undefined;
      let tripIdle!: () => void;
      const idleTripped = new Promise<void>((resolve) => (tripIdle = resolve));
      const armIdle = (): void => {
        if (idleMs <= 0 || timedOut) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          timedOut = true;
          tripIdle();
        }, idleMs);
      };

      try {
        const turnInput = { ...input, signal: abort.signal };
        const stream: AsyncIterable<AgentEvent> = resumeSessionId
          ? adapter.resumeTurn({ ...turnInput, nativeSessionId: resumeSessionId })
          : adapter.startTurn(turnInput);

        armIdle();
        const consume = (async () => {
          for await (const event of stream) {
            // Abandoned by the watchdog: `break` runs the generator's own finally, which is
            // where runTurnProcess kills a child the consumer stopped reading (adapters/common).
            if (timedOut) break;
            armIdle();
            logLine(JSON.stringify(event));
            await this.handleEvent(event, { agentId, runId: input.runId, outcome, store, bus });
            await touchAgent();
          }
        })();
        /**
         * Whichever comes first. A normal turn resolves `consume` and the timer is cleared
         * below; a wedged one resolves `idleTripped` and we walk away from `consume`, which is
         * left holding a stream nobody reads any more.
         */
        await Promise.race([consume, idleTripped]);
        // A rejection from an abandoned consume must not become an unhandled rejection.
        void consume.catch(() => {});
      } catch (err) {
        if (!abort.signal.aborted) {
          outcome.errorMessage = outcome.errorMessage ?? (err as Error).message;
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }

      if (timedOut) {
        const elapsedMs = Date.now() - turnStartedMs;
        /**
         * The work may well be real: a killed turn can already have edited files in its
         * worktree. So this says what CREW did (killed a process that stopped talking) and
         * refuses to say anything about the task — the assignment's own result carries the
         * branch and the diffstat, and that is what a human or the manager judges.
         */
        const note =
          `crew killed this turn after ${seconds(elapsedMs)}: the runtime produced no output for ` +
          `${seconds(idleMs)} (automation.turnIdleTimeoutMs) and never exited, so it timed out. ` +
          `This is a verdict on the PROCESS, not on the work — anything it already changed is still ` +
          `in its worktree; check the diff before deciding.`;
        logLine(`# crew run ${input.runId} timed out: idle > ${idleMs}ms, elapsed ${elapsedMs}ms`);
        /**
         * Reuse the real cancellation path rather than a second, weaker kill: it aborts the
         * shared signal AND asks the adapter to kill the child's whole process group, racing
         * both against a deadline. Not awaited — this turn is over either way, and waiting on
         * a child that ignores signals is the pinning this whole change exists to end.
         */
        void this.cancelRun(input.runId).catch(() => {});
        /**
         * Said on the bus HERE, unconditionally, because the orchestrator drives turns with
         * publishLifecycle:false — without this the human would never learn that the process
         * was killed, only that something "failed". Carried as event data too, so the Office
         * can render it as what it is rather than parsing prose.
         */
        await bus
          .publish("agent.output", {
            agentId,
            runId: input.runId,
            summary: summarize(note),
            data: { ...outputData("error", note), timedOut: true, idleTimeoutMs: idleMs, elapsedMs },
          })
          .catch(() => {});
        /**
         * A turn that had already produced its result answered the question; killing the child
         * afterwards kills nothing (the same doctrine as the abort latch above), so its work is
         * not thrown away and re-run. Anything else is a genuine failure WITH A KNOWN CAUSE —
         * `ok:false, cancelled:false` — so §45 retries it and the manager is told, which a
         * `cancelled` outcome would silently prevent.
         */
        const answered = outcome.resultText !== undefined && outcome.errorMessage === undefined;
        if (!answered) {
          const prior = outcome.errorMessage;
          outcome.errorMessage = prior ? `${note} (its last error before going quiet: ${prior})` : note;
        }
      }
    } catch (err) {
      // Setup or lifecycle-publish failure (unwritable logs/, unwritable state.json, ...).
      // Reported as a failed turn rather than thrown: the caller's run slot must be released.
      outcome.errorMessage = outcome.errorMessage ?? (err as Error).message;
    } finally {
      streamEnded = true;
      try {
        log?.end(`# crew run ${input.runId} ended=${new Date().toISOString()}\n`);
      } catch {
        // the stream's own 'error' handler already reported it; nothing more to do
      }
      this.active.delete(input.runId);
      finish();
    }

    /**
     * A turn that produced a result and no error DID the work, whatever landed on the abort
     * signal a moment later — cancelling something that has already finished cancels nothing.
     */
    const producedWork = outcome.resultText !== undefined && outcome.errorMessage === undefined;
    /**
     * `!timedOut` is load-bearing. The watchdog kills by aborting, so the latch above sees the
     * abort and this would otherwise read `cancelled: true` — and `cancelled` means "a human or
     * the crew stopped this deliberately": terminal, no retry, no manager wake. A wedged
     * runtime would look exactly like a click on Cancel. A timeout is a FAILURE WITH A KNOWN
     * CAUSE, and it stays on the `ok:false, cancelled:false` path so it is treated as one.
     */
    outcome.cancelled = !timedOut && abortedWhileStreaming && !producedWork;
    outcome.ok = !outcome.cancelled && outcome.errorMessage === undefined;

    if (!publishLifecycle) return outcome;

    const endedAt = new Date().toISOString();
    /**
     * Recording the END of a turn must not be able to destroy the turn's outcome.
     *
     * If state.json cannot be written (full disk, read-only mount) this used to throw out of
     * runTurn AFTER the run had completed: the caller lost a finished result and the
     * orchestrator's `track()` swallowed the rejection into an empty catch — because the
     * failure event could not be written either. The write failure is real and is now shouted
     * where a human will see it, while the outcome still reaches the caller.
     */
    try {
      await store.withState((state) => {
        const agent = state.agents[agentId];
        if (!agent) return;
        agent.status = outcome.cancelled ? "stopped" : outcome.ok ? "idle" : "failed";
        agent.lastSeenAt = endedAt;
        delete agent.currentRunId;
        delete agent.pid;
      });
    } catch (err) {
      console.error(
        `crew: could not record the end of run ${input.runId} (agent ${agentId}): ${(err as Error).message} — ` +
          `the agent's stored status is now STALE, but the turn itself finished and its outcome stands.`,
      );
    }
    if (outcome.cancelled) {
      await bus.publish("agent.stopped", { agentId, runId: input.runId, summary: `${agentId} run cancelled` });
    } else if (outcome.ok) {
      await bus.publish("agent.idle", {
        agentId,
        runId: input.runId,
        summary: outcome.resultText ? summarize(outcome.resultText) : `${agentId} finished its turn`,
        // The final answer of the turn, whole. The summary above is the same text one-lined.
        ...(outcome.resultText ? { data: outputData("result", outcome.resultText) } : {}),
      });
    } else {
      const message = outcome.errorMessage ?? "runtime stream ended with an error";
      await bus.publish("agent.failed", {
        agentId,
        runId: input.runId,
        summary: summarize(`${agentId} failed: ${message}`),
        data: outputData("error", message),
      });
    }
    return outcome;
  }

  /**
   * One AgentEvent → state, bus and outcome. Lifted out of the stream loop unchanged, so the
   * loop itself is small enough to see the watchdog's `break` in.
   */
  private async handleEvent(
    event: AgentEvent,
    ctx: { agentId: string; runId: string; outcome: TurnOutcome; store: StateStore; bus: EventBus },
  ): Promise<void> {
    const { agentId, runId, outcome, store, bus } = ctx;
    switch (event.type) {
      case "session": {
        outcome.nativeSessionId = event.nativeSessionId;
        // Persist immediately, not at turn end: a crash mid-turn must still leave the
        // session resumable (spec §46).
        await store.withState((state) => {
          const agent = state.agents[agentId];
          if (agent) agent.nativeSessionId = event.nativeSessionId;
        });
        break;
      }
      case "text":
      case "status": {
        const raw = event.type === "text" ? event.text : event.status;
        await bus.publish("agent.output", {
          agentId,
          runId,
          summary: summarize(raw),
          data: outputData(event.type === "text" ? "text" : "status", raw),
        });
        break;
      }
      case "tool": {
        const line = `${agentId} used ${event.name}`;
        await bus.publish("agent.output", {
          agentId,
          runId,
          summary: line,
          // `tool` stays where it was — this event's data is additive, not reshaped.
          data: { ...outputData("tool", line), tool: event.name },
        });
        break;
      }
      case "result":
        outcome.resultText = event.text;
        break;
      case "error":
        outcome.errorMessage = event.message;
        break;
    }
  }

  /**
   * Cancel one run: abort the shared signal, ask the adapter to kill its child, and wait —
   * genuinely bounded — for both. Returns false for an unknown runId.
   *
   * The bound used to be a lie. `await run.adapter.cancel(runId)` came FIRST and
   * RunRegistry.cancel itself awaits the child's `done` with no timeout, so the
   * `withTimeout(run.done, …)` underneath was dead code: `cancelRun("r1", 500)` was still
   * hanging at 2 s against a child that ignores SIGTERM. Everything above it hung with it —
   * `docket-crew stop`, and `stopAgent`/`cancelAgentRun` as HTTP requests that simply never
   * answer. Both waits are raced against the SAME deadline now, and a run that outlives it is
   * reported rather than waited on: stopAll's SIGTERM→SIGKILL sweep is what finishes the job.
   */
  async cancelRun(runId: string, timeoutMs = 10_000): Promise<boolean> {
    const run = this.active.get(runId);
    if (!run) return false;
    run.abort.abort();
    const settled = Promise.allSettled([run.adapter.cancel(runId), run.done]).then(() => undefined);
    const finished = await withTimeout(settled, timeoutMs);
    if (!finished) {
      console.error(
        `crew: run ${runId} (agent ${run.agentId}) did not stop within ${timeoutMs}ms — ` +
          `leaving it to the shutdown sweep rather than waiting on it`,
      );
    }
    return true;
  }

  /**
   * Shutdown: cancel everything, wait for the streams to die, then hunt down every process
   * that is still a descendant of this daemon and SIGTERM→SIGKILL it. Descendants — not the
   * whole process group — because in foreground/test mode the daemon shares its group with
   * the shell that launched it, and "stop the crew" must never kill the user's terminal.
   * In detached daemon mode (docket-crew start) the daemon leads its own group, so its
   * descendants ARE the whole Crew-owned group.
   */
  async stopAll(timeoutMs = 10_000): Promise<{ cancelledRuns: string[]; killedPids: number[]; survivors: number[] }> {
    const cancelledRuns = this.activeRunIds();
    await Promise.all(cancelledRuns.map((runId) => this.cancelRun(runId, timeoutMs)));

    const killedPids: number[] = [];
    let survivors = await listDescendantPids(process.pid);
    for (const pid of survivors) safeKill(pid, "SIGTERM");
    if (survivors.length > 0) {
      await sleep(1_500);
      survivors = await listDescendantPids(process.pid);
      for (const pid of survivors) {
        safeKill(pid, "SIGKILL");
        killedPids.push(pid);
      }
      await sleep(200);
      survivors = await listDescendantPids(process.pid);
    }
    return { cancelledRuns, killedPids, survivors };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** "94s" / "12m 30s" — the elapsed time as a human reads it, for the timeout message. */
function seconds(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 120) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** Resolves true when `promise` won the race, false when the deadline did. Never rejects. */
async function withTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, or not ours — either way nothing to do.
  }
}

/**
 * Every live descendant of `rootPid`, found by walking `pgrep -P` breadth-first. Exported
 * for the CLI's post-stop verification. macOS and Linux both ship pgrep; if it is missing
 * the sweep degrades to "nothing found" rather than failing shutdown.
 */
export async function listDescendantPids(rootPid: number): Promise<number[]> {
  const found: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>(queue);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    let stdout = "";
    try {
      ({ stdout } = await execFileP("pgrep", ["-P", String(pid)], { encoding: "utf8" }));
    } catch {
      continue; // pgrep exits 1 when there are no children
    }
    for (const line of stdout.split("\n")) {
      const child = Number.parseInt(line.trim(), 10);
      if (!Number.isFinite(child) || seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}
