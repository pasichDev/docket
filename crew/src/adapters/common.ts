/**
 * Shared plumbing for the runtime adapters: defensive JSONL extraction, child-process turn
 * execution, cancellation bookkeeping, and binary probing.
 *
 * Everything here is runtime-agnostic. Knowledge of what `claude`/`codex`/`opencode` actually
 * emit lives in the sibling adapter modules (spec §6) and in crew/docs/RUNTIME-CONTRACTS.md.
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { access, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { AgentEvent, RuntimeCapabilities, RuntimeDetection, RuntimeId } from "../types.js";

// ---------------------------------------------------------------------------
// argv safety
// ---------------------------------------------------------------------------

/**
 * A prompt whose first character is `-` is ARGV, not text — to every one of the three CLIs.
 *
 * VERIFIED 2026-09-06 against the real binaries, not assumed:
 *
 *   claude 2.1.259   `-p` takes an OPTIONAL commander value, so `claude -p "---\nname: …"`
 *                    answers `error: unknown option '---…'` and never runs a turn.
 *   codex 0.151.0    `codex exec … "-hello"` prints the usage dump; `codex exec … -- "-hello"`
 *                    gets through to the next real step. A prompt of exactly `-` additionally
 *                    means "read the prompt from stdin", which runTurnProcess closes.
 *   opencode 1.18.26 same on both counts.
 *
 * This is not hypothetical: a role prompt that opens with a SKILL.md's YAML frontmatter starts
 * with `---`. Today's prompt layout happens to start with a `#` heading, so the codex and
 * opencode adapters were closed BY ACCIDENT — one reordering of buildTurnPrompt's sections and
 * every turn of two runtimes fails at the parser.
 *
 * A leading newline defuses it (proven: the same claude prompt then returns
 * `"result":"OK","is_error":false`) and is invisible to the model. It lives HERE, in the shared
 * adapter layer, because "no caller should have to know a CLI's parser quirks" (spec §6) is only
 * true if every adapter applies it — codex and opencode also pass `--`, belt and braces.
 */
export function argvSafePrompt(prompt: string): string {
  return prompt.startsWith("-") ? `\n${prompt}` : prompt;
}

// ---------------------------------------------------------------------------
// Defensive JSONL extraction
// ---------------------------------------------------------------------------

/**
 * Terminated OSC escape sequences: `ESC ] ... BEL` / `ESC ] ... ESC \`, plus the bare
 * `]777;...BEL` form the Warp plugin injects into opencode's stdout without a leading ESC
 * (observed on this machine, see RUNTIME-CONTRACTS.md). Non-greedy so one sequence never
 * swallows the JSON that follows its terminator.
 */
const TERMINATED_OSC = /(?:\u001b\]|\u009d|\]777;)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g;
/**
 * An *unterminated* Warp notify payload glued straight onto the next JSON line: strip the
 * `]777;notify;<url>;` header itself; the JSON payload that follows is handled by the balanced
 * scanner (it parses but carries no recognized `type`, so mappers drop it).
 */
const WARP_NOTIFY_HEADER = /(?:\u001b\]|\u009d|\])777;notify;[^;{]*;/g;

/** CSI color/cursor sequences, e.g. `ESC [ 32m`. */
const CSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;

/**
 * How much character-scanning one line may cost, as a multiple of its own length.
 *
 * The tolerant "try the next `{`" retry below is quadratic: every failed start rescans to
 * end-of-line, so a runtime that echoes a large blob full of unbalanced braces (a code file,
 * a stack dump, a minified bundle) makes one stdout chunk cost O(n²) — SYNCHRONOUSLY, inside
 * the daemon's stdout handler, blocking supervision, the Office and crew_report for as long
 * as it takes. A budget bounds that without changing the answer for any real JSONL line,
 * which parses on the fast path or on its first scan.
 */
const SCAN_BUDGET_FACTOR = 8;

/**
 * Extracts every balanced `{...}` JSON object from a single (already OSC-stripped) line.
 * Tolerates junk before/between objects and an object starting mid-line; anything that is not
 * a parseable object is silently skipped — this function never throws.
 */
export function extractJsonObjects(line: string): Record<string, unknown>[] {
  // Fast path: the overwhelmingly common case is a line that IS one JSON object. Taking it
  // first costs one parse and skips the scanner (and its budget) entirely.
  const trimmed = line.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const whole: unknown = JSON.parse(trimmed);
      if (whole !== null && typeof whole === "object" && !Array.isArray(whole)) {
        return [whole as Record<string, unknown>];
      }
    } catch {
      // Not a single object after all — fall through to the tolerant scanner.
    }
  }

  const found: Record<string, unknown>[] = [];
  let budget = line.length * SCAN_BUDGET_FACTOR + 1024;
  let index = line.indexOf("{");
  while (index !== -1) {
    if (budget <= 0) break; // pathological line: keep what was found, stop burning the loop
    const end = scanBalancedObject(line, index);
    budget -= (end === -1 ? line.length : end) - index;
    if (end === -1) {
      // Unbalanced from this `{` to end-of-line: malformed or truncated. Try the next `{`.
      index = line.indexOf("{", index + 1);
      continue;
    }
    const candidate = line.slice(index, end + 1);
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        found.push(parsed as Record<string, unknown>);
        index = line.indexOf("{", end + 1);
        continue;
      }
    } catch {
      // Balanced braces but not valid JSON (e.g. log text with braces). Fall through.
    }
    index = line.indexOf("{", index + 1);
  }
  return found;
}

