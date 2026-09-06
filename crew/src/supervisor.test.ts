import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventBus } from "./events.js";
import { crewPaths, ensureCrewTree } from "./paths.js";
import { OutputBuffers } from "./runtime.js";
import { freshState, StateStore } from "./state.js";
import { OUTPUT_TEXT_MAX, Supervisor } from "./supervisor.js";
import type {
  AgentEvent,
  AgentRuntimeAdapter,
  CrewEvent,
  ResumeTurnInput,
  RuntimeCapabilities,
  RuntimeDetection,
  StartTurnInput,
} from "./types.js";

/**
 * The supervisor's event fidelity (spec §32/§39).
 *
 * The regression this file exists for: agent.output used to carry ONLY `summary`, which is
 * flattened to a single line and cut at 200 characters, so an agent's actual answer — the
 * one thing the human opened the Office to read — was destroyed at emit time and existed
 * nowhere else. Everything below asserts the full text survives, structure intact, from the
 * adapter stream to the event and on to the per-agent buffer behind GET /api/agents/:id.
 */

/** A real markdown reply, well past the old 200-character cut, with structure that one-lining destroys. */
const LONG_REPLY = [
  "Подивився Docket (скоуп: github.com/pasichdev/docket + нерозподілені).",
  "",
  "Відкрито **15** пунктів — 8 у Todo, 7 у Backlog. Жоден зараз не в роботі (`▶working` нема),",
  "тобто ніхто з агентів їх не тримає.",
  "",
  "- `#41` — chat redesign, найбільший ризик",
  "- `#42` — observed-session discovery",
  "- `#43` — agent.output truncation (цей)",
  "",
  "Пропоную почати з #43: без нього не видно, що роблять інші.",
].join("\n");

class ScriptedAdapter implements AgentRuntimeAdapter {
  readonly id = "claude" as const;
  constructor(private readonly script: AgentEvent[]) {}

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

  async *startTurn(_input: StartTurnInput): AsyncIterable<AgentEvent> {
    for (const event of this.script) yield event;
  }

  async *resumeTurn(input: ResumeTurnInput): AsyncIterable<AgentEvent> {
    yield* this.startTurn(input);
  }

  async cancel(): Promise<void> {}
}

async function harness(
  options: { turnIdleTimeoutMs?: number } = {},
): Promise<{ supervisor: Supervisor; bus: EventBus; events: CrewEvent[]; cwd: string; store: StateStore }> {
  const root = await mkdtemp(join(tmpdir(), "crew-supervisor-test-"));
  const paths = crewPaths(root);
  await ensureCrewTree(paths);
  const store = new StateStore(paths.stateFile, () => freshState("test-ws", 0));
  await store.withState((state) => {
    state.agents["claude-1"] = { id: "claude-1", name: "claude manager #1", origin: "managed", status: "idle" };
  });
  const bus = new EventBus(paths.eventsFile);
  const events: CrewEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const supervisor = new Supervisor({
    store,
    bus,
    paths,
    maxConcurrentRuns: 4,
    ...(options.turnIdleTimeoutMs === undefined ? {} : { turnIdleTimeoutMs: options.turnIdleTimeoutMs }),
  });
  return { supervisor, bus, events, cwd: root, store };
}

test("a long multi-line markdown reply survives whole into the agent.output event", async () => {
  const { supervisor, events, cwd } = await harness();
  const adapter = new ScriptedAdapter([
    { type: "session", nativeSessionId: "sess-1" },
    { type: "status", status: "init" },
    { type: "text", text: LONG_REPLY },
    { type: "tool", name: "todo_list" },
    { type: "result", text: LONG_REPLY },
  ]);

  const outcome = await supervisor.runTurn(adapter, "claude-1", { runId: "r1", prompt: "status?", cwd });
  assert.equal(outcome.ok, true);

  const outputs = events.filter((e) => e.type === "agent.output");
  const reply = outputs.find((e) => (e.data as { kind?: string } | undefined)?.kind === "text");
  assert.ok(reply, "no agent.output carried the agent's own text");

  // The bug: this is all the event used to carry.
  assert.ok(reply.summary && reply.summary.length <= 200, "the compact summary must stay compact");
  assert.ok(!reply.summary!.includes("\n"), "the compact summary must stay one line");

  // The fix: the full text, unflattened, un-truncated, un-rendered.
  const data = reply.data as { kind: string; text: string; truncated?: boolean };
  assert.equal(data.text, LONG_REPLY);
  assert.ok(data.text.length > 200, "guard: the fixture must exceed the old cut");
  assert.ok(data.text.includes("\n"), "line structure was flattened away");
  assert.ok(data.text.includes("**15**"), "markdown emphasis was destroyed");
  assert.ok(data.text.includes("`▶working`"), "markdown code span was destroyed");
  assert.equal(data.truncated, undefined);
  // Raw pass-through: escaping and rendering are the Office's job, not this layer's.
  assert.ok(!data.text.includes("&#"), "text was pre-escaped");

  // Mechanics are distinguishable from prose without parsing the summary.
  assert.deepEqual(
    outputs.map((e) => (e.data as { kind?: string } | undefined)?.kind),
    ["status", "text", "tool"],
  );
  const tool = outputs.find((e) => (e.data as { kind?: string } | undefined)?.kind === "tool");
  assert.equal((tool!.data as { tool?: string }).tool, "todo_list");

  // The turn's final answer is on the idle event too, not only one-lined into its summary.
  const idle = events.find((e) => e.type === "agent.idle");
  assert.equal((idle!.data as { kind: string; text: string }).kind, "result");
  assert.equal((idle!.data as { kind: string; text: string }).text, LONG_REPLY);
});

