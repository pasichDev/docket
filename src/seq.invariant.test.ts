import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-seq-invariant-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const mutations = await import("./mutations.js");
const { mergeSyncPayload } = await import("./sync/merge.js");
import type { SyncPayload } from "./sync/payload.js";
import type { Todo, TodoStore } from "./types.js";

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

function emptyStore(): TodoStore {
  return { formatVersion: 8, nextId: 1, todos: [], deletedUuids: [], seqCounter: 0 };
}

const DEVICE = ["device-a", "A"] as const;

/**
 * Everything in the store that a peer is ever told about, paired with the sequence number
 * it currently carries. `localSeq` is stripped from the compared content because it is the
 * thing under test — what matters is whether the CONTENT moved, and whether the number was
 * bumped when it did.
 */
function snapshot(store: TodoStore): Map<string, { content: string; seq: number }> {
  const out = new Map<string, { content: string; seq: number }>();
  for (const t of store.todos) {
    const { localSeq, ...rest } = t;
    out.set(`todo:${t.uuid}`, { content: JSON.stringify(rest), seq: localSeq });
  }
  for (const t of store.deletedUuids) {
    const { localSeq, ...rest } = t;
    out.set(`tomb:${t.uuid}`, { content: JSON.stringify(rest), seq: localSeq });
  }
  return out;
}

/**
 * THE invariant of format v8: if a record's content changed, it got a fresh sequence number
 * from this operation. A record a peer can see, that changed without one, is a record that
 * peer will never be told about — silently, and only visibly much later as divergence.
 *
 * One of the three HIGH bugs found in review was exactly this shape — accepting a peer's
 * field update without stamping it — and this catches that class, verified by reverting the
 * fix. So is an unstamped `tombstoneDelete`, caught by the vanished-record half below.
 *
 * What it CANNOT catch, and it is worth being precise rather than claiming the whole set:
 * the other tombstone bug (a newer deletion for a uuid we already have a tombstone for) is
 * a MISSING change, not an unstamped one — without the fix the store simply doesn't move,
 * so any "if it changed, stamp it" property is vacuously satisfied. That one needs a test
 * that knows what SHOULD have happened, which is what sync.transitive.test.ts is.
 */
function assertSeqInvariant(name: string, before: TodoStore, after: TodoStore, beforeSnap: Map<string, { content: string; seq: number }>): void {
  const afterSnap = snapshot(after);
  const changed = [...afterSnap].filter(([key, now]) => beforeSnap.get(key)?.content !== now.content);
  // A record that VANISHED is the other half of the property, and the easier half to miss:
  // the news of a disappearance travels as a tombstone, so an item that goes away without a
  // freshly-stamped tombstone is a deletion no peer will ever apply.
  const vanished = [...beforeSnap.keys()].filter((key) => key.startsWith("todo:") && !afterSnap.has(key));

  // The converse, and it matters just as much: an operation that changed nothing must not
  // burn a sequence number. Every number handed out is a record some peer will re-fetch, so
  // a no-op that stamps turns routine syncing into a full resend — and two peers stamping
  // each other's no-ops never stop talking to each other at all.
  if (changed.length === 0 && vanished.length === 0) {
    assert.equal(
      after.seqCounter,
      before.seqCounter,
      `${name}: nothing changed, but seqCounter moved ${before.seqCounter} -> ${after.seqCounter} — this makes every sync a resend`,
    );
    return;
  }
  assert.ok(
    after.seqCounter > before.seqCounter,
    `${name}: ${changed.length} changed / ${vanished.length} removed record(s) but seqCounter did not move (${before.seqCounter})`,
  );
  const assignedHere = (seq: number) => seq > before.seqCounter && seq <= after.seqCounter;
  for (const [key, now] of changed) {
    assert.ok(
      assignedHere(now.seq),
      `${name}: ${key} changed but its localSeq (${now.seq}) was not assigned by this operation ` +
        `(expected > ${before.seqCounter} and <= ${after.seqCounter}) — a peer will never hear about it`,
    );
  }
  for (const key of vanished) {
    const tombstone = afterSnap.get(`tomb:${key.slice("todo:".length)}`);
    assert.ok(tombstone, `${name}: ${key} disappeared without leaving a tombstone — peers will resurrect it`);
    assert.ok(
      assignedHere(tombstone.seq),
      `${name}: ${key} was deleted but its tombstone's localSeq (${tombstone.seq}) was not assigned by this ` +
        `operation — the deletion is applied locally and never propagates`,
    );
  }
}