/** Returns the index of the `}` closing the object starting at `start`, or -1 if unbalanced. */
function scanBalancedObject(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function stripTerminalNoise(line: string): string {
  return line.replace(TERMINATED_OSC, "").replace(WARP_NOTIFY_HEADER, "").replace(CSI, "");
}

/**
 * Incremental JSONL parser. Feed it raw stdout chunks (which may split one JSON object across
 * chunk boundaries); it yields parsed objects as complete lines arrive. Never throws on
 * malformed input — garbage is dropped.
 */
/**
 * Ceiling on one un-terminated stdout line held in memory.
 *
 * Generous on purpose — a claude `stream-json` event carrying a big tool result is
 * legitimately megabytes — but finite: without it, a runtime that writes an endless stream
 * with no newline (a progress bar, a binary blob) grows this buffer until the daemon dies of
 * memory, taking every supervised child with it. Past the cap the fragment is dropped and
 * said out loud, and parsing resumes at the next newline.
 */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export class JsonlExtractor {
  #buffer = "";
  #dropping = false;

  feed(chunk: string | Buffer): Record<string, unknown>[] {
    this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const pieces = this.#buffer.split(/\r?\n/);
    this.#buffer = pieces.pop() ?? "";
    if (this.#buffer.length > MAX_LINE_BYTES) {
      if (!this.#dropping) {
        this.#dropping = true;
        console.error(
          `crew: a runtime wrote more than ${MAX_LINE_BYTES} characters with no newline — ` +
            `dropping the fragment and resyncing at the next line (the raw log still has it)`,
        );
      }
      this.#buffer = "";
    } else if (pieces.length > 0) {
      // A newline arrived: whatever was being dropped has ended.
      this.#dropping = false;
    }
    const out: Record<string, unknown>[] = [];
    for (const piece of pieces) {
      if (piece.length === 0) continue;
      out.push(...extractJsonObjects(stripTerminalNoise(piece)));
    }
    return out;
  }

  /** Drain whatever is left (a final line without a trailing newline). */
  flush(): Record<string, unknown>[] {
    const rest = this.#buffer;
    this.#buffer = "";
    if (rest.length === 0) return [];
    return extractJsonObjects(stripTerminalNoise(rest));
  }
}

// ---------------------------------------------------------------------------
// Async event queue (push side: child process callbacks; pull side: async generator)
// ---------------------------------------------------------------------------

class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: ((r: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.#items.length > 0) {
          return Promise.resolve({ value: this.#items.shift() as T, done: false });
        }
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Run registry — cancel(runId) support shared by all adapters
// ---------------------------------------------------------------------------

interface RegisteredRun {
  kill(): void;
  done: Promise<void>;
}

export class RunRegistry {
  #runs = new Map<string, RegisteredRun>();

  register(runId: string, run: RegisteredRun): void {
    this.#runs.set(runId, run);
  }

  unregister(runId: string): void {
    this.#runs.delete(runId);
  }

  /** Kills the run's process (group) and resolves once the child has actually exited. */
  async cancel(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run) return; // Already finished (or never started) — cancel is idempotent.
    run.kill();
    await run.done;
  }
}

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

const STDERR_CAP = 8 * 1024;

export interface TurnProcessOptions {
  runId: string;
  exe: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Maps one raw native event object to zero or more AgentEvents. Stateful per turn (create a
   * fresh mapper for every call). Must never throw; unknown events map to [].
   */
  mapEvent: (raw: Record<string, unknown>) => AgentEvent[];
}

/**
 * Keeps the tail of stderr so a summary survives a chatty process — and SAYS it is a tail.
 *
 * An unmarked tail is a lie by omission: this string is frequently the only explanation a
 * human ever gets for why a turn died, and one that silently begins mid-sentence reads as if
 * the process said exactly that. The marker matches the discipline supervisor.ts already
 * applies to its own clips (`…`, `truncated`, `fullLength`).
 */
const STDERR_CLIPPED_PREFIX = "…[earlier stderr dropped]…\n";

function appendCapped(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= STDERR_CAP) return next;
  return STDERR_CLIPPED_PREFIX + next.slice(next.length - STDERR_CAP);
}

const SUMMARY_LINES = 6;
const SUMMARY_CHARS = 600;

/**
 * The one-line "why did this die" string. Every cut it makes is marked, in both directions:
 * dropped leading lines get a `…` in front, an over-long result gets a `…` at the end. A
 * mid-word cut with nothing to show for it is indistinguishable from the process having
 * stopped there, which is exactly the wrong thing to believe about a failure.
 */
export function summarizeStderr(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => stripTerminalNoise(l).trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return "";
  const kept = lines.slice(-SUMMARY_LINES);
  const droppedLines = lines.length - kept.length;
  const joined = (droppedLines > 0 ? "… | " : "") + kept.join(" | ");
  return joined.length > SUMMARY_CHARS ? joined.slice(0, SUMMARY_CHARS - 1) + "…" : joined;
}

/**
 * Spawns one runtime turn and yields normalized AgentEvents.
 *
 * Invariants (RUNTIME-CONTRACTS.md "Cross-cutting adapter rules", spec §30):
 * - direct spawn, `shell: false`, stdin closed (`ignore`) — codex hangs otherwise;
 * - the child gets its own process group so cancel kills descendants too;
 * - a non-zero exit, spawn failure, or "exited clean but never produced a result" all become
 *   AgentEvent{type:"error"} — a failed run is never silently a success;
 * - if the consumer stops iterating early, the child is killed rather than orphaned.
 */
export async function* runTurnProcess(
  registry: RunRegistry,
  opts: TurnProcessOptions,
): AsyncGenerator<AgentEvent, void, undefined> {
  const queue = new AsyncQueue<AgentEvent>();
  const extractor = new JsonlExtractor();
  const detached = process.platform !== "win32";
  let stderr = "";
  let cancelled = false;
  let sawOutcome = false; // a result or error event reached the stream
  let child: ChildProcess;
  let exited = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => (resolveDone = resolve));

  const push = (events: AgentEvent[]): void => {
    for (const event of events) {
      if (event.type === "result" || event.type === "error") sawOutcome = true;
      queue.push(event);
    }
  };

  const mapSafely = (raw: Record<string, unknown>): AgentEvent[] => {
    try {
      return opts.mapEvent(raw);
    } catch {
      return []; // A mapper bug on one weird event must not kill the turn.
    }
  };

  try {
    child = spawn(opts.exe, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached,
    });
  } catch (error) {
    yield { type: "error", message: `failed to spawn ${opts.exe}: ${String(error)}` };
    return;
  }

  let killTimer: NodeJS.Timeout | undefined;
  const kill = (): void => {
    cancelled = true;
    if (exited) return;
    signalChild(child, "SIGTERM", detached);
    killTimer = setTimeout(() => {
      if (!exited) signalChild(child, "SIGKILL", detached);
    }, 3000);
    killTimer.unref?.();
  };

  const onAbort = (): void => kill();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  // An ALREADY-aborted signal never fires "abort", so a turn whose cancellation landed between
  // the caller's check and this spawn would have left a live child nobody was going to kill.
  if (opts.signal?.aborted) kill();
  registry.register(opts.runId, { kill, done });

  child.on("error", (error: Error) => {
    // Covers ENOENT and other spawn-time failures on some platforms (fires instead of/-with exit).
    push([{ type: "error", message: `failed to spawn ${opts.exe}: ${error.message}` }]);
    if (!exited) {
      exited = true;
      finish();
    }
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    for (const raw of extractor.feed(chunk)) push(mapSafely(raw));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = appendCapped(stderr, chunk.toString("utf8"));
  });

  child.on("close", (code, signal) => {
    if (exited) return;
    exited = true;
    for (const raw of extractor.flush()) push(mapSafely(raw));
    if (cancelled) {
      push([{ type: "status", status: "cancelled" }]);
    } else if (code !== 0) {
      const summary = summarizeStderr(stderr);
      const how = code === null ? `killed by ${signal ?? "signal"}` : `exited with code ${code}`;
      push([{ type: "error", message: `${opts.exe} ${how}${summary ? `: ${summary}` : ""}` }]);
    } else if (!sawOutcome) {
      const summary = summarizeStderr(stderr);
      push([
        {
          type: "error",
          message: `${opts.exe} exited 0 without producing a result event${summary ? `; stderr: ${summary}` : ""}`,
        },
      ]);
    }
    finish();
  });

  function finish(): void {
    if (killTimer) clearTimeout(killTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    registry.unregister(opts.runId);
    queue.close();
    resolveDone();
  }

  try {
    for await (const event of queue) yield event;
  } finally {
    // Consumer stopped iterating (break/return/throw) while the child is still alive.
    if (!exited) kill();
  }
}

function signalChild(child: ChildProcess, sig: NodeJS.Signals, detached: boolean): void {
  if (child.pid === undefined) return;
  try {
    if (detached) process.kill(-child.pid, sig); // whole process group
    else child.kill(sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Binary probing (detect / capabilities support)
// ---------------------------------------------------------------------------

export function findOnPath(name: string): Promise<string | undefined> {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((d) => d.length > 0);
  return (async () => {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      const ok = await new Promise<boolean>((resolve) =>
        access(candidate, constants.X_OK, (err) => resolve(err === null)),
      );
      if (ok) return candidate;
    }
    return undefined;
  })();
}

/**
 * Runs `exe args...` (no shell) and returns combined stdout+stderr even when the process exits
 * non-zero — several CLIs print `--help` to stderr or exit 1 for it.
 */
export function execCapture(exe: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: false },
      (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`),
    );
  });
}

export function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/**
 * `RuntimeDetection` for a runtime whose binary is named after it — which is all three.
 *
 * The three adapters had byte-identical copies of this apart from the string. There is no
 * runtime-specific knowledge in it (the version line is never parsed for feature decisions;
 * capabilities are probed from the real binary instead — see types.ts RuntimeDetection), so
 * it is not §6 knowledge escaping an adapter, just plumbing that belongs here.
 */
export async function detectBinary(id: RuntimeId): Promise<RuntimeDetection> {
  const executable = await findOnPath(id);
  if (!executable) return { id, installed: false, error: `${id} not found on PATH` };
  return { id, installed: true, executable, version: firstLine(await execCapture(executable, ["--version"])) };
}

/**
 * Per-adapter probe cache that remembers a SUCCESS and forgets a FAILURE.
 *
 * Every adapter used to write `this.#detection ??= detectBinary(this.id)`, which caches the
 * answer "codex is not installed" for the life of the daemon. Installing a runtime after boot
 * therefore left it invisible until someone restarted the daemon — and nothing in `doctor` or
 * the Office says "restart me", so the symptom is a runtime that is on PATH, works in a
 * terminal, and still cannot be spawned. A negative is a fact about a moment; a positive is a
 * fact about a binary that is now on disk, so only the positive is worth keeping.
 *
 * Concurrent callers still share one in-flight probe (that is the point of the cache); the
 * result is simply dropped afterwards when it was negative, so the NEXT caller re-probes.
 * `capabilities()` is keyed off the same rule — a capability set derived from "not installed"
 * is NO_CAPABILITIES, which must not outlive the installation either.
 */
export class RuntimeProbeCache {
  #detection?: Promise<RuntimeDetection>;
  #capabilities?: Promise<RuntimeCapabilities>;

  constructor(private readonly id: RuntimeId) {}

  detect(): Promise<RuntimeDetection> {
    this.#detection ??= detectBinary(this.id).then((result) => {
      if (!result.installed || !result.executable) this.#detection = undefined;
      return result;
    });
    return this.#detection;
  }

  capabilities(): Promise<RuntimeCapabilities> {
    this.#capabilities ??= probeRuntimeCapabilities(this.detect()).then(async (caps) => {
      const detection = await this.detect();
      if (!detection.installed || !detection.executable) this.#capabilities = undefined;
      return caps;
    });
    return this.#capabilities;
  }
}

