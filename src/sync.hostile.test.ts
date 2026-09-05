import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTodo, tombstoneDelete } from "./mutations.js";
import type { Todo, TodoStore } from "./types.js";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-hostile-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { buildLegacySyncPayload, buildSyncPayload, cursorAfterPage, InvalidSyncEnvelopeError, MAX_INCOMING_ITEMS } =
  await import("./sync/payload.js");
const { mergeSyncPayload } = await import("./sync/merge.js");
import type { SyncPayload } from "./sync/payload.js";

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

function emptyStore(): TodoStore {
  return { formatVersion: 8, nextId: 1, todos: [], deletedUuids: [], seqCounter: 0 };
}

/**
 * A well-formed record, which each test then damages in exactly one way. Typed loosely on
 * purpose: the whole point is to hand `mergeSyncPayload` things TypeScript would never let a
 * local caller construct, because a peer is not a local caller — it is a remote process that
 * may be running different code, older code, or code an attacker chose.
 */
function wireTodo(overrides: Record<string, unknown> = {}): Todo {
  const seed = emptyStore();
  const base = createTodo(seed, { title: "from peer", agent: "codex", session: "s" }, "device-peer", "Peer");
  return { ...base, ...overrides } as Todo;
}

function payload(todos: unknown[], deletedUuids: unknown[] = []): SyncPayload {
  return { todos, deletedUuids, serverTime: new Date().toISOString(), protocolVersion: 2 } as unknown as SyncPayload;
}

/** Everything a peer sends passes through this one function. If it lets something through, the store has it forever. */
function mergeHostile(store: TodoStore, todos: unknown[], tombstones: unknown[] = []) {
  return mergeSyncPayload(store, payload(todos, tombstones), "hostile-peer");
}

// --- Shape: missing, wrong-typed and unknown fields ------------------------------------

test("hostile: records missing a required field are dropped, not half-inserted", () => {
  const store = emptyStore();
  const missing = ["uuid", "title", "done", "list", "createdAt", "updatedAt", "history"];
  for (const field of missing) {
    const bad = wireTodo();
    delete (bad as unknown as Record<string, unknown>)[field];
    mergeHostile(store, [bad]);
  }
  assert.equal(store.todos.length, 0, "a record without its identity fields must not enter the store at all");
});

test("hostile: wrong-typed fields are dropped or clamped, never stored as-is", () => {
  const store = emptyStore();
  mergeHostile(store, [
    wireTodo({ uuid: 12345 }),
    wireTodo({ title: { toString: "not a string" } }),
    wireTodo({ done: "yes" }),
    wireTodo({ list: "neither" }),
    wireTodo({ history: "not an array" }),
  ]);
  assert.equal(store.todos.length, 0);
});

test("hostile: unknown extra fields are stripped rather than persisted and re-synced forever", () => {
  const store = emptyStore();
  mergeHostile(store, [wireTodo({ evilPayload: "x".repeat(1000), __proto__polluted: true, nested: { a: 1 } })]);
  assert.equal(store.todos.length, 1);
  const stored = store.todos[0] as unknown as Record<string, unknown>;
  assert.equal(stored.evilPayload, undefined, "an unknown key would persist and re-sync to every peer forever");
  assert.equal(stored.nested, undefined);
});

test("hostile: a peer cannot pollute Object.prototype through a merged record", () => {
  const store = emptyStore();
  const parsed = JSON.parse('{"uuid":"11111111-1111-7111-8111-111111111111","title":"x","done":false,"list":"todo","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","history":[],"__proto__":{"polluted":"yes"}}');
  mergeHostile(store, [parsed]);
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "prototype pollution via a sync payload");
});

// --- localSeq: the field that must never be trusted from the wire -----------------------