/** One mutating operation, applied to a store that has been set up for it. */
interface Operation {
  name: string;
  setUp?: (store: TodoStore) => void;
  run: (store: TodoStore) => void;
}

const payload = (todos: Todo[], deletedUuids: SyncPayload["deletedUuids"] = []): SyncPayload => ({
  todos,
  deletedUuids,
  serverTime: new Date().toISOString(),
  protocolVersion: 2,
});

const seed = (store: TodoStore, title = "seeded") =>
  mutations.createTodo(store, { title, agent: "test", session: "s" }, ...DEVICE);

/** A copy of an item as a PEER would send it: same uuid, edited later, carrying its own (meaningless here) sequence number. */
function asRemoteEdit(item: Todo, edit: (t: Todo) => void): Todo {
  const remote = structuredClone(item);
  const later = new Date(Date.now() + 60_000).toISOString();
  edit(remote);
  remote.updatedAt = later;
  remote.fieldTimestamps = Object.fromEntries(Object.keys(remote.fieldTimestamps ?? {}).concat(["title", "description", "done"]).map((k) => [k, later]));
  remote.deviceId = "device-peer";
  remote.localSeq = 999_999;
  return remote;
}

const OPERATIONS: Operation[] = [
  { name: "create", run: (s) => void seed(s) },
  {
    name: "edit",
    setUp: (s) => void seed(s),
    run: (s) => void mutations.applyEdits(s, s.todos[0], { title: "edited" }, "test", ...DEVICE),
  },
  {
    name: "edit (no-op)",
    setUp: (s) => void seed(s, "unchanged"),
    run: (s) => void mutations.applyEdits(s, s.todos[0], { title: "unchanged" }, "test", ...DEVICE),
  },
  { name: "claim", setUp: (s) => void seed(s), run: (s) => void mutations.claimTodo(s, s.todos[0], "codex", "s1", ...DEVICE) },
  {
    name: "claim (renewal)",
    setUp: (s) => {
      seed(s);
      mutations.claimTodo(s, s.todos[0], "codex", "s1", ...DEVICE);
    },
    run: (s) => void mutations.claimTodo(s, s.todos[0], "codex", "s1", ...DEVICE),
  },
  {
    name: "release",
    setUp: (s) => {
      seed(s);
      mutations.claimTodo(s, s.todos[0], "codex", "s1", ...DEVICE);
    },
    run: (s) => void mutations.releaseTodo(s, s.todos[0], "codex", ...DEVICE),
  },
  { name: "complete", setUp: (s) => void seed(s), run: (s) => void mutations.completeTodo(s, s.todos[0], "test", ...DEVICE) },
  {
    name: "reopen (edit after complete)",
    setUp: (s) => {
      seed(s);
      mutations.completeTodo(s, s.todos[0], "test", ...DEVICE);
    },
    run: (s) => void mutations.applyEdits(s, s.todos[0], { title: "reopened" }, "test", ...DEVICE),
  },
  { name: "delete", setUp: (s) => void seed(s), run: (s) => mutations.tombstoneDelete(s, s.todos[0], "device-a") },
  { name: "touch", setUp: (s) => void seed(s), run: (s) => mutations.touch(s, s.todos[0], ...DEVICE, ["title"]) },

  // --- merge paths. These are where both review bugs lived. ---
  {
    name: "merge: insert",
    run: (s) => void mergeSyncPayload(s, payload([seed(emptyStore(), "from peer")]), "peer"),
  },
  {
    name: "merge: field update",
    setUp: (s) => void seed(s),
    run: (s) => void mergeSyncPayload(s, payload([asRemoteEdit(s.todos[0], (t) => (t.title = "peer's title"))]), "peer"),
  },
  {
    name: "merge: no-op update (peer sends what we already have)",
    setUp: (s) => void seed(s),
    run: (s) => void mergeSyncPayload(s, payload([structuredClone(s.todos[0])]), "peer"),
  },
  {
    name: "merge: new tombstone",
    setUp: (s) => void seed(s),
    run: (s) =>
      void mergeSyncPayload(
        s,
        payload([], [{ uuid: s.todos[0].uuid, deletedAt: new Date(Date.now() + 60_000).toISOString(), deviceId: "peer", localSeq: 5 }]),
        "peer",
      ),
  },
  {
    // The second HIGH bug: a tombstone we ALREADY have, superseded by a later deletion.
    // "Stamp every newly ADDED tombstone" does not fire here, and without a number the
    // newer deletion never leaves this device.
    name: "merge: existing tombstone superseded by a later deletion",
    setUp: (s) => {
      const item = seed(s);
      mutations.tombstoneDelete(s, item, "device-a");
    },
    run: (s) =>
      void mergeSyncPayload(
        s,
        payload([], [{ uuid: s.deletedUuids[0].uuid, deletedAt: new Date(Date.now() + 600_000).toISOString(), deviceId: "peer", localSeq: 7 }]),
        "peer",
      ),
  },
  {
    name: "merge: resurrect (edit newer than our tombstone), then delete again",
    setUp: (s) => {
      const item = seed(s);
      mutations.tombstoneDelete(s, item, "device-a");
      mergeSyncPayload(s, payload([asRemoteEdit(structuredClone(item), (t) => (t.title = "resurrected"))]), "peer");
    },
    run: (s) =>
      void mergeSyncPayload(
        s,
        payload([], [{ uuid: s.todos[0].uuid, deletedAt: new Date(Date.now() + 600_000).toISOString(), deviceId: "peer", localSeq: 9 }]),
        "peer",
      ),
  },
];