test("the per-agent output buffer keeps the full text and the compact line side by side", async () => {
  const { supervisor, bus, cwd } = await harness();
  const outputs = new OutputBuffers();
  bus.subscribe((event) => outputs.pushEvent(event));

  await supervisor.runTurn(adapterOf([{ type: "text", text: LONG_REPLY }]), "claude-1", {
    runId: "r2",
    prompt: "status?",
    cwd,
  });

  // Legacy shape (`output` in GET /api/agents/:id) is untouched: "<ISO> <summary>".
  const lines = outputs.get("claude-1");
  assert.equal(lines.length, 1);
  const [at, ...rest] = lines[0].split(" ");
  assert.ok(!Number.isNaN(new Date(at).getTime()), "the legacy line must still start with an ISO timestamp");
  assert.ok(rest.join(" ").length <= 200);

  // New shape (`outputEntries`) carries the real reply.
  const entries = outputs.list("claude-1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "text");
  assert.equal(entries[0].text, LONG_REPLY);
  assert.equal(entries[0].summary, lines[0].slice(at.length + 1));
  assert.equal(entries[0].runId, "r2");
});

test("an absurdly long reply is clipped at a documented bound and says so", async () => {
  const { supervisor, events, cwd } = await harness();
  const huge = "x".repeat(OUTPUT_TEXT_MAX * 3);
  await supervisor.runTurn(adapterOf([{ type: "text", text: huge }]), "claude-1", {
    runId: "r3",
    prompt: "dump",
    cwd,
  });
  const data = events.find((e) => e.type === "agent.output")!.data as {
    text: string;
    truncated?: boolean;
    fullLength?: number;
  };
  assert.equal(data.text.length, OUTPUT_TEXT_MAX);
  assert.equal(data.truncated, true);
  assert.equal(data.fullLength, huge.length);
  assert.ok(huge.startsWith(data.text), "the kept text must be a prefix of the original, not a re-render");
});

test("the output ring drops the oldest entries once the per-agent character budget is spent", () => {
  const outputs = new OutputBuffers();
  const big = "y".repeat(OUTPUT_TEXT_MAX);
  for (let i = 0; i < 60; i++) {
    outputs.push("claude-1", { at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, kind: "text", summary: `s${i}`, text: big });
  }
  const entries = outputs.list("claude-1");
  assert.ok(entries.length < 60, "the ring grew without bound");
  assert.ok(entries.length >= 1);
  assert.equal(entries.at(-1)!.summary, "s59", "the newest entry must always survive");
  assert.ok(entries.reduce((n, e) => n + e.text.length, 0) <= 256_000);
});

function adapterOf(script: AgentEvent[]): ScriptedAdapter {
  return new ScriptedAdapter(script);
}

/**
 * Defect B — one fs error on a run log killed the daemon and every child with it.
 *
 * createWriteStream() with no 'error' listener turns EACCES/EISDIR into an uncaught
 * exception; and `active.set()` ran ABOVE the try, so anything that threw between it and the
 * guard (the log stream, the first withState, the first bus.publish) leaked the run slot
 * forever and left run.done unresolved — so cancelRun/stopAll would wait on that run forever.
 */
test("an unwritable run log does not throw, does not leak the run slot, and the turn still runs", async () => {
  const { supervisor, cwd } = await harness();
  const paths = crewPaths(cwd);
  // logs/<runId>.log is a DIRECTORY: createWriteStream emits EISDIR asynchronously.
  await mkdir(join(paths.logsDir, "r-eisdir.log"), { recursive: true });

  const outcome = await supervisor.runTurn(adapterOf([{ type: "result", text: "work done anyway" }]), "claude-1", {
    runId: "r-eisdir",
    prompt: "go",
    cwd,
  });

  assert.equal(outcome.ok, true, "an unloggable run must still be a run");
  assert.equal(outcome.resultText, "work done anyway");
  assert.equal(supervisor.runningCount, 0, "the run slot leaked");
});

test("a state-write failure during startup releases the run slot instead of leaking it", async () => {
  const { supervisor, cwd } = await harness();
  const broken = {
    withState: async () => {
      throw new Error("ENOSPC: no space left on device");
    },
    getState: async () => {
      throw new Error("ENOSPC: no space left on device");
    },
  };
  // Same Supervisor shape, but every state write fails — a full disk, reproduced.
  const failing = new Supervisor({
    store: broken as never,
    bus: (supervisor as unknown as { opts: { bus: EventBus } })["opts"].bus,
    paths: crewPaths(cwd),
    maxConcurrentRuns: 1,
  });

  const outcome = await failing.runTurn(adapterOf([{ type: "result", text: "x" }]), "claude-1", {
    runId: "r-nospc",
    prompt: "go",
    cwd,
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.errorMessage ?? "", /ENOSPC/);
  assert.equal(failing.runningCount, 0, "the run slot leaked — the concurrency budget is gone for good");
  // And the budget is genuinely reusable, which is what "leaked" actually costs.
  const second = await failing.runTurn(adapterOf([{ type: "result", text: "y" }]), "claude-1", {
    runId: "r-nospc-2",
    prompt: "go",
    cwd,
  });
  assert.equal(second.runId, "r-nospc-2");
});

/**
 * Defect C — cancelRun's "bounded wait" was unbounded, so `docket-crew stop` could hang forever.
 *
 * `await run.adapter.cancel(runId)` came first, and RunRegistry.cancel itself awaits the
 * child's exit with no bound, so the withTimeout below it was dead code. Reproduced:
 * cancelRun("r1", 500) was still hanging at 2000 ms.
 */
class NeverStoppingAdapter extends ScriptedAdapter {
  /** Only the test's cleanup ever fires this; nothing the supervisor does can. */
  #release!: () => void;
  readonly stuck = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  constructor() {
    super([]);
  }
  /** Lets the fixture's process exit; the assertions are all made before it is called. */
  release(): void {
    this.#release();
  }
  async *startTurn(): AsyncIterable<AgentEvent> {
    // A child that ignores SIGTERM: the stream does not end when it is told to.
    await this.stuck;
    yield { type: "status", status: "cancelled" };
  }
  async cancel(): Promise<void> {
    // RunRegistry.cancel awaits the child's `done` — which, for this child, does not come.
    await this.stuck;
  }
}

test("cancelRun respects its timeout against a child that never dies", async () => {
  const { supervisor, cwd } = await harness();
  const adapter = new NeverStoppingAdapter();
  const turn = supervisor.runTurn(adapter, "claude-1", { runId: "r-hang", prompt: "go", cwd });
  await new Promise((r) => setTimeout(r, 50));

  const started = Date.now();
  const cancelled = await supervisor.cancelRun("r-hang", 300);
  const elapsed = Date.now() - started;

  assert.equal(cancelled, true);
  assert.ok(elapsed < 2_000, `cancelRun ignored its 300ms bound and took ${elapsed}ms`);
  // The run is STILL going — the bound is what returned, not the child. In production
  // stopAll's SIGKILL sweep ends it; here the fixture does, so the test process can exit.
  assert.equal(supervisor.runningCount, 1);
  adapter.release();
  await turn;
});

test("stopAll cannot be held hostage by one unstoppable run", async () => {
  const { supervisor, cwd } = await harness();
  const adapter = new NeverStoppingAdapter();
  const turn = supervisor.runTurn(adapter, "claude-1", { runId: "r-hang-2", prompt: "go", cwd });
  await new Promise((r) => setTimeout(r, 50));
  const started = Date.now();
  await supervisor.stopAll(300);
  assert.ok(Date.now() - started < 5_000, "stopAll hung on a run that will not end");
  adapter.release();
  await turn;
});

/**
 * Defect D — a cancellation racing a normal completion discarded finished work.
 *
 * `outcome.cancelled = abort.signal.aborted` was evaluated AFTER the stream ended, so an
 * abort landing while a turn finished marked a completed turn cancelled:
 * `{ok:false, cancelled:true, resultText:'real work, finished'}`. Downstream that became
 * `ok:false, error:undefined` — a failed agent, a failed assignment, and a retry of work that
 * was already done.
 */
test("an abort landing as the turn finishes does not discard the finished work", async () => {
  const { supervisor, cwd } = await harness();
  const control = new AbortController();
  const adapter = new (class extends ScriptedAdapter {
    constructor() {
      super([]);
    }
    async *startTurn(): AsyncIterable<AgentEvent> {
      yield { type: "result", text: "real work, finished" };
      // The stop arrives exactly as the stream ends — the race, made deterministic.
      control.abort();
    }
  })();

  const outcome = await supervisor.runTurn(adapter, "claude-1", {
    runId: "r-race",
    prompt: "go",
    cwd,
    signal: control.signal,
  });

  assert.equal(outcome.resultText, "real work, finished");
  assert.equal(outcome.cancelled, false, "a turn that already produced its result was not cancelled by anything");
  assert.equal(outcome.ok, true, "finished work was thrown away and will be retried");
});

test("a genuine cancellation is still reported as cancelled, not as a failure", async () => {
  const { supervisor, events, cwd } = await harness();
  const control = new AbortController();
  const adapter = new (class extends ScriptedAdapter {
    constructor() {
      super([]);
    }
    async *startTurn(input: StartTurnInput): AsyncIterable<AgentEvent> {
      yield { type: "text", text: "thinking" };
      // An already-aborted signal never fires "abort" — check before waiting for it.
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) return resolve();
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "status", status: "cancelled" };
    }
  })();

  const turn = supervisor.runTurn(adapter, "claude-1", { runId: "r-cancel", prompt: "go", cwd, signal: control.signal });
  await new Promise((r) => setTimeout(r, 30));
  control.abort();
  const outcome = await turn;

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.resultText, undefined);
  assert.ok(events.some((e) => e.type === "agent.stopped"), "a cancelled run must not be reported as failed");
});

