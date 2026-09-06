import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "../types.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonlExtractor,
  NO_CAPABILITIES,
  RunRegistry,
  RuntimeProbeCache,
  argvSafePrompt,
  extractJsonObjects,
  runTurnProcess,
  stripTerminalNoise,
  summarizeStderr,
} from "./common.js";

const ESC = "\u001b";
const BEL = "\u0007";

test("extractJsonObjects: plain JSONL line", () => {
  assert.deepEqual(extractJsonObjects('{"type":"text","x":1}'), [{ type: "text", x: 1 }]);
});

test("extractJsonObjects: JSON object glued mid-line after garbage", () => {
  const objects = extractJsonObjects('some noise before {"type":"text","text":"hi"} after');
  assert.deepEqual(objects, [{ type: "text", text: "hi" }]);
});

test("extractJsonObjects: two objects glued on one line with no separator", () => {
  const objects = extractJsonObjects('{"v":1,"agent":"opencode"}{"type":"text","text":"ok"}');
  assert.deepEqual(objects, [
    { v: 1, agent: "opencode" },
    { type: "text", text: "ok" },
  ]);
});

test("extractJsonObjects: braces inside strings do not break balancing", () => {
  const objects = extractJsonObjects('{"text":"a } b { c","n":"quote \\" and { brace"}');
  assert.equal(objects.length, 1);
  assert.equal(objects[0].text, "a } b { c");
});

test("extractJsonObjects: malformed input yields nothing and never throws", () => {
  assert.deepEqual(extractJsonObjects("this line is not json at all {broken"), []);
  assert.deepEqual(extractJsonObjects(""), []);
  assert.deepEqual(extractJsonObjects("{{{{"), []);
});

test("stripTerminalNoise: removes ESC-prefixed terminated OSC sequences", () => {
  const line = `${ESC}]777;notify;warp://cli-agent;{"v":1}${BEL}{"type":"text","text":"ok"}`;
  assert.deepEqual(extractJsonObjects(stripTerminalNoise(line)), [{ type: "text", text: "ok" }]);
});

test("stripTerminalNoise: bare ]777; Warp payload without ESC, terminated by BEL", () => {
  const line = `]777;notify;warp://cli-agent;{"v":1,"event":"session_start"}${BEL}{"type":"text","text":"ok"}`;
  assert.deepEqual(extractJsonObjects(stripTerminalNoise(line)), [{ type: "text", text: "ok" }]);
});

test("stripTerminalNoise: unterminated Warp header glued to a real JSON line", () => {
  // No BEL/ST at all — the header is stripped, its JSON payload survives as a (droppable)
  // object, and the real event parses.
  const line = `]777;notify;warp://cli-agent;{"v":1,"agent":"opencode"}{"type":"text","text":"ok"}`;
  const objects = extractJsonObjects(stripTerminalNoise(line));
  assert.deepEqual(objects, [
    { v: 1, agent: "opencode" },
    { type: "text", text: "ok" },
  ]);
});

test("stripTerminalNoise: CSI color codes", () => {
  assert.equal(stripTerminalNoise(`${ESC}[32mhello${ESC}[0m`), "hello");
});

test("JsonlExtractor: one JSON object split across chunk boundaries", () => {
  const extractor = new JsonlExtractor();
  const whole = '{"type":"result","text":"CREW_OK"}\n';
  let objects: Record<string, unknown>[] = [];
  for (const piece of [whole.slice(0, 9), whole.slice(9, 21), whole.slice(21)]) {
    objects = objects.concat(extractor.feed(piece));
  }
  assert.deepEqual(objects, [{ type: "result", text: "CREW_OK" }]);
});

test("JsonlExtractor: flush drains a final line without trailing newline", () => {
  const extractor = new JsonlExtractor();
  assert.deepEqual(extractor.feed('{"a":1}'), []);
  assert.deepEqual(extractor.flush(), [{ a: 1 }]);
  assert.deepEqual(extractor.flush(), []);
});

test("JsonlExtractor: interleaves malformed lines without losing later events", () => {
  const extractor = new JsonlExtractor();
  const objects = extractor.feed('{"a":1}\ngarbage {here\n{"b":2}\n');
  assert.deepEqual(objects, [{ a: 1 }, { b: 2 }]);
});

// ---------------------------------------------------------------------------
// runTurnProcess — real (tiny) child processes via process.execPath; no shell anywhere.
// ---------------------------------------------------------------------------

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const passthroughMapper = (raw: Record<string, unknown>): AgentEvent[] => {
  if (raw.type === "result") return [{ type: "result", text: String(raw.text ?? "") }];
  if (raw.type === "text") return [{ type: "text", text: String(raw.text ?? "") }];
  return [];
};

