import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventBus } from "./events.js";
import type { CrewEvent } from "./types.js";

async function scratchBus(): Promise<{ bus: EventBus; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "crew-events-test-"));
  const file = join(dir, "events.jsonl");
  return { bus: new EventBus(file), file };
}

test("emit appends to events.jsonl and readRecent replays in order", async () => {
  const { bus } = await scratchBus();
  await bus.publish("crew.started", { summary: "one" });
  await bus.publish("agent.spawned", { agentId: "a1", summary: "two" });
  await bus.publish("agent.idle", { agentId: "a1", summary: "three" });

  const all = await bus.readRecent(10);
  assert.deepEqual(all.map((e) => e.summary), ["one", "two", "three"]);
  const lastTwo = await bus.readRecent(2);
  assert.deepEqual(lastTwo.map((e) => e.summary), ["two", "three"]);

  // A fresh bus over the same file sees the same history — the log is the record.
  const replay = await new EventBus((bus as unknown as { file: string })["file"]).readRecent(10);
  assert.equal(replay.length, 3);
});

test("emit persists BEFORE fanning out to subscribers", async () => {
  const { bus, file } = await scratchBus();
  let onDiskAtDelivery = "";
  bus.subscribe((event) => {
    onDiskAtDelivery = readFileSync(file, "utf8");
    void event;
  });
  const event = await bus.publish("agent.output", { summary: "persist-first" });
  assert.ok(onDiskAtDelivery.includes(event.id), "subscriber ran before the event hit disk");
});

test("all subscribers receive the event; a throwing subscriber doesn't break the rest", async () => {
  const { bus } = await scratchBus();
  const received: string[] = [];
  bus.subscribe(() => {
    throw new Error("broken listener");
  });
  bus.subscribe((e) => received.push(e.type));
  const unsubscribe = bus.subscribe((e) => received.push(`dup:${e.type}`));
  await bus.publish("manager.woken", {});
  assert.deepEqual(received, ["manager.woken", "dup:manager.woken"]);

  unsubscribe();
  await bus.publish("manager.paused", {});
  assert.deepEqual(received, ["manager.woken", "dup:manager.woken", "manager.paused"]);
});

test("readRecent skips torn/foreign lines instead of failing", async () => {
  const { bus, file } = await scratchBus();
  await bus.publish("crew.started", { summary: "good" });
  await appendFile(file, '{"half": "written', "utf8"); // crash mid-append, no newline
  const events = await bus.readRecent(10);
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, "good");
});

test("concurrent emits produce whole, ordered lines", async () => {
  const { bus, file } = await scratchBus();
  await Promise.all(Array.from({ length: 25 }, (_, i) => bus.publish("agent.output", { summary: `n${i}` })));
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 25);
  const parsed = lines.map((l) => JSON.parse(l) as CrewEvent);
  assert.deepEqual(parsed.map((e) => e.summary), Array.from({ length: 25 }, (_, i) => `n${i}`));
});

/**
 * Defect A — opening the Office killed the daemon once events.jsonl grew.
 *
 * readRecent() used to `readFile(file, "utf8")` the WHOLE log to return the last N events, on
 * every /api/events connect (the Office reconnects roughly every 15 s while open). Measured on
 * a real log: 20 MB blocked the event loop 31 ms, 98 MB → 165 ms, 393 MB → 633 ms, and past
 * ~512 MB it threw `RangeError: Invalid string length` — which, thrown after the SSE header
 * was already written, escaped as an unhandled rejection and exited the daemon, orphaning
 * every runtime child mid-edit.
 */

function eventLine(i: number, pad: number): string {
  return (
    JSON.stringify({
      id: `evt-${String(i).padStart(9, "0")}`,
      type: "agent.output",
      at: new Date(Date.UTC(2026, 0, 1) + i).toISOString(),
      summary: `n${i}`,
      data: { kind: "text", text: "п".repeat(pad) }, // multi-byte on purpose
    }) + "\n"
  );
}