for (const operation of OPERATIONS) {
  test(`seq invariant: ${operation.name}`, () => {
    const store = emptyStore();
    operation.setUp?.(store);
    const before = { seqCounter: store.seqCounter } as TodoStore;
    const beforeSnap = snapshot(store);
    operation.run(store);
    assertSeqInvariant(operation.name, before, store, beforeSnap);
  });
}

/**
 * The enumeration is the part that keeps working after this file stops being read.
 *
 * Every exported function in mutations.ts that takes the store is a path that can change a
 * record, and every one of them owes a sequence number. Pinning the export list means a new
 * mutator added later fails this test by default — the author has to come here and classify
 * it — rather than passing silently, which is how the two review bugs got in.
 */
test("seq invariant: every store-taking mutator is covered by this file", () => {
  const KNOWN = ["createTodo", "applyEdits", "claimTodo", "releaseTodo", "completeTodo", "tombstoneDelete", "touch", "stampSeq"];
  const exported = Object.entries(mutations)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name)
    .sort();
  const storeTaking = exported.filter((name) => KNOWN.includes(name));

  assert.deepEqual(
    storeTaking.sort(),
    [...KNOWN].sort(),
    "a store-taking mutator in mutations.ts disappeared — remove it from KNOWN and from OPERATIONS",
  );

  const unknown = exported.filter((name) => !KNOWN.includes(name) && !PURE_HELPERS.includes(name));
  assert.deepEqual(
    unknown,
    [],
    `mutations.ts exports ${unknown.join(", ")}, which this test has never seen. If it can change a record, add it to ` +
      `KNOWN and give it an entry in OPERATIONS; if it is a pure helper, add it to PURE_HELPERS.`,
  );

  // `stampSeq` is the primitive the invariant is made of, and every other entry drives it.
  const covered = new Set(OPERATIONS.map((o) => o.name.replace(/ .*/, "")));
  for (const name of ["create", "edit", "claim", "release", "complete", "delete", "touch", "merge:"]) {
    assert.ok(covered.has(name.replace(":", "")) || covered.has(name), `no OPERATIONS entry exercises ${name}`);
  }
});

/** Exports of mutations.ts that cannot change a record, and so owe no sequence number. */
const PURE_HELPERS = ["shortId", "formatAgentIdentity", "isSafeUrl", "isClaimActive", "leaseExpiry", "FIELD_KEYS", "CLAIM_LEASE_MS"];
