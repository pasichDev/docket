import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-roundtrip-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { decryptFromBuffer, decryptWithKey, encryptToBuffer, encryptWithKey } = await import("./crypto.js");
const { applyEdits, claimTodo, createTodo, tombstoneDelete } = await import("./mutations.js");
const { exportToJson, exportToMarkdown, importFromJson, importFromMarkdown } = await import("./export.js");
const { readStore, withStore } = await import("./storage.js");
const { mergeSyncPayload } = await import("./sync.js");
import type { SyncPayload } from "./sync.js";
import type { TodoStore } from "./types.js";

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

function emptyStore(): TodoStore {
  return { formatVersion: 8, nextId: 1, todos: [], deletedUuids: [], seqCounter: 0 };
}

/** A store exercising every field shape the format has, so a round trip can't pass by only carrying the easy ones. */
function richStore(): TodoStore {
  const store = emptyStore();
  const plain = createTodo(store, { title: "plain", agent: "codex", session: "s" }, "device-a", "A");
  const full = createTodo(
    store,
    {
      title: "everything set",
      description: "multi\nline\tbody with <markup> & \"quotes\"",
      list: "backlog",
      category: "VPQ-834",
      priority: "high",
      dueDate: "2026-12-01",
      sourceUrl: "https://gitlab.com/acme/backend/-/issues/1",
      workspace: "acme/backend",
      agent: "claude-code",
      session: "s2",
    },
    "device-b",
    "B",
  );
  applyEdits(store, full, { title: "everything set, then edited" }, "web", "device-b", "B");
  claimTodo(store, plain, "codex", "s3", "device-a", "A");
  const doomed = createTodo(store, { title: "deleted", agent: null, session: null }, "device-a", "A");
  tombstoneDelete(store, doomed, "device-a");
  return store;
}

test("round trip: a store survives save → load with every v8 field intact", async () => {
  const source = richStore();
  await withStore((store) => {
    store.todos = structuredClone(source.todos);
    store.deletedUuids = structuredClone(source.deletedUuids);
    store.nextId = source.nextId;
    store.seqCounter = source.seqCounter;
  });

  const loaded = await readStore();
  assert.equal(loaded.todos.length, source.todos.length);
  assert.equal(loaded.deletedUuids.length, source.deletedUuids.length);
  assert.equal(loaded.seqCounter, source.seqCounter, "the delivery counter must survive a restart, or every peer's cursor breaks");

  for (const original of source.todos) {
    const after = loaded.todos.find((t) => t.uuid === original.uuid)!;
    // Compared whole rather than field by field: a new field added later is then covered by
    // this test on the day it is added, instead of the day someone remembers to list it.
    assert.deepEqual({ ...after, history: undefined }, { ...original, history: undefined }, `${original.title} changed across a save/load`);
    assert.deepEqual(after.history, original.history, "history was not preserved");
  }
  assert.deepEqual(loaded.deletedUuids, source.deletedUuids);
});

test("round trip: encrypt → decrypt returns the exact bytes, for empty and for large input", async () => {
  const cases = ["", "{}", JSON.stringify(emptyStore()), JSON.stringify(richStore(), null, 2), "unicode ☃ ‮rtl‬ \0 nul", "x".repeat(2_000_000)];
  for (const plaintext of cases) {
    assert.equal(await decryptFromBuffer(await encryptToBuffer(plaintext)), plaintext, `mismatch for ${plaintext.length} bytes`);
  }
});

test("round trip: a payload merged twice changes nothing the second time", async () => {
  const local = emptyStore();
  const remote = richStore();
  const payload: SyncPayload = { todos: remote.todos, deletedUuids: remote.deletedUuids, serverTime: new Date().toISOString(), protocolVersion: 2 };

  const first = mergeSyncPayload(local, payload, "peer");
  const stateAfterFirst = JSON.stringify(local);
  const counterAfterFirst = local.seqCounter;

  const second = mergeSyncPayload(local, payload, "peer");
  assert.equal(second.inserted, 0, "re-merging inserted duplicates");
  assert.equal(second.updated, 0, "re-merging reported changes that did not happen");
  assert.equal(local.seqCounter, counterAfterFirst, "a repeat merge burned sequence numbers — every sync becomes a resend");
  assert.equal(JSON.stringify(local), stateAfterFirst, "a repeat merge changed the store");
  assert.ok(first.inserted > 0, "precondition: the first merge did something");
});

test("round trip: export → import preserves the live items and their fields", async () => {
  const source = richStore();
  const target = emptyStore();
  const { added } = importFromJson(target, exportToJson(source), "device-x", "X");

  assert.equal(added, source.todos.length);
  for (const original of source.todos) {
    const copy = target.todos.find((t) => t.title === original.title);
    assert.ok(copy, `${original.title} did not survive export → import`);
    assert.equal(copy.category, original.category);
    assert.equal(copy.priority, original.priority);
    assert.equal(copy.dueDate, original.dueDate);
    assert.equal(copy.sourceUrl, original.sourceUrl);
    assert.equal(copy.list, original.list);
    assert.equal(copy.done, original.done);
  }
});

test("round trip: export → import via Markdown keeps titles, lists and categories", () => {
  const source = richStore();
  const target = emptyStore();
  const { added } = importFromMarkdown(target, exportToMarkdown(source), "device-x", "X");
  assert.equal(added, source.todos.length);
  for (const original of source.todos) {
    const copy = target.todos.find((t) => t.title === original.title);
    assert.ok(copy, `${original.title} did not survive the Markdown round trip`);
    assert.equal(copy.list, original.list);
  }
});

test("round trip: importing the same file twice adds the items twice, and says so", () => {
  // Import is deliberately additive, not idempotent — it has no identity to match on, and
  // silently swallowing a second import would be worse than a visible duplicate. Pinned here
  // so the behaviour is a decision rather than a surprise.
  const target = emptyStore();
  const json = exportToJson(richStore());
  const first = importFromJson(target, json, "d", "D");
  const second = importFromJson(target, json, "d", "D");
  assert.equal(second.added, first.added);
  assert.equal(target.todos.length, first.added * 2);
});