test("readRecent reads the TAIL: a big log costs a small read, not the whole file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crew-events-tail-"));
  const file = join(dir, "events.jsonl");
  // ~24 MB, the size an ordinary day of 8000-character outputs reaches.
  const chunk: string[] = [];
  for (let i = 0; i < 12_000; i++) chunk.push(eventLine(i, 900));
  await writeFile(file, chunk.join(""), "utf8");
  const size = (await stat(file)).size;
  assert.ok(size > 20 * 1024 * 1024, `fixture too small: ${size} bytes`);

  const bus = new EventBus(file);
  const started = process.hrtime.bigint();
  const recent = await bus.readRecent(50);
  const tailMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(recent.length, 50);
  assert.equal(recent.at(-1)!.summary, "n11999");
  assert.equal(recent[0].summary, "n11950");

  // The old implementation, measured right here so the bound calibrates itself to the machine.
  const wholeStarted = process.hrtime.bigint();
  const whole = await readFile(file, "utf8");
  const wholeEvents = whole.split("\n").filter((l) => l.trim()).slice(-50);
  const wholeMs = Number(process.hrtime.bigint() - wholeStarted) / 1e6;
  assert.equal(wholeEvents.length, 50);
  assert.ok(
    tailMs < wholeMs / 4,
    `readRecent still pays for the whole log: tail ${tailMs.toFixed(1)}ms vs whole-file ${wholeMs.toFixed(1)}ms`,
  );
});

test("the tail read is exact across chunk boundaries and multi-byte characters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crew-events-chunk-"));
  const file = join(dir, "events.jsonl");
  // Well past the 64 KB backwards-read chunk, with 2-byte characters straddling it.
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) lines.push(eventLine(i, 700));
  await writeFile(file, lines.join(""), "utf8");
  const bus = new EventBus(file);

  const three = await bus.readRecent(3);
  assert.deepEqual(three.map((e) => e.summary), ["n397", "n398", "n399"]);
  assert.ok(three.every((e) => (e.data as { text: string }).text === "п".repeat(700)), "text was corrupted");

  const all = await bus.readRecent(1000);
  assert.equal(all.length, 400, "asking for more than the log holds must return everything");
  assert.equal(all[0].summary, "n0");
});

test("the log rotates, and readRecent reads across the seam", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crew-events-rotate-"));
  const file = join(dir, "events.jsonl");
  const bus = new EventBus(file, 4_000); // tiny cap so the test rotates for real
  for (let i = 0; i < 60; i++) await bus.publish("agent.output", { summary: `r${i}` });

  const live = (await stat(file)).size;
  assert.ok(live < 4_000, `the live log was not rotated: ${live} bytes`);
  const rotated = await stat(`${file}.1`);
  assert.ok(rotated.size > 0, "no rotated log was kept");

  // The Team Feed must not go blank at a rotation.
  const recent = await bus.readRecent(40);
  assert.equal(recent.length, 40);
  assert.deepEqual(recent.at(-1)!.summary, "r59");
  assert.deepEqual(recent[0].summary, "r20");
});

test("an unwritable events.jsonl DEGRADES loudly — it never takes the daemon down", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crew-events-eisdir-"));
  const file = join(dir, "events.jsonl");
  await mkdir(file); // appendFile → EISDIR, the reviewer's reproduction
  const bus = new EventBus(file);

  const seen: CrewEvent[] = [];
  bus.subscribe((e) => seen.push(e));
  // The daemon's own startup publish is unguarded — this must not reject.
  await bus.publish("crew.started", { summary: "up" });
  await bus.publish("agent.failed", { summary: "still supervising" });

  assert.equal(seen.length, 2, "live subscribers must still get the events");
  assert.ok(bus.degraded, "the failure must be reportable, not silent");
  assert.equal(bus.droppedEvents, 2);
});

test("events.jsonl is created 0600, like state.json — not 0644", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crew-events-mode-"));
  const file = join(dir, "events.jsonl");
  await new EventBus(file).publish("crew.started", { summary: "up" });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("a symlink planted at events.jsonl is never written through (defect 6)", async () => {
  /**
   * `appendFile(file, …)` opens with 'a' — O_APPEND|O_CREAT|O_WRONLY — which FOLLOWS symlinks.
   * An agent that pointed `~/.docket/crew/events.jsonl` at any file the user can write would
   * have the daemon append its whole event stream (prompts, results, agent output) into that
   * file. The same class as the `agent-token` write; the same fix shape: refuse the link.
   */
  const dir = await mkdtemp(join(tmpdir(), "crew-events-symlink-"));
  const victim = join(dir, "precious.txt");
  await writeFile(victim, "the user's own file\n");
  const file = join(dir, "events.jsonl");
  await symlink(victim, file);

  const bus = new EventBus(file);
  await bus.publish("crew.started", { summary: "should not land in the victim" });

  assert.equal(await readFile(victim, "utf8"), "the user's own file\n", "the symlink target must be untouched");
  // …and the daemon says so rather than pretending the log is fine: an unwritable log DEGRADES.
  assert.ok(bus.degraded, "the bus must report itself degraded when its log cannot be opened");
  assert.equal(bus.droppedEvents, 1);
});