// ---------------------------------------------------------------------------
// Defect 11 — nothing bounded a turn, so a wedged runtime pinned an agent forever
// ---------------------------------------------------------------------------

/**
 * A runtime that says one thing and then goes silent FOREVER without exiting: no more events,
 * no `close`, no `error`. That is the whole defect — `runTurnProcess` ends only on the child's
 * close/error, and `runTurn` had no watchdog, so the agent stayed `working` for the life of
 * the daemon, holding a maxConcurrentRuns slot, with its mailbox never draining.
 */
class WedgedAdapter extends ScriptedAdapter {
  cancelCalled = false;
  abortSeen = false;
  #release!: () => void;
  readonly stuck = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  constructor() {
    super([]);
  }
  /** Only the fixture's cleanup calls this — nothing the supervisor does can end this stream. */
  release(): void {
    this.#release();
  }
  async *startTurn(input: StartTurnInput): AsyncIterable<AgentEvent> {
    input.signal?.addEventListener("abort", () => (this.abortSeen = true), { once: true });
    yield { type: "status", status: "init" };
    await this.stuck;
    yield { type: "status", status: "never reached" };
  }
  async cancel(): Promise<void> {
    this.cancelCalled = true;
  }
}

/** Resolves to "HUNG" if `promise` has not settled within `ms` — so a red test fails, not hangs. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | "HUNG"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<"HUNG">((r) => (timer = setTimeout(() => r("HUNG"), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

test("a wedged runtime is killed by the idle watchdog instead of pinning the agent forever", async () => {
  const { supervisor, events, cwd, store } = await harness({ turnIdleTimeoutMs: 120 });
  const adapter = new WedgedAdapter();

  const outcome = await within(supervisor.runTurn(adapter, "claude-1", { runId: "r-wedge", prompt: "go", cwd }), 4_000);
  assert.notEqual(outcome, "HUNG", "runTurn never returned — a wedged runtime still pins the agent forever");
  assert.notEqual(outcome, "HUNG");
  if (outcome === "HUNG") return;

  // It is a failure with a KNOWN CAUSE, not a cancellation: the watchdog aborts the run, and
  // the supervisor's abort latch would otherwise report `cancelled` — which downstream means
  // "a human stopped this on purpose", i.e. no retry, no manager wake, nothing surfaced.
  assert.equal(outcome.ok, false);
  assert.equal(outcome.cancelled, false, "a watchdog kill must never look like a deliberate stop");
  assert.match(outcome.errorMessage ?? "", /timed out/i, "the reason must say the budget was exceeded");
  assert.match(outcome.errorMessage ?? "", /\d+s/, "and must carry the elapsed time");

  // Nothing may be left pinned.
  assert.equal(supervisor.runningCount, 0, "the maxConcurrentRuns slot was not released");
  assert.equal(adapter.abortSeen, true, "the child was never actually told to die");
  assert.equal(adapter.cancelCalled, true, "the existing cancellation path was not reused");
  const agent = (await store.getState()).agents["claude-1"];
  assert.notEqual(agent.status, "working", "the agent is still marked working after its turn was killed");

  // And the human is told WHY, at the moment it happens, with the elapsed time.
  const killed = events.find((e) => (e.data as { timedOut?: boolean } | undefined)?.timedOut === true);
  assert.ok(killed, "no event said the turn was killed for exceeding its budget");
  assert.match(killed.summary ?? "", /timed out/i);

  adapter.release();
});

test("the watchdog measures SILENCE, not total time — a slow but talking turn is never killed", async () => {
  /**
   * The option most likely to kill good work is a naive wall-clock cap: real turns here take
   * 20-60s and a big codex assignment runs for minutes. This turn runs far longer than the
   * timeout but never goes quiet for it, and must finish normally.
   */
  const { supervisor, cwd } = await harness({ turnIdleTimeoutMs: 150 });
  const adapter = new (class extends ScriptedAdapter {
    constructor() {
      super([]);
    }
    async *startTurn(): AsyncIterable<AgentEvent> {
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 40));
        yield { type: "tool", name: `step-${i}` };
      }
      yield { type: "result", text: "long but alive" };
    }
  })();

  const started = Date.now();
  const outcome = await within(supervisor.runTurn(adapter, "claude-1", { runId: "r-slow", prompt: "go", cwd }), 8_000);
  assert.notEqual(outcome, "HUNG");
  if (outcome === "HUNG") return;
  assert.ok(Date.now() - started > 150, "the fixture did not actually outrun the timeout");
  assert.equal(outcome.ok, true, `a talking turn was killed anyway: ${outcome.errorMessage}`);
  assert.equal(outcome.resultText, "long but alive");
});

