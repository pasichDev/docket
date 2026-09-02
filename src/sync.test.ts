import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTodo, touch } from "./mutations.js";
import type { Todo, TodoStore } from "./types.js";

const originalDataDirectory = process.env.TODO_MCP_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "todo-mcp-sync-test-"));
process.env.TODO_MCP_DATA_DIR = dataDirectory;
const {
  confirmProof,
  decryptSyncPayload,
  encryptSyncPayload,
  mergeSyncPayload,
  signSyncRequest,
  verifyConfirmProof,
  verifySyncRequest,
} = await import("./sync.js");
import type { SyncPayload } from "./sync.js";

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.TODO_MCP_DATA_DIR;
  else process.env.TODO_MCP_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

function emptyStore(): TodoStore {
  return { formatVersion: 5, nextId: 1, todos: [], deletedUuids: [] };
}

function payloadFrom(todos: Todo[]): SyncPayload {
  return { todos, deletedUuids: [], serverTime: new Date().toISOString() };
}

test("mergeSyncPayload: inserts a remote-only item under a fresh local id", () => {
  const remoteStore = emptyStore();
  const remoteTodo = createTodo(remoteStore, { title: "From peer", agent: null, session: null }, "peer-device", "Peer");

  const local = emptyStore();
  const existing = createTodo(local, { title: "Local item", agent: null, session: null }, "my-device", "Me");
  assert.equal(existing.id, 1);

  const result = mergeSyncPayload(local, payloadFrom([remoteTodo]), "peer-device");
  assert.equal(result.inserted, 1);
  assert.equal(local.todos.length, 2);
  const inserted = local.todos.find((t) => t.uuid === remoteTodo.uuid)!;
  assert.equal(inserted.id, 2); // gets the NEXT local id, never collides with the existing #1
  assert.equal(inserted.title, "From peer");
});

test("mergeSyncPayload: two independent edits to DIFFERENT fields both survive (regression: this used to silently drop one)", async () => {
  const seedStore = emptyStore();
  const base = createTodo(seedStore, { title: "Shared item", agent: null, session: null }, "device-a", "A");

  // Local (device A) side: already has the base item, then edits priority.
  const local = emptyStore();
  local.nextId = 2;
  local.todos = [structuredClone(base)];
  await new Promise((r) => setTimeout(r, 2));
  const localItem = local.todos[0];
  localItem.priority = "high";
  touch(localItem, "device-a", "A", ["priority"]);

  // Remote (device B) side: same base item, edits description instead — after A's edit.
  await new Promise((r) => setTimeout(r, 2));
  const remoteItem = structuredClone(base);
  remoteItem.description = "added on B";
  touch(remoteItem, "device-b", "B", ["description"]);

  const result = mergeSyncPayload(local, payloadFrom([remoteItem]), "device-b");
  assert.equal(result.updated, 1);
  assert.equal(local.todos[0].priority, "high", "A's priority edit must survive");
  assert.equal(local.todos[0].description, "added on B", "B's description edit must also survive");
});

test("mergeSyncPayload: a field last-touched more recently locally is NOT overwritten by an older remote value", async () => {
  const seedStore = emptyStore();
  const base = createTodo(seedStore, { title: "x", agent: null, session: null }, "device-a", "A");

  const local = emptyStore();
  local.todos = [structuredClone(base)];
  await new Promise((r) => setTimeout(r, 5));
  touch(local.todos[0], "device-a", "A", ["title"]);
  local.todos[0].title = "Edited locally, later";

  // Remote's copy is the OLD version (its title field was never touched after creation).
  const remoteItem = structuredClone(base);

  mergeSyncPayload(local, payloadFrom([remoteItem]), "device-b");
  assert.equal(local.todos[0].title, "Edited locally, later");
});

test("mergeSyncPayload: a remote tombstone deletes a local item that hasn't changed since", () => {
  const local = emptyStore();
  const item = createTodo(local, { title: "to be deleted", agent: null, session: null }, "device-a", "A");

  const tombstonePayload: SyncPayload = {
    todos: [],
    deletedUuids: [{ uuid: item.uuid, deletedAt: new Date(Date.now() + 1000).toISOString(), deviceId: "device-b" }],
    serverTime: new Date().toISOString(),
  };
  const result = mergeSyncPayload(local, tombstonePayload, "device-b");
  assert.equal(result.deleted, 1);
  assert.equal(local.todos.length, 0);
});

