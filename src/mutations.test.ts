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
  return { formatVersion: 8, nextId: 1, todos: [], deletedUuids: [], seqCounter: 0 };
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
  touch(store, todo, "device-2", "Two", ["title", "priority"]);
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

  const changed = applyEdits(store, todo, { title: "New", category: "cat" }, "web", "d2", "n2");
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

  applyEdits(store, todo, { category: null }, "web", "d", "n");
  assert.equal(todo.category, null);
  assert.equal(todo.description, "keep me");
});

test("applyEdits: a no-op patch changes nothing and records no history", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");
  const before = todo.updatedAt;

  assert.equal(applyEdits(store, todo, { title: "x", description: undefined }, "web", "d2", "n2"), false);
  assert.equal(todo.history.length, 1, "only the original 'created' entry");
  assert.equal(todo.updatedAt, before, "updatedAt must not move when nothing changed");
});

test("claimTodo: reports the previous active claim it took over, and null when the item was free", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");

  assert.equal(claimTodo(store, todo, "claude-code", "s1", "d", "n"), null);
  assert.equal(todo.workingAgent, "claude-code");
  assert.equal(todo.workingSession, "s1");
  assert.ok(isClaimActive(todo));

  assert.equal(claimTodo(store, todo, "codex", "s2", "d", "n"), "claude-code");
  assert.match(todo.history.at(-1)!.detail, /took over from claude-code/);
});

test("claimTodo: the same claimant calling again renews the lease without resetting workingSince (heartbeat)", async () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");

  claimTodo(store, todo, "codex", "s1", "d", "n");
  const originalSince = todo.workingSince;
  const originalExpiry = todo.workingLeaseExpiresAt;
  const historyLength = todo.history.length;

  await new Promise((r) => setTimeout(r, 5));
  assert.equal(claimTodo(store, todo, "codex", "s1", "d", "n"), "codex", "renewal still reports the (unchanged) claimant, not null");
  assert.equal(todo.workingSince, originalSince, "workingSince must survive a renewal — it's when the work actually started");
  assert.ok(todo.workingLeaseExpiresAt! > originalExpiry!, "the lease itself must actually be extended");
  // Since v3.0 a renewal writes NO history: it is the absence of an event, and at one
  // heartbeat every few minutes per active item it was the main driver of history growth
  // that every unrelated write then paid for.
  assert.equal(todo.history.length, historyLength, "a renewal must not append a history entry");
});

test("claimTodo: a different SESSION from the same agent name is NOT a renewal (two host sessions can share an agent name) — workingSince resets", async () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");

  claimTodo(store, todo, "codex", "s1", "d", "n");
  const originalSince = todo.workingSince;
  await new Promise((r) => setTimeout(r, 5));
  claimTodo(store, todo, "codex", "s2", "d", "n");
  assert.notEqual(todo.workingSince, originalSince, "a different session is a fresh claim, not a heartbeat — workingSince should reset");
  assert.equal(todo.workingSession, "s2");
  assert.doesNotMatch(todo.history.at(-1)!.detail, /lease renewed/);
});

test("releaseTodo / completeTodo: both clear the whole claim", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");

  claimTodo(store, todo, "claude-code", "s1", "d", "n");
  releaseTodo(store, todo, "claude-code", "d", "n");
  assert.equal(todo.workingAgent, null);
  assert.equal(todo.workingSince, null);
  assert.equal(todo.workingSession, null);
  assert.equal(todo.workingLeaseExpiresAt, null);
  assert.equal(todo.done, false);

  claimTodo(store, todo, "claude-code", "s1", "d", "n");
  completeTodo(store, todo, "web", "d", "n");
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
  applyEdits(store, todo, { sourceUrl: "javascript:alert(1)" }, "web", "d", "n");
  assert.equal(todo.sourceUrl, null);
});

/**
 * Found by sync.convergence.property.test.ts, seed 4.
 *
 * A device whose clock lags stamps its edit EARLIER than the version it just changed. Every
 * peer then compares the two, judges its own copy newer, and discards the edit — so the
 * editing device is the only one in the mesh that ever sees its own change. If it goes on
 * to delete the item, that is ignored too, and the item is gone locally while alive
 * everywhere else, permanently.
 *
 * The property test cannot guard this: it has to model a skewed clock, and modelling it
 * means applying the same clamp, which hides the production one being removed.
 */
test("a lagging clock must not stamp an edit BEFORE the version it edits", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");

  // The item carries a timestamp from a device whose clock runs ahead of this one.
  const fromTheFuture = new Date(Date.now() + 90_000).toISOString();
  todo.updatedAt = fromTheFuture;
  todo.fieldTimestamps = { title: fromTheFuture };

  applyEdits(store, todo, { title: "edited on the slow machine" }, "web", "d", "n");

  assert.ok(todo.updatedAt > fromTheFuture, `updatedAt went backwards: ${todo.updatedAt} <= ${fromTheFuture}`);
  assert.ok(
    todo.fieldTimestamps.title! > fromTheFuture,
    "the per-field clock must move forward too, or the field merge discards this edit while the record looks updated",
  );
});