test("hostile: a peer's localSeq is never adopted, whatever it claims", () => {
  const store = emptyStore();
  createTodo(store, { title: "ours", agent: null, session: null }, "device-a", "A");
  const before = store.seqCounter;

  for (const claimed of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY, "999" as unknown as number]) {
    mergeHostile(store, [wireTodo({ uuid: `1111${String(claimed).slice(0, 4).padEnd(4, "0")}-1111-7111-8111-111111111111`, localSeq: claimed })]);
  }
  for (const t of store.todos) {
    assert.ok(Number.isSafeInteger(t.localSeq) && t.localSeq > 0, `record carries a hostile localSeq: ${t.localSeq}`);
  }
  assert.ok(store.seqCounter >= before, "the counter must never be dragged backwards by a peer's claim");
  assert.ok(Number.isSafeInteger(store.seqCounter), `counter corrupted to ${store.seqCounter}`);
});

// --- Timestamps ------------------------------------------------------------------------

test("hostile: unparseable and absurd timestamps cannot crash a merge or a later comparison", () => {
  const store = emptyStore();
  for (const at of ["not-a-date", "", "1970-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", "0000-01-01T00:00:00.000Z"]) {
    mergeHostile(store, [wireTodo({ uuid: `2222${at.slice(0, 4).padEnd(4, "0").replace(/[^0-9a-f]/gi, "0")}-2222-7222-8222-222222222222`, updatedAt: at, createdAt: at })]);
  }
  // Whatever landed must survive being compared and serialised — the failure this guards is
  // a later merge or a UI render throwing on a value a peer chose.
  assert.doesNotThrow(() => JSON.stringify(store));
  assert.doesNotThrow(() => mergeHostile(store, [wireTodo({ updatedAt: "also-not-a-date" })]));
});

test("hostile: a timestamp at the ISO boundary is refused, because this device could not step it", () => {
  const store = emptyStore();
  const ours = createTodo(store, { title: "ours", agent: null, session: null }, "device-a", "A");
  mergeHostile(store, [
    wireTodo({
      uuid: ours.uuid,
      title: "theirs",
      updatedAt: "9999-12-31T23:59:59.999Z",
      fieldTimestamps: { title: "9999-12-31T23:59:59.999Z" },
    }),
  ]);
  /*
   * This used to be accepted, on the reasoning that last-write-wins means a future timestamp
   * legitimately wins and an absurd date on screen is honest. The flaw is one step further
   * on: mutations.ts keeps timestamps monotonic with `Date.parse(x) + 1`, and one
   * millisecond past this value is year 10000, which serialises as "+010000-01-01T…". No
   * Docket accepts that shape — so a local edit to this record would produce something the
   * NEXT device refuses, and refusal plus delivery accounting is a gap neither side sees.
   *
   * A record this device cannot safely edit is not one it should store.
   */
  assert.equal(store.todos[0].title, "ours", "a record with an unsteppable timestamp was merged");
  assert.equal(store.todos.length, 1);

  // One millisecond below the boundary is fine, and still wins on the merits.
  const safe = "9999-12-31T23:59:58.998Z";
  mergeHostile(store, [wireTodo({ uuid: ours.uuid, title: "far but safe", updatedAt: safe, fieldTimestamps: { title: safe } })]);
  assert.equal(store.todos[0].title, "far but safe", "a far-future but steppable timestamp must still win");

  // ...and the value this device would produce from it is still something a peer accepts.
  const stepped = new Date(Date.parse(store.todos[0].updatedAt) + 1).toISOString();
  assert.match(stepped, /^\d{4}-/, `stepping the stored timestamp produced ${stepped}, which no peer will accept`);
});

// --- Volume ----------------------------------------------------------------------------

test("hostile: a payload far larger than any page is clamped and reported, not merged whole", () => {
  const store = emptyStore();
  const huge = Array.from({ length: MAX_INCOMING_ITEMS + 500 }, (_, i) =>
    wireTodo({ uuid: `3333${String(i).padStart(4, "0")}-3333-7333-8333-333333333333` }),
  );
  const result = mergeHostile(store, huge);
  assert.equal(result.truncated, true, "the caller must be told, or it advances its cursor past what it never merged");
  assert.ok(store.todos.length <= MAX_INCOMING_ITEMS, `merged ${store.todos.length}, above the ceiling`);
});