test("runTurnProcess: maps stdout JSONL and finishes on clean exit", async () => {
  const registry = new RunRegistry();
  const script = `process.stdout.write('{"type":"text","text":"hi"}\\n{"type":"result","text":"done"}\\n');`;
  const events = await collect(
    runTurnProcess(registry, {
      runId: "r1",
      exe: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      mapEvent: passthroughMapper,
    }),
  );
  assert.deepEqual(events, [
    { type: "text", text: "hi" },
    { type: "result", text: "done" },
  ]);
});

test("runTurnProcess: non-zero exit becomes an error event with a stderr summary", async () => {
  const registry = new RunRegistry();
  const script = `process.stderr.write("boom: credentials missing\\n"); process.exit(3);`;
  const events = await collect(
    runTurnProcess(registry, {
      runId: "r2",
      exe: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      mapEvent: passthroughMapper,
    }),
  );
  const errors = events.filter(
    (e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error",
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /exited with code 3/);
  assert.match(errors[0].message, /credentials missing/);
});

test("runTurnProcess: clean exit without a result event is still an error, not a fake success", async () => {
  const registry = new RunRegistry();
  const events = await collect(
    runTurnProcess(registry, {
      runId: "r3",
      exe: process.execPath,
      args: ["-e", `process.stdout.write('{"type":"text","text":"partial"}\\n');`],
      cwd: process.cwd(),
      mapEvent: passthroughMapper,
    }),
  );
  assert.ok(events.some((e) => e.type === "error" && /without producing a result/.test(e.message)));
});

test("runTurnProcess: spawn failure yields an error event", async () => {
  const registry = new RunRegistry();
  const events = await collect(
    runTurnProcess(registry, {
      runId: "r4",
      exe: "/nonexistent/definitely-not-a-binary",
      args: [],
      cwd: process.cwd(),
      mapEvent: passthroughMapper,
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match((events[0] as { message: string }).message, /failed to spawn/);
});

test("runTurnProcess: cancel(runId) kills the child and resolves deterministically", async () => {
  const registry = new RunRegistry();
  // Child that would run for 60s unless killed.
  const iterator = runTurnProcess(registry, {
    runId: "r5",
    exe: process.execPath,
    args: ["-e", `process.stdout.write('{"type":"text","text":"started"}\\n'); setTimeout(()=>{}, 60000);`],
    cwd: process.cwd(),
    mapEvent: passthroughMapper,
  })[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.deepEqual(first.value, { type: "text", text: "started" });

  const startedAt = Date.now();
  await registry.cancel("r5"); // resolves only once the child actually exited
  assert.ok(Date.now() - startedAt < 10_000);

  const rest: AgentEvent[] = [];
  for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
    rest.push(step.value);
  }
  assert.deepEqual(rest, [{ type: "status", status: "cancelled" }]);

  // Cancel of an unknown/finished run is an idempotent no-op.
  await registry.cancel("r5");
  await registry.cancel("never-existed");
});

test("runTurnProcess: abort signal cancels like cancel()", async () => {
  const registry = new RunRegistry();
  const controller = new AbortController();
  const generator = runTurnProcess(registry, {
    runId: "r6",
    exe: process.execPath,
    args: ["-e", `process.stdout.write('{"type":"text","text":"up"}\\n'); setTimeout(()=>{}, 60000);`],
    cwd: process.cwd(),
    signal: controller.signal,
    mapEvent: passthroughMapper,
  });
  const events: AgentEvent[] = [];
  for await (const event of generator) {
    events.push(event);
    if (event.type === "text") controller.abort();
  }
  assert.deepEqual(events, [
    { type: "text", text: "up" },
    { type: "status", status: "cancelled" },
  ]);
});

/**
 * Defect I — the "why did this turn die" string was clipped in two places with no marker.
 *
 * summarizeStderr keeps the last 6 lines and 600 characters of a process's stderr, and
 * appendCapped keeps only the last 8 KB of it. Both cuts were invisible, so a truncated
 * message read as the complete thing the process said — which is precisely the wrong thing to
 * believe about a failure. supervisor.ts marks its own clips (`…`, truncated, fullLength);
 * this now matches.
 */
test("summarizeStderr marks BOTH of its cuts instead of lying by omission", () => {
  const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const summary = summarizeStderr(many);
  assert.ok(summary.startsWith("…"), `dropped leading lines are unmarked: ${summary}`);
  assert.ok(summary.includes("line 19"), "the newest line must survive");
  assert.ok(!summary.includes("line 0"));

  const wide = "E".repeat(5_000);
  const clipped = summarizeStderr(wide);
  assert.ok(clipped.length <= 600);
  assert.ok(clipped.endsWith("…"), `a mid-word cut reads as a complete message: ${clipped.slice(-20)}`);

  // A short stderr is passed through untouched — no decoration where nothing was lost.
  assert.equal(summarizeStderr("codex: command not found"), "codex: command not found");
  assert.equal(summarizeStderr(""), "");
});

test("a huge non-JSON blob on one line does not stall the stdout handler", () => {
  // The quadratic case: many unbalanced `{` on one very long line. Each failed start used to
  // rescan to end-of-line, synchronously, inside the daemon's stdout handler — blocking
  // /api/health and crew_report for as long as it took.
  const blob = "{ noise ".repeat(60_000); // ~480 KB, 60k restart points
  const started = Date.now();
  const objects = extractJsonObjects(blob);
  const elapsed = Date.now() - started;
  assert.deepEqual(objects, []);
  assert.ok(elapsed < 2_000, `extractJsonObjects took ${elapsed}ms on one line`);
});

test("real JSONL is unaffected by the scan budget", () => {
  const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "{not json} {" }] } });
  assert.deepEqual(extractJsonObjects(line), [JSON.parse(line)]);
  assert.deepEqual(extractJsonObjects('{"a":1} junk {"b":2}'), [{ a: 1 }, { b: 2 }]);
});