/**
 * Found by sync.convergence.property.test.ts, seed 1.
 *
 * Same failure one step further on: a deletion stamped before the version it deletes is
 * ignored by every other device, so the item stays alive everywhere except on the machine
 * that deleted it — which cannot get it back, because its delivery cursor has already moved
 * past the peers' copies.
 */
test("a lagging clock must not stamp a deletion BEFORE the version it deletes", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");
  const fromTheFuture = new Date(Date.now() + 90_000).toISOString();
  todo.updatedAt = fromTheFuture;

  tombstoneDelete(store, todo, "d");

  const tombstone = store.deletedUuids.at(-1)!;
  assert.ok(
    tombstone.deletedAt > fromTheFuture,
    `tombstone (${tombstone.deletedAt}) does not supersede the version it deletes (${fromTheFuture}) — every peer will ignore this deletion`,
  );
});

/**
 * Killed mutant: `wallClock > floor` → `>=`, and `Date.parse(floor) + 1` → a large jump.
 *
 * Two writes inside the same millisecond read the same wall clock, so the second one's
 * floor equals its own "now". The clamp must still move it — a write that leaves the
 * timestamp unchanged is indistinguishable from no write at all to every peer, and one that
 * leaps forward poisons every later comparison against it.
 */
test("successive writes in the same millisecond each advance the clock by the smallest step", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");

  const started = Date.parse(todo.updatedAt);
  let previous = todo.updatedAt;
  for (let i = 0; i < 50; i++) {
    touch(store, todo, "d", "n", ["title"]);
    assert.ok(todo.updatedAt > previous, `write ${i} did not advance the clock: ${previous} -> ${todo.updatedAt}`);
    previous = todo.updatedAt;
  }
  // 50 writes must not have pushed the record into next week. Clamping is a nudge past the
  // version being overwritten, not a jump.
  assert.ok(
    Date.parse(todo.updatedAt) - started < 5_000,
    `50 rapid writes moved updatedAt ${Date.parse(todo.updatedAt) - started}ms — the clamp is jumping, not nudging`,
  );
});

/**
 * Killed mutant: `item.revision ?? 1` → 0 / → a large value.
 *
 * Items written before `revision` existed have none, and storage.ts's migration documents
 * that they start at 1. Getting the fallback wrong silently shifts every legacy item's
 * optimistic-concurrency counter, which a remote server then compares If-Match against.
 */
test("a legacy item with no revision starts counting from 1, not 0", () => {
  const store = emptyStore();
  const todo = createTodo(store, { title: "x", agent: null, session: null }, "d", "n");
  delete (todo as Partial<typeof todo>).revision;

  touch(store, todo, "d", "n", ["title"]);
  assert.equal(todo.revision, 2, "a legacy item's first write must produce revision 2 (absent means 1)");
});

/**
 * Killed mutant: `CLAIM_LEASE_MS = 15` → a large value.
 *
 * The 15-minute window is a documented promise — README says a claim "auto-expires after 15
 * minutes" — and it is what stops a crashed agent from holding an item forever. Nothing
 * else in the suite would notice it changing.
 */
test("a claim's lease is the 15 minutes the README promises", () => {
  const ahead = Date.parse(leaseExpiry()) - Date.now();
  assert.ok(Math.abs(ahead - 15 * 60_000) < 2_000, `lease runs ${Math.round(ahead / 1000)}s, README says 900s`);
});

/*
 * Mutation-testing gaps in mutations.ts, written down rather than papered over.
 *
 * Three mutants survive the full suite, and none of them is a missing assertion:
 *
 *  - `at > max` → `>=` inside the timestamp floor's reduce. Folding a maximum gives the
 *    same answer either way; this is an equivalent mutant and no test can distinguish it.
 *
 *  - `now > item.updatedAt` → `>=` in tombstoneDelete. At the boundary the mutant produces
 *    `deletedAt === updatedAt`, and both downstream comparisons (`deletedAt >= updatedAt`
 *    to skip a re-insert, `updatedAt <= deletedAt` to apply the deletion) already use
 *    inclusive tests — so the deletion still wins everywhere. Equivalent in effect; the
 *    strict form is kept because "later than" is what the comment claims and what a reader
 *    will assume.
 *
 *  - `workingLeaseExpiresAt > now` → `>=` in isClaimActive. Killing this needs a lease that
 *    expires at exactly the millisecond of the call, which is a race, not a test. The only
 *    way to make it deterministic is to inject a clock into production code purely so a
 *    test can hold it still — a worse trade than an uncovered boundary that decides nothing
 *    a user could observe.
 */