test("hostile: one record with an enormous history cannot blow up the store", () => {
  const store = emptyStore();
  const history = Array.from({ length: 100_000 }, (_, i) => ({
    at: "2026-01-01T00:00:00.000Z",
    agent: "peer",
    deviceName: "P",
    action: "edited",
    detail: `entry ${i}`,
  }));
  mergeHostile(store, [wireTodo({ history })]);
  assert.equal(store.todos.length, 1);
  assert.ok(store.todos[0].history.length < 100_000, `stored ${store.todos[0].history.length} history entries unclamped`);
});

// --- Values the web UI renders ----------------------------------------------------------

test("hostile: a javascript: or data: sourceUrl never reaches the store", () => {
  const store = emptyStore();
  for (const [i, url] of ["javascript:alert(1)", "data:text/html,<script>x</script>", "vbscript:x", "JaVaScRiPt:alert(1)", " javascript:alert(1)"].entries()) {
    mergeHostile(store, [wireTodo({ uuid: `4444${String(i).padStart(4, "0")}-4444-7444-8444-444444444444`, sourceUrl: url })]);
  }
  for (const t of store.todos) assert.equal(t.sourceUrl, null, `stored a click-executable sourceUrl: ${t.sourceUrl}`);
});

test("hostile: enum-shaped fields only ever hold values this codebase produces", () => {
  const store = emptyStore();
  mergeHostile(store, [wireTodo({ priority: "<script>", dueDate: "not-a-date", list: "todo" })]);
  assert.equal(store.todos[0].priority, null, "the web UI renders priority without escaping it");
  assert.equal(store.todos[0].dueDate, null, "so does dueDate");
});

test("hostile: history actions are constrained to the safe charset the UI renders unescaped", () => {
  const store = emptyStore();
  mergeHostile(store, [
    wireTodo({
      history: [
        { at: "2026-01-01T00:00:00.000Z", agent: "p", deviceName: "P", action: "<img src=x onerror=alert(1)>", detail: "d" },
        { at: "2026-01-01T00:00:00.000Z", agent: "p", deviceName: "P", action: "edited", detail: "ok" },
      ],
    }),
  ]);
  for (const entry of store.todos[0].history) {
    assert.match(entry.action, /^[a-z][a-z-]{0,31}$/, `history action "${entry.action}" would be rendered unescaped`);
  }
});

/**
 * These strings must SURVIVE a round trip — they are legitimate content someone may
 * genuinely have typed — while the web UI escapes them at render time. Dropping them would
 * be data loss; storing them raw and rendering them raw would be stored XSS. The store's job
 * is the first half; smoke.web.test.ts asserts the second.
 */
test("hostile: markup and control characters in free text survive the store intact", () => {
  const store = emptyStore();
  const nasty = '</script><img src=x onerror=alert(1)> ${process.env} `backtick` ‮RTL‬ "quotes" \\backslash';
  mergeHostile(store, [wireTodo({ title: nasty, description: nasty, category: nasty })]);
  assert.equal(store.todos[0].title, nasty, "legitimate text was mangled — that is data loss, not safety");
  assert.equal(store.todos[0].description, nasty);
});

// --- Tombstones ------------------------------------------------------------------------