test("a runtime that writes forever without a newline cannot grow the buffer without bound", () => {
  const extractor = new JsonlExtractor();
  // Unbounded AND brace-laden: the buffer grew forever, and whatever finally terminated the
  // line was then handed to the quadratic scanner in one piece.
  const megabyte = "{ x".repeat(350_000); // ~1 MB
  const started = Date.now();
  for (let i = 0; i < 20; i++) assert.deepEqual(extractor.feed(megabyte), []);
  // Resync at the next newline: the over-long fragment is dropped, parsing continues.
  const after = extractor.feed(`tail\n${JSON.stringify({ type: "result", ok: true })}\n`);
  assert.deepEqual(after.at(-1), { type: "result", ok: true });
  assert.deepEqual(extractor.flush(), []);
  assert.ok(Date.now() - started < 10_000, "one runaway line stalled the daemon's stdout handler");
});

// ---------------------------------------------------------------------------
// Defect 7 — a prompt whose first character is `-` is argv, not text
// ---------------------------------------------------------------------------

test("argvSafePrompt defuses a leading dash without changing what the model reads", () => {
  /**
   * VERIFIED against the real binaries on 2026-09-06, not assumed:
   *
   *   claude   -p "---\nname: …"                  → `error: unknown option '---…'`
   *   codex    exec … "-hello world"               → usage dump, prompt never seen
   *   opencode run  … "-hello world"               → usage dump, prompt never seen
   *
   * and with the guard/separator applied, all three get past parsing to the next real step.
   * A leading newline is invisible to the model and cannot be parsed as a flag.
   */
  assert.equal(argvSafePrompt("-hello"), "\n-hello");
  assert.equal(argvSafePrompt("---\nname: crew-manager"), "\n---\nname: crew-manager");
  // codex reads a prompt of exactly "-" from STDIN, which runTurnProcess closes: same trap.
  assert.equal(argvSafePrompt("-"), "\n-");
  // Ordinary prompts are untouched, byte for byte.
  assert.equal(argvSafePrompt("# Skill\n\nDo the thing"), "# Skill\n\nDo the thing");
  assert.equal(argvSafePrompt(""), "");
});

test("a NEGATIVE runtime probe is not cached — installing a binary after boot must work (defect 8)", async () => {
  /**
   * `this.#detection ??= detectBinary(this.id)` cached "not found" for the life of the daemon,
   * so installing `codex` after the crew started left it invisible until a restart — with
   * nothing anywhere saying "restart me". A negative is a fact about a moment; a positive is a
   * fact about a binary now on disk.
   */
  const dir = await mkdtemp(join(tmpdir(), "crew-detect-cache-"));
  const name = "crew-probe-fixture";
  const previousPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    const cache = new RuntimeProbeCache(name as never);
    const missing = await cache.detect();
    assert.equal(missing.installed, false, "nothing is on this PATH yet");
    assert.deepEqual(await cache.capabilities(), NO_CAPABILITIES);

    // The binary appears while the daemon is running.
    const exe = join(dir, name);
    await writeFile(exe, "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });

    const found = await cache.detect();
    assert.equal(found.installed, true, "a re-probe must see the newly installed binary");
    assert.equal(found.executable, exe);

    // …and the positive IS cached: the second call does not re-stat the world.
    assert.equal(await cache.detect(), await cache.detect());
  } finally {
    process.env.PATH = previousPath;
  }
});