test("mergeSyncPayload: an edit AFTER a peer's delete resurrects the item (edit-after-delete wins)", () => {
  const local = emptyStore();
  local.deletedUuids = [{ uuid: "some-uuid", deletedAt: "2020-01-01T00:00:00.000Z", deviceId: "device-a" }];

  const remoteItem: Todo = {
    id: 1,
    uuid: "some-uuid",
    title: "Edited after being deleted elsewhere",
    description: null,
    done: false,
    list: "todo",
    category: null,
    priority: null,
    dueDate: null,
    sourceUrl: null,
    agent: null,
    session: null,
    workingAgent: null,
    workingSince: null,
    workingSession: null,
    workingLeaseExpiresAt: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", // long after the tombstone
    fieldTimestamps: {},
    completedAt: null,
    deviceId: "device-b",
    deviceName: "B",
    history: [],
  };

  const result = mergeSyncPayload(local, payloadFrom([remoteItem]), "device-b");
  assert.equal(result.inserted, 1);
  assert.equal(local.todos.length, 1);
  assert.equal(local.todos[0].title, "Edited after being deleted elsewhere");
});

test("mergeSyncPayload: rejects malformed items instead of crashing or inserting garbage", () => {
  const local = emptyStore();
  const payload = { todos: [{ not: "a todo" }, null, "garbage"], deletedUuids: [], serverTime: new Date().toISOString() } as unknown as SyncPayload;
  const result = mergeSyncPayload(local, payload, "device-b");
  assert.equal(result.inserted, 0);
  assert.equal(local.todos.length, 0);
});

test("signSyncRequest/verifySyncRequest: valid signature within the time window verifies", () => {
  const secret = "test-secret";
  const timestamp = new Date().toISOString();
  const sig = signSyncRequest(secret, "device-a", "1970-01-01T00:00:00.000Z", timestamp);
  assert.ok(verifySyncRequest(secret, "device-a", "1970-01-01T00:00:00.000Z", timestamp, sig));
});

test("verifySyncRequest: rejects a tampered signature", () => {
  const secret = "test-secret";
  const timestamp = new Date().toISOString();
  const sig = signSyncRequest(secret, "device-a", "1970-01-01T00:00:00.000Z", timestamp);
  assert.equal(verifySyncRequest(secret, "device-a", "1970-01-01T00:00:00.000Z", timestamp, sig + "x"), false);
});

test("verifySyncRequest: rejects the wrong secret", () => {
  const timestamp = new Date().toISOString();
  const sig = signSyncRequest("secret-a", "device-a", "1970-01-01T00:00:00.000Z", timestamp);
  assert.equal(verifySyncRequest("secret-b", "device-a", "1970-01-01T00:00:00.000Z", timestamp, sig), false);
});

test("verifySyncRequest: rejects a stale timestamp (replay protection)", () => {
  const secret = "test-secret";
  const oldTimestamp = new Date(Date.now() - 10 * 60_000).toISOString();
  const sig = signSyncRequest(secret, "device-a", "1970-01-01T00:00:00.000Z", oldTimestamp);
  assert.equal(verifySyncRequest(secret, "device-a", "1970-01-01T00:00:00.000Z", oldTimestamp, sig), false);
});

test("confirmProof/verifyConfirmProof: valid proof verifies, wrong secret does not", () => {
  const proof = confirmProof("shared-secret", "req-1");
  assert.ok(verifyConfirmProof("shared-secret", "req-1", proof));
  assert.equal(verifyConfirmProof("different-secret", "req-1", proof), false);
});

test("encryptSyncPayload/decryptSyncPayload: round-trips and the wire format is not readable JSON", () => {
  const secret = "a".repeat(64); // 32 bytes hex
  const payload = payloadFrom([]);
  const wire = encryptSyncPayload(secret, payload);
  assert.equal(typeof wire.encrypted, "string");
  assert.throws(() => JSON.parse(Buffer.from(wire.encrypted, "base64").toString("utf8")), "the wire bytes must not be parseable as plaintext JSON");
  const decrypted = decryptSyncPayload(secret, wire.encrypted);
  assert.deepEqual(decrypted, payload);
});