test("hostile: malformed tombstones are dropped without disturbing the store", () => {
  const store = emptyStore();
  const ours = createTodo(store, { title: "keep me", agent: null, session: null }, "device-a", "A");
  mergeHostile(store, [], [
    null,
    "a string",
    {},
    { uuid: 42, deletedAt: "2026-01-01T00:00:00.000Z" },
    { uuid: ours.uuid },
    { deletedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  assert.equal(store.todos.length, 1, "a malformed tombstone deleted a real item");
  assert.equal(store.deletedUuids.length, 0);
});

test("hostile: a tombstone for an item cannot be forged with a non-string deletedAt", () => {
  const store = emptyStore();
  const ours = createTodo(store, { title: "keep me", agent: null, session: null }, "device-a", "A");
  mergeHostile(store, [], [{ uuid: ours.uuid, deletedAt: { valueOf: () => "9999-01-01" }, deviceId: "peer" }]);
  assert.equal(store.todos.length, 1);
});

// --- The payload envelope itself ---------------------------------------------------------

test("hostile: a payload whose arrays are not arrays is a no-op, not a crash", () => {
  const store = emptyStore();
  createTodo(store, { title: "ours", agent: null, session: null }, "device-a", "A");
  for (const shape of [{ todos: null }, { todos: "x" }, { deletedUuids: 5 }, { todos: {} }, {}]) {
    assert.doesNotThrow(() =>
      mergeSyncPayload(store, { serverTime: new Date().toISOString(), protocolVersion: 2, ...shape } as unknown as SyncPayload, "hostile-peer"),
    );
  }
  assert.equal(store.todos.length, 1, "the store must be untouched by a malformed envelope");
});

// --- The other half: a well-formed record must survive untouched -------------------------

/**
 * Killed mutants: `typeof o.dueDate === "string"` → `!==`, and the same for `sourceUrl` and
 * `revision`.
 *
 * Every test above checks that BAD input is rejected, and all of them still pass if the
 * sanitiser rejects everything — including valid data. Inverting one of those guards makes
 * `sanitizeRemoteTodo` silently null out a field on every record that crosses the wire, and
 * nothing would have noticed. The rejection tests and this one only mean something together.
 */
test("hostile: a well-formed record crosses the wire with every field intact", () => {
  const store = emptyStore();
  const good = wireTodo({
    title: "fix token refresh race",
    description: "a real description",
    done: true,
    list: "backlog",
    category: "VPQ-834",
    priority: "high",
    dueDate: "2026-12-01",
    sourceUrl: "https://gitlab.com/acme/backend/-/issues/834",
    workspace: "acme/backend",
    completedAt: "2026-11-30T10:00:00.000Z",
    revision: 7,
    workingAgent: "codex",
    workingSince: "2026-11-30T09:00:00.000Z",
    workingSession: "sess-1",
    workingLeaseExpiresAt: "2026-11-30T09:15:00.000Z",
    workingDeviceId: "device-peer",
    deviceName: "Peer",
  });
  mergeHostile(store, [good]);

  assert.equal(store.todos.length, 1, "a perfectly valid record was rejected");
  const stored = store.todos[0];
  for (const field of [
    "title", "description", "done", "list", "category", "priority", "dueDate", "sourceUrl",
    "workspace", "completedAt", "revision", "workingAgent", "workingSince", "workingSession",
    "workingLeaseExpiresAt", "workingDeviceId", "deviceName", "createdAt", "updatedAt", "uuid",
  ] as const) {
    assert.deepEqual(stored[field], good[field], `sanitizing dropped or altered a valid ${field}`);
  }
  assert.equal(stored.history.length, good.history.length, "valid history entries were dropped");
});

test("hostile: the paging boundary sends records strictly above the cursor, never the one at it", () => {
  // Killed mutant: `localSeq > sinceSeq` → `>=` on the tombstone stream. An off-by-one here
  // re-delivers the record sitting exactly on the cursor on every single tick, forever.
  const source = emptyStore();
  const a = createTodo(source, { title: "a", agent: null, session: null }, "d", "D");
  const b = createTodo(source, { title: "b", agent: null, session: null }, "d", "D");
  tombstoneDelete(source, a, "d");
  const tombSeq = source.deletedUuids[0].localSeq;

  const atCursor = buildSyncPayload(source, tombSeq);
  assert.ok(!atCursor.deletedUuids.some((t) => t.localSeq === tombSeq), "the tombstone at the cursor was re-sent");
  assert.ok(!atCursor.todos.some((t) => t.localSeq === b.localSeq && b.localSeq <= tombSeq));

  const justBelow = buildSyncPayload(source, tombSeq - 1);
  assert.ok(justBelow.deletedUuids.some((t) => t.localSeq === tombSeq), "the tombstone just above the cursor was skipped");
});

test("hostile: the legacy timestamp payload is also strictly-after, not inclusive", () => {
  // Killed mutant: `updatedAt > since` → `>=` in buildLegacySyncPayload. Inclusive here means
  // a v1 peer re-sends the newest record on every tick and never makes progress.
  const source = emptyStore();
  const item = createTodo(source, { title: "only", agent: null, session: null }, "d", "D");
  assert.equal(buildLegacySyncPayload(source, item.updatedAt).todos.length, 0, "the record at the cursor was re-sent");
  assert.equal(buildLegacySyncPayload(source, "1970-01-01T00:00:00.000Z").todos.length, 1);
});

test("hostile: a field tie between two copies with the SAME device id still resolves identically both ways", () => {
  // Killed mutant: `byDevice > 0` → `>= 0`, which makes "remote wins" true in both
  // directions — each side adopts the other's value forever instead of agreeing on one.
  const at = "2026-06-01T00:00:00.000Z";
  const base = { ...wireTodo(), deviceId: "same-device", updatedAt: at, fieldTimestamps: { title: at } };
  const left = { ...structuredClone(base), title: "aaa" };
  const right = { ...structuredClone(base), title: "zzz" };

  const storeA = emptyStore();
  storeA.todos = [structuredClone(left)];
  storeA.nextId = 2;
  mergeHostile(storeA, [structuredClone(right)]);

  const storeB = emptyStore();
  storeB.todos = [structuredClone(right)];
  storeB.nextId = 2;
  mergeHostile(storeB, [structuredClone(left)]);

  assert.equal(storeA.todos[0].title, storeB.todos[0].title, "the two devices resolved the same tie differently — they will never converge");
});

/* ===========================================================================================
 * The envelope
 *
 * Everything above defends the RECORDS. These defend the cursor, which is the more dangerous
 * half: a bad record is visible in the list, while a bad cursor is an absence — the range it
 * skipped is simply never requested again, and nothing anywhere reports it.
 * =========================================================================================== */

test("a peer's maxSeq must be a sequence number before it can move the cursor", () => {
  for (const bogus of [undefined, null, -1, 1.5, NaN, Infinity, "42", {}, [], Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(
      () => cursorAfterPage({ ...payload([]), maxSeq: bogus } as unknown as SyncPayload, 10),
      InvalidSyncEnvelopeError,
      `maxSeq ${JSON.stringify(bogus)} was accepted`,
    );
  }
});

test("a page cannot promise delivery beyond the highest record it actually carried", () => {
  // The failure this prevents: a peer claims it has delivered everything up to 9999, this
  // device believes it, and every record between the page's real end and 9999 is never
  // asked for again. Silent, permanent, and invisible from both ends.
  const carried = [wireTodo({ localSeq: 4 }), wireTodo({ localSeq: 7 })];
  const inflated = { ...payload(carried), maxSeq: 9999 } as unknown as SyncPayload;
  assert.equal(cursorAfterPage(inflated, 0), 7, "the cursor advanced past what the page delivered");

  // A tombstone counts as a delivered record too.
  const withTomb = { ...payload([], [{ uuid: "u", deletedAt: "2026-01-01T00:00:00.000Z", localSeq: 12 }]), maxSeq: 500 } as unknown as SyncPayload;
  assert.equal(cursorAfterPage(withTomb, 0), 12);
});

test("an honest peer's conservative maxSeq is never inflated by the clamp", () => {
  // buildSyncPayload deliberately reports the MIN ceiling of the two streams, which can sit
  // below the highest record in the page. The clamp must not undo that caution.
  const store = emptyStore();
  for (let i = 0; i < 3; i++) createTodo(store, { title: `t${i}`, agent: null, session: null }, "d", "D");
  const built = buildSyncPayload(store, 0);
  assert.equal(cursorAfterPage(built, 0), built.maxSeq, "the clamp moved an honest peer's cursor");
});

test("an empty page is taken at its word, and the cursor never moves backwards", () => {
  // Nothing to check an empty page against — a peer that can withhold records can always
  // withhold them, so this is not a hole the client can close.
  assert.equal(cursorAfterPage({ ...payload([]), maxSeq: 40 } as unknown as SyncPayload, 10), 40);
  // Backwards would pin this device on one range forever, re-requesting it every tick.
  assert.equal(cursorAfterPage({ ...payload([]), maxSeq: 3 } as unknown as SyncPayload, 10), 10);
});

/* ---- timestamps ------------------------------------------------------------------------ */

test("a record with an unparseable updatedAt is refused rather than stored", () => {
  const store = emptyStore();
  for (const bad of ["not-a-date", "", "2026-13-45T99:99:99Z", "yesterday", "1788555937712"]) {
    const before = store.todos.length;
    mergeHostile(store, [wireTodo({ uuid: `u-${bad}`, updatedAt: bad })]);
    assert.equal(store.todos.length, before, `updatedAt ${JSON.stringify(bad)} was accepted into the store`);
  }
  // createdAt is held to the same standard, for the same reason.
  mergeHostile(store, [wireTodo({ uuid: "u-created", createdAt: "whenever" })]);
  assert.equal(store.todos.length, 0);
});

test("a stored record from a peer can always survive the arithmetic a local edit does to it", async () => {
  // This is the actual crash the rule above prevents. mutations.ts steps a timestamp forward
  // with `new Date(Date.parse(updatedAt) + 1).toISOString()` whenever the wall clock has not
  // moved past it — and Date.parse of garbage is NaN, which makes toISOString throw
  // RangeError on an ordinary edit, long after the sync that accepted the value.
  const { applyEdits, tombstoneDelete: del } = await import("./mutations.js");
  const store = emptyStore();
  mergeHostile(store, [wireTodo({ uuid: "u-ok", updatedAt: "2099-01-01T00:00:00.000Z" })]);
  const item = store.todos[0];
  assert.ok(item, "the well-formed record should have been accepted");

  // Its updatedAt is in the future, so the clamp branch — the one that does the arithmetic —
  // is the branch taken.
  assert.doesNotThrow(() => applyEdits(store, item, { title: "edited locally" }, "agent", "device-a", "A"));
  assert.doesNotThrow(() => del(store, item, "device-a"));
});

test("per-field timestamps that cannot be parsed are dropped, not stored", () => {
  const store = emptyStore();
  mergeHostile(store, [
    wireTodo({
      uuid: "u-fts",
      fieldTimestamps: { title: "2026-01-01T00:00:00.000Z", description: "not-a-date", category: 12345 },
    }),
  ]);
  const stored = store.todos[0];
  assert.ok(stored);
  assert.equal(stored.fieldTimestamps?.title, "2026-01-01T00:00:00.000Z", "a valid entry was dropped");
  assert.equal(stored.fieldTimestamps?.description, undefined, "an unparseable entry was kept");
  assert.equal(stored.fieldTimestamps?.category, undefined, "a non-string entry was kept");
});

test("optional timestamps degrade to null instead of poisoning the record", () => {
  const store = emptyStore();
  mergeHostile(store, [
    wireTodo({ uuid: "u-opt", completedAt: "soon", workingSince: "now-ish", workingLeaseExpiresAt: "never" }),
  ]);
  const stored = store.todos[0];
  assert.ok(stored, "the record itself is fine — only these fields were unusable");
  assert.equal(stored.completedAt, null);
  assert.equal(stored.workingSince, null);
  assert.equal(stored.workingLeaseExpiresAt, null);
});

/* ==========================================================================================
 * Delivery accounting
 *
 * The sanitiser refusing a record and the cursor counting it as delivered are two decisions
 * that have to agree. When they did not, the record was skipped forever and nothing said so.
 * ========================================================================================== */

test("a record the sanitiser refuses holds the cursor below it, instead of being skipped forever", () => {
  const store = emptyStore();
  const good = wireTodo({ uuid: "aaaa1111-1111-7111-8111-111111111111", title: "delivered", localSeq: 10 });
  // Refused for an unparseable updatedAt, but it still occupies position 20 in the peer's
  // delivery order — so the cursor may not go past 19.
  const bad = wireTodo({ uuid: "bbbb2222-2222-7222-8222-222222222222", title: "refused", updatedAt: "not-a-date", localSeq: 20 });
  const later = wireTodo({ uuid: "cccc3333-3333-7333-8333-333333333333", title: "after the bad one", localSeq: 30 });

  const merged = mergeSyncPayload(store, { ...payload([good, bad, later]), maxSeq: 30 } as unknown as SyncPayload, "peer");
  assert.equal(merged.rejectedBelow, 20, "the merge must report where it refused, not just how many it took");

  const cursor = cursorAfterPage({ ...payload([good, bad, later]), maxSeq: 30 } as unknown as SyncPayload, 0, merged.rejectedBelow);
  assert.equal(cursor, 19, `the cursor advanced to ${cursor}, stepping over the record at 20`);

  // What DID arrive is kept — holding the cursor is not the same as discarding the page.
  assert.ok(store.todos.some((t) => t.title === "delivered"), "a valid record below the refusal was dropped");
});

test("a clean page still advances the cursor normally", () => {
  // The clamp must not fire when there is nothing to clamp, or every sync stalls at once.
  const store = emptyStore();
  const page = { ...payload([wireTodo({ localSeq: 5 }), wireTodo({ uuid: "dddd4444-4444-7444-8444-444444444444", localSeq: 9 })]), maxSeq: 9 } as unknown as SyncPayload;
  const merged = mergeSyncPayload(store, page, "peer");
  assert.equal(merged.rejectedBelow, null);
  assert.equal(cursorAfterPage(page, 0, merged.rejectedBelow), 9);
});

test("a tombstone with an unorderable deletedAt is refused, not stored", () => {
  /*
   * The merge compares deletions by STRING ordering — `tombstone.deletedAt >= remote.updatedAt`
   * — so "zzzz" sorts above every real ISO timestamp. Stored, it would produce a deletion
   * that no later edit from any device could ever beat: an item that cannot be brought back.
   */
  const store = emptyStore();
  const live = createTodo(store, { title: "still wanted", agent: null, session: null }, "device-a", "A");
  for (const deletedAt of ["zzzz", "", "not-a-date", "9999-12-31T23:59:59.999Z", "tomorrow"]) {
    mergeHostile(store, [], [{ uuid: live.uuid, deletedAt, deviceId: "peer" }]);
  }
  assert.equal(store.deletedUuids.length, 0, `an unorderable tombstone was stored: ${JSON.stringify(store.deletedUuids)}`);
  assert.ok(store.todos.some((t) => t.uuid === live.uuid), "the item was deleted by a tombstone that should have been refused");

  // A well-formed one still works, or this would be a denial of deletion rather than a guard.
  mergeHostile(store, [], [{ uuid: live.uuid, deletedAt: new Date(Date.now() + 60_000).toISOString(), deviceId: "peer" }]);
  assert.equal(store.deletedUuids.length, 1, "a valid tombstone was refused too");
});
