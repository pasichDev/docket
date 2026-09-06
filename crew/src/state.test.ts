import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { freshState, recoverInterruptedRuns, StateStore } from "./state.js";
import type { Assignment, CrewAgent } from "./types.js";

async function scratchFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crew-state-test-"));
  return join(dir, "state.json");
}

function makeStore(file: string): StateStore {
  return new StateStore(file, () => freshState("test-ws", 0));
}

test("missing state.json yields a fresh state", async () => {
  const store = makeStore(await scratchFile());
  const state = await store.getState();
  assert.equal(state.version, 1);
  assert.equal(state.workspace, "test-ws");
  assert.deepEqual(state.agents, {});
});

test("withState persists atomically and getState sees the committed value", async () => {
  const file = await scratchFile();
  const store = makeStore(file);
  await store.withState((state) => {
    state.autonomousTurns = 3;
  });
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(onDisk.autonomousTurns, 3);
  assert.equal((await store.getState()).autonomousTurns, 3);
  // no leftover temp files from the atomic write
  const siblings = await readdir(join(file, ".."));
  assert.deepEqual(siblings.filter((f) => f.endsWith(".tmp")), []);
});

test("concurrent withState mutators are serialized — no lost updates", async () => {
  const file = await scratchFile();
  const store = makeStore(file);
  await Promise.all(
    Array.from({ length: 50 }, () =>
      store.withState(async (state) => {
        const seen = state.autonomousTurns;
        await new Promise((r) => setImmediate(r)); // widen the race window
        state.autonomousTurns = seen + 1;
      }),
    ),
  );
  assert.equal((await store.getState()).autonomousTurns, 50);
  assert.equal(JSON.parse(await readFile(file, "utf8")).autonomousTurns, 50);
});

