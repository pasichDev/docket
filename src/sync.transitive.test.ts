import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdits, createTodo, stampSeq } from "./mutations.js";
import type { TodoStore } from "./types.js";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-transitive-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { buildSyncPayload, mergeSyncPayload } = await import("./sync.js");

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

function emptyStore(): TodoStore {
  return { formatVersion: 8, nextId: 1, todos: [], deletedUuids: [], seqCounter: 0 };
}

/**
 * One peer pulling from another, entirely in memory: the puller's cursor into the
 * remote's sequence space in, the puller's new cursor out. No HTTP, no crypto — the
 * delivery rule is the thing under test, and standing up two servers to exercise it
 * would only add ways for the test to fail for unrelated reasons.
 */
function pull(from: TodoStore, into: TodoStore, cursor: number, peerId: string): number {
  const payload = buildSyncPayload(from, cursor);
  mergeSyncPayload(into, payload, peerId);
  return payload.maxSeq ?? cursor;
}

/**
 * The bug this whole format bump exists for. `updatedAt` used to do two jobs at once —
 * "when did the author change this?" (merge resolution) and "what have I not seen yet?"
 * (delivery cursor) — and merging copies the AUTHOR's updatedAt onto the local record.
 * So an item that reaches B second-hand lands in B's store already timestamped in A's
 * past, underneath A's cursor for B, and A never hears about it at all.
 *
 * A and C are deliberately NOT paired: B is the only path between them, which is exactly
 * the topology (laptop ↔ desktop ↔ work machine) where this silently loses real edits.
 */
test("sync: an edit made on C reaches A through B, even though A and C were never paired", () => {
  const a = emptyStore();
  const b = emptyStore();
  const c = emptyStore();

  // C creates and edits an item. Nothing else in the mesh knows about it yet.
  const x = createTodo(c, { title: "written on C", agent: "codex", session: "s" }, "device-c", "C");
  applyEdits(c, x, { description: "edited on C" }, "codex", "device-c", "C");

  // A pulls from B first, while B is still empty — its cursor for B advances anyway.
  // (This is the step that used to poison A: the cursor moved past "now" without B
  // having anything to say yet.)
  let aCursorForB = pull(b, a, 0, "device-b");

  // B then learns about the item from C.
  const bCursorForC = pull(c, b, 0, "device-c");
  assert.equal(b.todos.length, 1, "B must have received the item from C");
  assert.ok(bCursorForC > 0);

  // A pulls from B again. The item is new to A, and must arrive.
  aCursorForB = pull(b, a, aCursorForB, "device-b");

  const received = a.todos.find((t) => t.uuid === x.uuid);
  assert.ok(received, "A never received C's item — a third device's edit was lost in transit through B");
  assert.equal(received.description, "edited on C");
});

test("sync: accepting a peer's change is a local write and gets a local sequence number", () => {
  const a = emptyStore();
  const b = emptyStore();

  const x = createTodo(b, { title: "from B", agent: null, session: null }, "device-b", "B");
  pull(b, a, 0, "device-b");

  const merged = a.todos.find((t) => t.uuid === x.uuid)!;
  assert.ok(merged.localSeq > 0, "an inserted record must be stamped with THIS device's next sequence number");
  assert.equal(merged.localSeq, a.seqCounter, "and that number must be the store's current high-water mark");
});

test("sync: localSeq is per-device and never travels between devices", () => {
  const a = emptyStore();
  const b = emptyStore();

  // Give A a head start so the two stores' counters are genuinely out of step.
  for (let i = 0; i < 5; i++) createTodo(a, { title: `local ${i}`, agent: null, session: null }, "device-a", "A");
  const x = createTodo(b, { title: "from B", agent: null, session: null }, "device-b", "B");
  assert.equal(x.localSeq, 1);

  pull(b, a, 0, "device-b");
  const merged = a.todos.find((t) => t.uuid === x.uuid)!;
  assert.equal(merged.localSeq, 6, "the record takes A's next number, not the 1 it carried from B");
});

/**
 * A second deletion of an item that was already deleted once and then resurrected by a
 * later edit. The tombstone for that uuid already exists locally, so the "stamp every
 * newly added tombstone" rule doesn't fire — and without a sequence number the newer
 * deletion never leaves this device. The third peer keeps comparing its edits against the
 * ORIGINAL deletedAt, decides its copy is newer, and resurrects the item forever.
 */
test("sync: a LATER deletion of an already-tombstoned item is adopted, sequenced, and handed on", () => {
  const a = emptyStore();
  const b = emptyStore();
  const c = emptyStore();

  // Everyone has X.
  const x = createTodo(c, { title: "contested", agent: null, session: null }, "device-c", "C");
  let bFromC = pull(c, b, 0, "device-c");
  let aFromB = pull(b, a, 0, "device-b");
  assert.equal(a.todos.length, 1);

  // C deletes it, then a later edit elsewhere resurrects it — so every store now holds
  // BOTH the item and a tombstone for its uuid.
  c.deletedUuids.push({ uuid: x.uuid, deletedAt: "2026-01-01T00:00:00.000Z", deviceId: "device-c", localSeq: 0 });
  stampSeq(c, c.deletedUuids[0]);
  bFromC = pull(c, b, bFromC, "device-c");
  aFromB = pull(b, a, aFromB, "device-b");
  assert.equal(a.deletedUuids.length, 1, "A holds the first tombstone");
  assert.equal(a.todos.length, 1, "…and still holds the item, whose edit is newer");

  // C deletes it again, later than any edit. This must reach A through B.
  const secondDeletion = new Date(Date.now() + 60_000).toISOString();
  c.deletedUuids.push({ uuid: x.uuid, deletedAt: secondDeletion, deviceId: "device-c", localSeq: 0 });
  stampSeq(c, c.deletedUuids.at(-1)!);
  bFromC = pull(c, b, bFromC, "device-c");
  assert.equal(b.todos.length, 0, "B applies the newer deletion");

  aFromB = pull(b, a, aFromB, "device-b");
  assert.equal(a.todos.length, 0, "A never heard about the second deletion and kept a deleted item");
});