test("turnIdleTimeoutMs: 0 disables the watchdog rather than killing every turn instantly", async () => {
  const { supervisor, cwd } = await harness({ turnIdleTimeoutMs: 0 });
  const adapter = new (class extends ScriptedAdapter {
    constructor() {
      super([]);
    }
    async *startTurn(): AsyncIterable<AgentEvent> {
      await new Promise((r) => setTimeout(r, 60));
      yield { type: "result", text: "fine" };
    }
  })();
  const outcome = await within(supervisor.runTurn(adapter, "claude-1", { runId: "r-off", prompt: "go", cwd }), 4_000);
  assert.notEqual(outcome, "HUNG");
  if (outcome === "HUNG") return;
  assert.equal(outcome.ok, true);
});

test("a turn that already produced its result is not retroactively failed by the watchdog", async () => {
  /**
   * Same doctrine as the cancellation latch above: killing a child that has already answered
   * kills nothing. The work stands; only the process is killed, and the human is still told.
   */
  const { supervisor, events, cwd } = await harness({ turnIdleTimeoutMs: 120 });
  const adapter = new (class extends WedgedAdapter {
    async *startTurn(input: StartTurnInput): AsyncIterable<AgentEvent> {
      input.signal?.addEventListener("abort", () => (this.abortSeen = true), { once: true });
      yield { type: "result", text: "real work, finished" };
      await this.stuck; // …and then the child hangs instead of exiting
    }
  })();

  const outcome = await within(supervisor.runTurn(adapter, "claude-1", { runId: "r-done-hang", prompt: "go", cwd }), 4_000);
  assert.notEqual(outcome, "HUNG");
  if (outcome === "HUNG") return;
  assert.equal(outcome.ok, true, "finished work was thrown away because the child would not exit");
  assert.equal(outcome.resultText, "real work, finished");
  assert.equal(outcome.cancelled, false);
  assert.ok(
    events.some((e) => (e.data as { timedOut?: boolean } | undefined)?.timedOut === true),
    "the kill itself must still be reported even when the work stands",
  );
  adapter.release();
});