/** Nothing could be established. Reported rather than guessed at (spec §5). */
export const NO_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  nonInteractive: false,
  structuredOutput: false,
  resume: false,
  workingDirectoryFlag: false,
  modelSelection: false,
  providerSelection: false,
});

/**
 * `AgentRuntimeAdapter.capabilities()` for every adapter, delegating to discovery.ts's probe.
 *
 * There were TWO probe tables — one per adapter, and `probeCapabilities` in discovery.ts —
 * and they had drifted apart (codex `resume` and opencode `providerSelection` disagreed).
 * Only discovery's was ever reached in production: it is what feeds `doctor` and
 * `GET /api/state`, while these methods had no caller outside the live-gated adapter test.
 * Two answers to "can this binary resume?", one of them unreachable, is worse than one.
 *
 * The surviving table lives in discovery.ts because that is where the reachable caller is;
 * the flag names it greps for are the ones proven in docs/RUNTIME-CONTRACTS.md.
 */
export async function probeRuntimeCapabilities(detection: Promise<RuntimeDetection>): Promise<RuntimeCapabilities> {
  const resolved = await detection;
  if (!resolved.installed || !resolved.executable) return NO_CAPABILITIES;
  // Imported lazily so adapters/ keeps no load-time dependency on discovery.ts.
  const { probeCapabilities } = await import("../discovery.js");
  return probeCapabilities(resolved.id, resolved.executable);
}