test("a throwing mutator commits nothing — memory and disk keep the previous state", async () => {
  const file = await scratchFile();
  const store = makeStore(file);
  await store.withState((state) => {
    state.autonomousTurns = 1;
  });
  await assert.rejects(
    store.withState((state) => {
      state.autonomousTurns = 999;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal((await store.getState()).autonomousTurns, 1);
  assert.equal(JSON.parse(await readFile(file, "utf8")).autonomousTurns, 1);
});

test("corrupt state.json is quarantined and a fresh state adopted", async () => {
  const file = await scratchFile();
  await writeFile(file, "{ this is not json", "utf8");
  const store = makeStore(file);
  const state = await store.getState();
  assert.equal(state.version, 1);
  const siblings = await readdir(join(file, ".."));
  assert.ok(siblings.some((f) => f.startsWith("state.json.corrupt-")), `expected quarantine file, got ${siblings}`);
});

test("recoverInterruptedRuns fails what was running and NEVER marks anything successful", () => {
  const state = freshState("ws", 0);
  const working: CrewAgent = {
    id: "a1",
    name: "Codex #1",
    origin: "managed",
    status: "working",
    currentRunId: "run-1",
    pid: 4242,
    nativeSessionId: "native-keep-me",
  };
  const observed: CrewAgent = { id: "a2", name: "Watcher", origin: "observed", status: "working" };
  const idle: CrewAgent = { id: "a3", name: "Idle", origin: "managed", status: "idle" };
  state.agents = { a1: working, a2: observed, a3: idle };
  const running: Assignment = {
    id: "as1",
    title: "t",
    instructions: "i",
    workspace: "ws",
    assignedBy: "manager",
    assignedTo: "a1",
    status: "running",
    createdAt: "2026-01-01T00:00:00Z",
    attempts: 1,
  };
  const done: Assignment = { ...running, id: "as2", status: "done", result: { summary: "finished earlier" } };
  state.assignments = { as1: running, as2: done };

  const report = recoverInterruptedRuns(state);

  assert.deepEqual(report.interruptedAgents.sort(), ["a1", "a2"]);
  assert.deepEqual(report.interruptedAssignments, ["as1"]);
  assert.equal(state.agents.a1.status, "failed"); // managed → failed
  assert.equal(state.agents.a1.currentRunId, undefined);
  assert.equal(state.agents.a1.pid, undefined);
  assert.equal(state.agents.a1.nativeSessionId, "native-keep-me"); // resumable
  assert.equal(state.agents.a2.status, "stopped"); // observed → merely stopped
  assert.equal(state.agents.a3.status, "idle"); // untouched
  assert.equal(state.assignments.as1.status, "failed");
  assert.match(state.assignments.as1.result?.summary ?? "", /interrupted/);
  assert.equal(state.assignments.as2.status, "done"); // completed work stays completed
  // The invariant spec §46 actually demands:
  for (const assignment of Object.values(state.assignments)) {
    assert.notEqual(assignment.status === "done" && assignment.id === "as1", true);
  }
});

/**
 * Defect G — a corrupt state.json used to be TOTAL SILENT AMNESIA.
 *
 * Quarantine worked; nothing else did. The daemon booted looking brand new — every agent,
 * assignment, message and nativeSessionId gone, `crew/*` branches and worktrees still on disk
 * with nothing left to say what produced them — and the user's only clue was a file they were
 * never going to look at.
 */
test("a quarantined state.json is REPORTED: what happened, where it went, what it cost", async () => {
  const file = await scratchFile();
  await writeFile(file, "{ this is not json", "utf8");
  const store = makeStore(file);
  await store.getState();

  const q = store.quarantine;
  assert.ok(q, "the loss was not reported anywhere");
  assert.match(q.reason, /not parseable/i);
  assert.ok(q.file.startsWith(`${file}.corrupt-`));
  assert.equal(q.bytes, "{ this is not json".length);
});

test("a state.json from a FUTURE schema is named as such, not as corruption — with the counts lost", async () => {
  const file = await scratchFile();
  const future = {
    version: 2,
    startedAt: "2026-01-01T00:00:00Z",
    workspace: "ws",
    port: 0,
    agents: { a1: {}, a2: {} },
    assignments: { as1: {} },
    messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
    autonomousTurns: 0,
    managerPaused: false,
  };
  await writeFile(file, JSON.stringify(future), "utf8");
  const store = makeStore(file);
  await store.getState();

  const q = store.quarantine;
  assert.ok(q);
  assert.match(q.reason, /version 2/);
  assert.deepEqual(q.lost, { agents: 2, assignments: 1, messages: 3 });
});

test("two quarantines inside the same millisecond do not overwrite each other's evidence", async () => {
  const file = await scratchFile();
  await writeFile(file, "{ torn one", "utf8");
  const first = makeStore(file);
  await first.getState();
  await writeFile(file, "{ torn two", "utf8");
  const second = makeStore(file);
  await second.getState();

  const names = (await readdir(join(file, ".."))).filter((f) => f.includes(".corrupt-"));
  assert.equal(names.length, 2, `one quarantine clobbered the other: ${names}`);
  assert.notEqual(first.quarantine!.file, second.quarantine!.file);
});

/**
 * Defect F — restart destroyed mail that had already been drained into the interrupted turn.
 *
 * mailbox.drain() marks messages read at the START of a turn; runAgentTurn restores them when
 * that turn fails, but only in-process. recoverInterruptedRuns never touched state.messages,
 * so a daemon that died mid-turn left a worker's result marked delivered to a manager that
 * never read it: no event, no retry, nothing — the exact bug class this project has already
 * fixed three times.
 */
test("recoverInterruptedRuns un-delivers the mail the dead turn had drained", async () => {
  const state = freshState("ws", 0);
  state.agents = {
    mgr: { id: "mgr", name: "Manager", origin: "managed", status: "working", currentRunId: "run-1" },
    idle: { id: "idle", name: "Idle", origin: "managed", status: "idle" },
  };
  const drainedAt = "2026-01-01T10:00:00.000Z";
  state.messages = [
    // Drained into the turn that died: the worker's finished result.
    { id: "m1", from: "w1", to: "mgr", workspace: "ws", kind: "result", body: "PR ready", createdAt: "2026-01-01T09:59:00.000Z", readAt: drainedAt },
    { id: "m2", from: "w2", to: "mgr", workspace: "ws", kind: "result", body: "tests green", createdAt: "2026-01-01T09:59:30.000Z", readAt: drainedAt },
    // An older batch the manager genuinely read and acted on in a previous, completed turn.
    { id: "m0", from: "w1", to: "mgr", workspace: "ws", kind: "message", body: "starting", createdAt: "2026-01-01T09:00:00.000Z", readAt: "2026-01-01T09:00:01.000Z" },
    // Not addressed to an interrupted agent.
    { id: "m9", from: "mgr", to: "idle", workspace: "ws", kind: "message", body: "fyi", createdAt: "2026-01-01T09:30:00.000Z", readAt: "2026-01-01T09:30:01.000Z" },
  ];

  const report = recoverInterruptedRuns(state);

  assert.deepEqual(report.restoredMessages.sort(), ["m1", "m2"]);
  const byId = Object.fromEntries(state.messages.map((m) => [m.id, m]));
  assert.equal(byId.m1.readAt, undefined, "the worker's result stayed marked delivered — it is lost");
  assert.equal(byId.m2.readAt, undefined);
  assert.equal(byId.m0.readAt, "2026-01-01T09:00:01.000Z", "an earlier, completed turn's mail must stay delivered");
  assert.equal(byId.m9.readAt, "2026-01-01T09:30:01.000Z", "mail to an untouched agent must not be resurrected");
});

/**
 * getState() used to hand back the LIVE object, so a "reader" that mutated what it got had
 * its change adopted by the next withState() and fsynced — with no mutator in the stack.
 */
test("getState hands back a copy: mutating it cannot reach disk", async () => {
  const file = await scratchFile();
  const store = makeStore(file);
  await store.withState((state) => {
    state.autonomousTurns = 1;
  });

  const reader = await store.getState();
  reader.autonomousTurns = 999;
  reader.agents["ghost"] = { id: "ghost", name: "ghost", origin: "managed", status: "idle" };

  await store.withState((state) => {
    state.managerPaused = true; // an unrelated, legitimate mutation
  });

  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(onDisk.autonomousTurns, 1, "a reader's mutation was persisted");
  assert.deepEqual(onDisk.agents, {}, "a reader's mutation was persisted");
  assert.equal((await store.getState()).autonomousTurns, 1);
});
