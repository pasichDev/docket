import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEdits,
  claimTodo,
  completeTodo,
  createTodo,
  formatAgentIdentity,
  isClaimActive,
  isSafeUrl,
  leaseExpiry,
  releaseTodo,
  shortId,
  tombstoneDelete,
  touch,
} from "./mutations.js";
import type { TodoStore } from "./types.js";

function emptyStore(): TodoStore {
  return { formatVersion: 5, nextId: 1, todos: [], deletedUuids: [] };
}

test("shortId: deterministic (identical for the same uuid, regardless of which device computes it)", () => {
  const uuid = "01926f3e-1234-7890-abcd-ef0123456789";
  assert.equal(shortId(uuid), shortId(uuid));
  assert.match(shortId(uuid), /^T-[2-9A-HJ-NP-Z]{6}$/); // no 0/O/1/I/L, matching the pairing-code charset
});

test("shortId: two UUIDv7s created moments apart (sharing a timestamp prefix) still get well-spread short ids", () => {
  const a = "01926f3e-0001-7890-abcd-ef0123456789";
  const b = "01926f3e-0002-7890-abcd-ef0123456789"; // differs only in one low byte, like real close-in-time UUIDv7s
  assert.notEqual(shortId(a), shortId(b));
});

test("formatAgentIdentity: combines agent and device as agent@device", () => {
  assert.equal(formatAgentIdentity("codex", "ryzen"), "codex@ryzen");
  assert.equal(formatAgentIdentity("claude-code", "MacBook Pro"), "claude-code@MacBook Pro");
});

test("formatAgentIdentity: falls back gracefully when either half is missing", () => {
  assert.equal(formatAgentIdentity("codex", null), "codex");
  assert.equal(formatAgentIdentity(null, "ryzen"), "ryzen");
  assert.equal(formatAgentIdentity(null, null), "unknown");
  assert.equal(formatAgentIdentity("  ", "  "), "unknown"); // whitespace-only treated as absent
});

test("createTodo: stamps identity, timestamps, and device fields", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "Buy milk", agent: "claude-code", session: "abc123" }, "device-1", "MacBook");
  assert.equal(todo.id, 1);
  assert.match(todo.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(todo.title, "Buy milk");
  assert.equal(todo.done, false);
  assert.equal(todo.list, "todo");
  assert.equal(todo.deviceId, "device-1");
  assert.equal(todo.deviceName, "MacBook");
  assert.equal(todo.updatedAt, todo.createdAt);
  assert.equal(todo.history.length, 1);
  assert.equal(todo.history[0].action, "created");
  assert.equal(store.nextId, 2);
  assert.equal(store.todos.length, 1);
});

test("createTodo: defaults optional fields to null, not undefined", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");
  assert.equal(todo.description, null);
  assert.equal(todo.category, null);
  assert.equal(todo.priority, null);
  assert.equal(todo.dueDate, null);
  assert.equal(todo.sourceUrl, null);
  assert.equal(todo.workingAgent, null);
  assert.equal(todo.workingLeaseExpiresAt, null);
});

test("touch: bumps updatedAt/device and stamps only the fields actually changed", async () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "device-1", "One");
  const createdAt = todo.updatedAt;
  await new Promise((r) => setTimeout(r, 2));
  touch(todo, "device-2", "Two", ["title", "priority"]);
  assert.ok(todo.updatedAt > createdAt);
  assert.equal(todo.deviceId, "device-2");
  assert.equal(todo.deviceName, "Two");
  assert.ok(todo.fieldTimestamps.title);
  assert.ok(todo.fieldTimestamps.priority);
  assert.equal(todo.fieldTimestamps.description, undefined);
});

test("tombstoneDelete: removes the item and records a tombstone", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");
  tombstoneDelete(store, todo, "d");
  assert.equal(store.todos.length, 0);
  assert.equal(store.deletedUuids.length, 1);
  assert.equal(store.deletedUuids[0].uuid, todo.uuid);
  assert.equal(store.deletedUuids[0].deviceId, "d");
});

test("isClaimActive: false with no claim, true with no expiry set (back-compat), false past its lease", () => {
  assert.equal(isClaimActive({ workingAgent: null, workingLeaseExpiresAt: null }), false);
  assert.equal(isClaimActive({ workingAgent: "claude-code", workingLeaseExpiresAt: null }), true);
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(isClaimActive({ workingAgent: "claude-code", workingLeaseExpiresAt: future }), true);
  assert.equal(isClaimActive({ workingAgent: "claude-code", workingLeaseExpiresAt: past }), false);
});

test("leaseExpiry: returns a timestamp in the future", () => {
  assert.ok(leaseExpiry() > new Date().toISOString());
});

