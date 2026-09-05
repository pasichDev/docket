import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-history-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { HISTORY_FLUSH_THRESHOLD, HISTORY_INLINE_MAX } = await import("./history.js");
const { fullHistoryFor, readHistoryLog } = await import("./history-store.js");
const { LocalTodoRepository } = await import("./repository.js");
const { withStore } = await import("./storage.js");
const { mergeSyncPayload } = await import("./sync/merge.js");

const repo = new LocalTodoRepository();
const context = { agent: "test", session: "s1", deviceId: "d1", deviceName: "Dev" };

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

/** Enough edits to push one item past the flush threshold, plus a couple for margin. */
const ENOUGH_TO_FLUSH = HISTORY_FLUSH_THRESHOLD + 2;

test("history: an item below the flush threshold never touches the side file at all", async () => {
  const todo = await repo.create({ title: "short-lived" }, context);
  await repo.edit(todo.id, { title: "renamed" }, context);

  const entries = await fullHistoryFor(todo.uuid, (await repo.get(todo.id))!.history);
  assert.equal(entries.length, 2, "created + edited");
  await assert.rejects(() => stat(join(dataDirectory, "history.json.enc")), "no flush means no side file was written");
});

test("history: flushing is batched, not per-write — the side file is rewritten rarely", async () => {
  const todo = await repo.create({ title: "busy item" }, context);
  for (let i = 0; i < HISTORY_FLUSH_THRESHOLD - 2; i++) await repo.edit(todo.id, { title: `edit ${i}` }, context);

  assert.equal((await readHistoryLog()).entries[todo.uuid], undefined, "well past the preview size and still not flushed");
  assert.ok(
    (await repo.get(todo.id))!.history.length > HISTORY_INLINE_MAX,
    "entries accumulate inline between flushes — that is what makes the rewrite amortised",
  );
});

test("history: past the threshold, entries move to the side file and the full log stays complete", async () => {
  const todo = await repo.create({ title: "very busy item" }, context);
  for (let i = 0; i < ENOUGH_TO_FLUSH; i++) await repo.edit(todo.id, { title: `edit ${i}` }, context);

  // The flush fires on the write that crosses the threshold and trims to the preview; the
  // writes after it accumulate again. So the item holds the preview plus that remainder —
  // bounded and small, which is the guarantee, rather than an exact number.
  const stored = (await repo.get(todo.id))!;
  assert.ok(stored.history.length <= HISTORY_FLUSH_THRESHOLD, `item still holds ${stored.history.length} entries inline`);
  assert.ok(stored.history.length < ENOUGH_TO_FLUSH, "the bulk of the log has moved out of the store");

  const full = await repo.history(todo.id);
  assert.equal(full.length, ENOUGH_TO_FLUSH + 1, "created + every edit, none lost");
  assert.equal(full[0].action, "created", "and still in order, oldest first");
  assert.deepEqual(full.slice(-stored.history.length), stored.history, "what is inline is exactly the tail of the full log");
});

test("history: repeated flushes don't duplicate entries already in the side file", async () => {
  const todo = await repo.create({ title: "flushed twice" }, context);
  for (let i = 0; i < ENOUGH_TO_FLUSH; i++) await repo.edit(todo.id, { title: `a${i}` }, context);
  const afterFirst = await repo.history(todo.id);
  for (let i = 0; i < ENOUGH_TO_FLUSH; i++) await repo.edit(todo.id, { title: `b${i}` }, context);
  const afterSecond = await repo.history(todo.id);

  assert.equal(afterFirst.length, ENOUGH_TO_FLUSH + 1);
  assert.equal(afterSecond.length, ENOUGH_TO_FLUSH * 2 + 1, "each flush adds exactly the new entries, never re-adds old ones");
});

test("history: deleting an item drops its audit log rather than leaving it behind", async () => {
  const todo = await repo.create({ title: "to be deleted" }, context);
  for (let i = 0; i < ENOUGH_TO_FLUSH; i++) await repo.edit(todo.id, { title: `edit ${i}` }, context);
  assert.ok((await readHistoryLog()).entries[todo.uuid], "precondition: the log exists before the delete");

  await repo.delete(todo.id, context);
  assert.equal((await readHistoryLog()).entries[todo.uuid], undefined, "an item's history must not outlive the item");
});

/**
 * A tombstone can coexist with a live item: a peer's deletion that LOSES to a newer local
 * edit is still recorded, and the item survives. Pruning on the tombstone alone would then
 * wipe the audit log of an item still sitting in the list — history loss with no deletion.
 */
test("history: a tombstone that lost to a newer edit does not take the live item's log with it", async () => {
  const todo = await repo.create({ title: "resurrected" }, context);
  for (let i = 0; i < ENOUGH_TO_FLUSH; i++) await repo.edit(todo.id, { title: `edit ${i}` }, context);
  assert.ok((await readHistoryLog()).entries[todo.uuid], "precondition: the log was flushed");

  // A peer deleted it, but our copy was edited after that instant, so the item stays.
  await withStore((store) => {
    const payload = {
      todos: [],
      deletedUuids: [{ uuid: todo.uuid, deletedAt: "2020-01-01T00:00:00.000Z", deviceId: "peer", localSeq: 0 }],
      serverTime: new Date().toISOString(),
      protocolVersion: 2,
    };
    mergeSyncPayload(store, payload, "peer");
  });

  const stillThere = await repo.get(todo.id);
  assert.ok(stillThere, "precondition: the newer local edit won, so the item is still live");
  assert.ok((await readHistoryLog()).entries[todo.uuid], "a live item's audit log must survive a losing tombstone");
});

/**
 * A peer only sends the tail of its history. Trimming the merged result to the preview
 * length would delete local entries that had never been flushed — an item below the
 * threshold keeps its whole log inline and nowhere else.
 */
test("history: merging a peer's recent entries does not destroy unflushed local ones", async () => {
  const todo = await repo.create({ title: "merge target" }, context);
  await repo.edit(todo.id, { title: "a local edit worth keeping" }, context);
  const before = (await repo.get(todo.id))!;
  assert.ok(before.history.length <= HISTORY_INLINE_MAX, "precondition: nothing flushed yet");

  const remote = {
    ...structuredClone(before),
    history: Array.from({ length: 6 }, (_, i) => ({
      at: new Date(Date.now() + (i + 1) * 1000).toISOString(),
      agent: "peer",
      deviceName: "Peer",
      action: "edited" as const,
      detail: `remote change ${i}`,
    })),
  };
  await withStore((store) => {
    mergeSyncPayload(store, { todos: [remote], deletedUuids: [], serverTime: new Date().toISOString(), protocolVersion: 2 }, "peer");
  });

  const full = await repo.history(todo.id);
  const details = full.map((h) => h.detail);
  assert.ok(details.includes('title: "merge target"'), "the local creation entry must survive the merge");
  assert.ok(details.some((d) => d.includes("a local edit worth keeping")), "and so must the local edit");
  assert.ok(details.includes("remote change 5"), "alongside the peer's entries");
});