test("applyEdits: applies only the fields that actually change, and stamps only those", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "Old", category: "cat", agent: null, session: null }, "d", "n");

  const changed = applyEdits(todo, { title: "New", category: "cat" }, "web", "d2", "n2");
  assert.equal(changed, true);
  assert.equal(todo.title, "New");
  assert.ok(todo.fieldTimestamps.title);
  assert.equal(todo.fieldTimestamps.category, undefined, "an unchanged field must not be stamped");
  assert.equal(todo.history.length, 2);
  assert.equal(todo.history[1].action, "edited");
  assert.match(todo.history[1].detail, /title: Old → New/);
});

test("applyEdits: null clears a field, undefined leaves it alone", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", description: "keep me", category: "drop me", agent: null, session: null }, "d", "n");

  applyEdits(todo, { category: null }, "web", "d", "n");
  assert.equal(todo.category, null);
  assert.equal(todo.description, "keep me");
});

test("applyEdits: a no-op patch changes nothing and records no history", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");
  const before = todo.updatedAt;

  assert.equal(applyEdits(todo, { title: "x", description: undefined }, "web", "d2", "n2"), false);
  assert.equal(todo.history.length, 1, "only the original 'created' entry");
  assert.equal(todo.updatedAt, before, "updatedAt must not move when nothing changed");
});

test("claimTodo: reports the previous active claim it took over, and null when the item was free", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");

  assert.equal(claimTodo(todo, "claude-code", "s1", "d", "n"), null);
  assert.equal(todo.workingAgent, "claude-code");
  assert.equal(todo.workingSession, "s1");
  assert.ok(isClaimActive(todo));

  assert.equal(claimTodo(todo, "codex", "s2", "d", "n"), "claude-code");
  assert.match(todo.history.at(-1)!.detail, /took over from claude-code/);
});

test("claimTodo: the same claimant calling again renews the lease without resetting workingSince (heartbeat)", async () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");

  claimTodo(todo, "codex", "s1", "d", "n");
  const originalSince = todo.workingSince;
  const originalExpiry = todo.workingLeaseExpiresAt;

  await new Promise((r) => setTimeout(r, 5));
  assert.equal(claimTodo(todo, "codex", "s1", "d", "n"), "codex", "renewal still reports the (unchanged) claimant, not null");
  assert.equal(todo.workingSince, originalSince, "workingSince must survive a renewal — it's when the work actually started");
  assert.ok(todo.workingLeaseExpiresAt! > originalExpiry!, "the lease itself must actually be extended");
  assert.match(todo.history.at(-1)!.detail, /lease renewed/);
});

test("claimTodo: a different SESSION from the same agent name is NOT a renewal (two host sessions can share an agent name) — workingSince resets", async () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");

  claimTodo(todo, "codex", "s1", "d", "n");
  const originalSince = todo.workingSince;
  await new Promise((r) => setTimeout(r, 5));
  claimTodo(todo, "codex", "s2", "d", "n");
  assert.notEqual(todo.workingSince, originalSince, "a different session is a fresh claim, not a heartbeat — workingSince should reset");
  assert.equal(todo.workingSession, "s2");
  assert.doesNotMatch(todo.history.at(-1)!.detail, /lease renewed/);
});

test("releaseTodo / completeTodo: both clear the whole claim", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");

  claimTodo(todo, "claude-code", "s1", "d", "n");
  releaseTodo(todo, "claude-code", "d", "n");
  assert.equal(todo.workingAgent, null);
  assert.equal(todo.workingSince, null);
  assert.equal(todo.workingSession, null);
  assert.equal(todo.workingLeaseExpiresAt, null);
  assert.equal(todo.done, false);

  claimTodo(todo, "claude-code", "s1", "d", "n");
  completeTodo(todo, "web", "d", "n");
  assert.equal(todo.done, true);
  assert.ok(todo.completedAt);
  assert.equal(todo.workingAgent, null);
  assert.equal(todo.workingLeaseExpiresAt, null);
  assert.ok(todo.fieldTimestamps.done);
  assert.ok(todo.fieldTimestamps.workingAgent);
});

test("isSafeUrl: allows http/https, rejects javascript:/data:/vbscript: and garbage", () => {
  assert.equal(isSafeUrl("https://github.com/org/repo/issues/1"), true);
  assert.equal(isSafeUrl("http://192.168.1.1:8787"), true);
  assert.equal(isSafeUrl("javascript:alert(document.cookie)"), false);
  assert.equal(isSafeUrl("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isSafeUrl("vbscript:msgbox(1)"), false);
  assert.equal(isSafeUrl("not a url"), false);
});

test("createTodo: a javascript: sourceUrl is dropped, not stored (XSS guard)", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", sourceUrl: "javascript:alert(1)", agent: null, session: null }, "d", "n");
  assert.equal(todo.sourceUrl, null);
});

test("applyEdits: a javascript: sourceUrl patch is dropped, not stored (XSS guard)", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");
  applyEdits(todo, { sourceUrl: "javascript:alert(1)" }, "web", "d", "n");
  assert.equal(todo.sourceUrl, null);
});
