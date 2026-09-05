import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTodo, tombstoneDelete, touch } from "./mutations.js";
import type { Todo, TodoStore } from "./types.js";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-sync-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { checkPairingRateLimit, confirmProof, createInvite, redeemInvite, pairingSas, verifyConfirmProof } =
  await import("./sync/peering.js");
const { signSyncRequest, verifySyncRequest } = await import("./sync/auth.js");
const { decryptSyncPayload, encryptSyncPayload, isSyncProtocolCompatible, MIN_COMPATIBLE_SYNC_PROTOCOL_VERSION } =
  await import("./sync/payload.js");
const { mergeSyncPayload } = await import("./sync/merge.js");
const { generateShortCode } = await import("./short-code.js");
import type { SyncPayload } from "./sync/payload.js";

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

function emptyStore(): TodoStore {
  return { formatVersion: 8, nextId: 1, todos: [], deletedUuids: [], seqCounter: 0 };
}

function payloadFrom(todos: Todo[]): SyncPayload {
  return { todos, deletedUuids: [], serverTime: new Date().toISOString(), protocolVersion: 1 };
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
  touch(local, localItem, "device-a", "A", ["priority"]);

  // Remote (device B) side: same base item, edits description instead — after A's edit.
  await new Promise((r) => setTimeout(r, 2));
  const remote = emptyStore();
  const remoteItem = structuredClone(base);
  remote.todos = [remoteItem];
  remoteItem.description = "added on B";
  touch(remote, remoteItem, "device-b", "B", ["description"]);

  const result = mergeSyncPayload(local, payloadFrom([remoteItem]), "device-b");
  assert.equal(result.updated, 1);
  assert.equal(local.todos[0].priority, "high", "A's priority edit must survive");
  assert.equal(local.todos[0].description, "added on B", "B's description edit must also survive");
});

test("mergeSyncPayload: a genuine same-field conflict (both sides independently edited it) is recorded as a distinct 'synced' history entry (regression: no diagnostic for which device's value won)", async () => {
  const seedStore = emptyStore();
  const base = createTodo(seedStore, { title: "Shared item", agent: null, session: null }, "device-a", "A");

  const local = emptyStore();
  local.todos = [structuredClone(base)];
  await new Promise((r) => setTimeout(r, 2));
  local.todos[0].title = "Local edit";
  touch(local, local.todos[0], "device-a", "A", ["title"]);

  await new Promise((r) => setTimeout(r, 2));
  const remote = emptyStore();
  const remoteItem = structuredClone(base);
  remote.todos = [remoteItem];
  remoteItem.title = "Remote edit";
  touch(remote, remoteItem, "device-b", "RemoteBox", ["title"]);

  mergeSyncPayload(local, payloadFrom([remoteItem]), "device-b");
  assert.equal(local.todos[0].title, "Remote edit", "the newer (remote) edit should win the conflict");
  const syncedEntries = local.todos[0].history.filter((h) => h.action === "synced");
  assert.equal(syncedEntries.length, 1, "exactly one conflict-resolution entry, not one per merge call or per unrelated field");
  assert.match(syncedEntries[0].detail, /title/);
  assert.match(syncedEntries[0].detail, /RemoteBox/);
});

test("mergeSyncPayload: adopting a field the local side never touched is NOT recorded as a conflict (there was nothing to conflict with)", async () => {
  const seedStore = emptyStore();
  const base = createTodo(seedStore, { title: "x", agent: null, session: null }, "device-a", "A");

  const local = emptyStore();
  local.todos = [structuredClone(base)]; // local never edits description

  const remote = emptyStore();
  const remoteItem = structuredClone(base);
  remote.todos = [remoteItem];
  remoteItem.description = "added on B";
  touch(remote, remoteItem, "device-b", "B", ["description"]);

  mergeSyncPayload(local, payloadFrom([remoteItem]), "device-b");
  assert.equal(local.todos[0].description, "added on B");
  assert.equal(local.todos[0].history.filter((h) => h.action === "synced").length, 0);
});

test("mergeSyncPayload: a field last-touched more recently locally is NOT overwritten by an older remote value", async () => {
  const seedStore = emptyStore();
  const base = createTodo(seedStore, { title: "x", agent: null, session: null }, "device-a", "A");

  const local = emptyStore();
  local.todos = [structuredClone(base)];
  await new Promise((r) => setTimeout(r, 5));
  touch(local, local.todos[0], "device-a", "A", ["title"]);
  local.todos[0].title = "Edited locally, later";

  // Remote's copy is the OLD version (its title field was never touched after creation).
  const remoteItem = structuredClone(base);

  mergeSyncPayload(local, payloadFrom([remoteItem]), "device-b");
  assert.equal(local.todos[0].title, "Edited locally, later");
});

test("mergeSyncPayload: an EXACT field-timestamp tie resolves the same way on both sides (regression: used to silently favor whichever copy called merge, not a rule both devices agree on)", () => {
  const seedStore = emptyStore();
  const base = createTodo(seedStore, { title: "original", agent: null, session: null }, "device-a", "A");
  const tieTime = new Date(Date.now() + 1000).toISOString();

  const copyA = structuredClone(base);
  copyA.title = "from device-alpha";
  copyA.deviceId = "device-alpha";
  copyA.fieldTimestamps.title = tieTime;

  const copyB = structuredClone(base);
  copyB.title = "from device-beta";
  copyB.deviceId = "device-beta";
  copyB.fieldTimestamps.title = tieTime;

  // A merges B's payload...
  const storeOnA = emptyStore();
  storeOnA.todos = [structuredClone(copyA)];
  mergeSyncPayload(storeOnA, payloadFrom([copyB]), "device-beta");

  // ...and B merges A's payload — a tied field-timestamp must land on the SAME winner
  // either way, or the two devices would each believe a different edit "won" forever.
  const storeOnB = emptyStore();
  storeOnB.todos = [structuredClone(copyB)];
  mergeSyncPayload(storeOnB, payloadFrom([copyA]), "device-alpha");

  assert.equal(storeOnA.todos[0].title, storeOnB.todos[0].title);
  assert.equal(storeOnA.todos[0].title, "from device-beta"); // "device-beta" > "device-alpha" lexically
});

test("mergeSyncPayload: a remote tombstone deletes a local item that hasn't changed since", () => {
  const local = emptyStore();
  const item = createTodo(local, { title: "to be deleted", agent: null, session: null }, "device-a", "A");

  const tombstonePayload: SyncPayload = {
    todos: [],
    deletedUuids: [{ uuid: item.uuid, deletedAt: new Date(Date.now() + 1000).toISOString(), deviceId: "device-b", localSeq: 1 }],
    serverTime: new Date().toISOString(),
    protocolVersion: 1,
  };
  const result = mergeSyncPayload(local, tombstonePayload, "device-b");
  assert.equal(result.deleted, 1);
  assert.equal(local.todos.length, 0);
});

test("mergeSyncPayload: a tombstone months old is NOT purged (regression: a long-offline peer must still see it and not resurrect the item)", () => {
  const local = emptyStore();
  const veryOldTombstone = { uuid: "some-uuid", deletedAt: new Date(Date.now() - 200 * 24 * 60 * 60_000).toISOString(), deviceId: "device-a", localSeq: 1 };
  local.deletedUuids = [veryOldTombstone];
  mergeSyncPayload(local, payloadFrom([]), "device-b"); // an unrelated merge shouldn't sweep old tombstones as a side effect
  assert.deepEqual(local.deletedUuids, [veryOldTombstone]);
});

test("mergeSyncPayload: an edit AFTER a peer's delete resurrects the item (edit-after-delete wins)", () => {
  const local = emptyStore();
  local.deletedUuids = [{ uuid: "some-uuid", deletedAt: "2020-01-01T00:00:00.000Z", deviceId: "device-a", localSeq: 1 }];

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
    workingDeviceId: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", // long after the tombstone
    revision: 1,
    localSeq: 1,
    workspace: null,
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

test("mergeSyncPayload: a javascript: sourceUrl from a peer is dropped, not stored (regression: a hostile peer could otherwise plant a click-XSS link)", () => {
  const local = emptyStore();
  const remoteStore = emptyStore();
  const remote = createTodo(remoteStore, { title: "From peer", agent: null, session: null }, "peer-device", "Peer");
  (remote as unknown as { sourceUrl: string }).sourceUrl = "javascript:alert(1)";
  mergeSyncPayload(local, payloadFrom([remote]), "peer-device");
  assert.equal(local.todos[0].sourceUrl, null);
});

test("mergeSyncPayload: a bogus history.action from a peer is dropped, not stored (regression: the web UI renders history.action unescaped)", () => {
  const local = emptyStore();
  const remoteStore = emptyStore();
  const remote = createTodo(remoteStore, { title: "From peer", agent: null, session: null }, "peer-device", "Peer");
  remote.history.push({
    at: new Date().toISOString(),
    agent: "peer",
    deviceName: "Peer",
    action: '<img src=x onerror=alert(1)>' as unknown as Todo["history"][number]["action"],
    detail: "hostile",
  });
  mergeSyncPayload(local, payloadFrom([remote]), "peer-device");
  assert.equal(local.todos[0].history.length, 1); // only the legitimate "created" entry survives
  assert.equal(local.todos[0].history[0].action, "created");
});

test("mergeSyncPayload: a non-object history entry from a peer is dropped instead of crashing rendering", () => {
  const local = emptyStore();
  const remoteStore = emptyStore();
  const remote = createTodo(remoteStore, { title: "From peer", agent: null, session: null }, "peer-device", "Peer");
  (remote.history as unknown[]).push("not an object", null, 42);
  mergeSyncPayload(local, payloadFrom([remote]), "peer-device");
  assert.equal(local.todos[0].history.length, 1);
});

test("mergeSyncPayload: fieldTimestamps from a peer are clamped to known fields, unknown keys stripped", () => {
  const local = emptyStore();
  const remoteStore = emptyStore();
  const remote = createTodo(remoteStore, { title: "From peer", agent: null, session: null }, "peer-device", "Peer");
  (remote as unknown as { fieldTimestamps: Record<string, string> }).fieldTimestamps = {
    title: remote.createdAt,
    __proto__: "polluted",
    notARealField: "2026-01-01T00:00:00.000Z",
  };
  mergeSyncPayload(local, payloadFrom([remote]), "peer-device");
  const stored = local.todos[0].fieldTimestamps as Record<string, unknown>;
  assert.ok(!("notARealField" in stored));
  assert.equal(stored.title, remote.createdAt);
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

test("pairingSas: deterministic and order-independent — either device computes the same code", () => {
  const secret = "a".repeat(64);
  const pubA = "pubkey-A-base64url-ish";
  const pubB = "pubkey-B-base64url-ish";
  const sas1 = pairingSas(secret, pubA, pubB);
  const sas2 = pairingSas(secret, pubB, pubA); // the other device computes it with args swapped
  assert.equal(sas1, sas2);
  assert.match(sas1, /^\d{6}$/);
});

test("pairingSas: a different secret (regression: what an active MITM substituting a public key would cause) yields a different code", () => {
  const pubA = "pubkey-A-base64url-ish";
  const pubB = "pubkey-B-base64url-ish";
  const sasReal = pairingSas("a".repeat(64), pubA, pubB);
  const sasMitm = pairingSas("b".repeat(64), pubA, pubB); // MITM's secret differs from the real one
  assert.notEqual(sasReal, sasMitm);
});

test("pairingSas: a different public key pair (a substituted key) yields a different code even with the same secret", () => {
  const secret = "a".repeat(64);
  const sasReal = pairingSas(secret, "pubkey-A", "pubkey-B");
  const sasTampered = pairingSas(secret, "pubkey-A", "attacker-pubkey");
  assert.notEqual(sasReal, sasTampered);
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

test("isSyncProtocolCompatible: a legacy peer that sent no version at all is treated as compatible", () => {
  assert.equal(isSyncProtocolCompatible(null), true);
  assert.equal(isSyncProtocolCompatible(undefined), true);
});

test("isSyncProtocolCompatible: the current minimum version and anything newer are compatible", () => {
  assert.equal(isSyncProtocolCompatible(MIN_COMPATIBLE_SYNC_PROTOCOL_VERSION), true);
  assert.equal(isSyncProtocolCompatible(MIN_COMPATIBLE_SYNC_PROTOCOL_VERSION + 5), true);
});

test("isSyncProtocolCompatible: a version below the minimum is rejected", () => {
  assert.equal(isSyncProtocolCompatible(MIN_COMPATIBLE_SYNC_PROTOCOL_VERSION - 1), false);
});

// --- Boundaries the mutation sweep found unguarded ---------------------------------------

test("verifySyncRequest: the replay window is exclusive at its edge, and a request just outside is refused", () => {
  // Killed mutant: `Math.abs(now - ts) > SIGNATURE_WINDOW_MS` → `>=`. This is the replay
  // guard: a captured request must stop being accepted once it is older than the window,
  // and the boundary is the only interesting part of a comparison like this.
  const secret = "a".repeat(64);
  const sign = (timestamp: string) => signSyncRequest(secret, "device-a", "0", timestamp);

  const now = Date.now();
  const justInside = new Date(now - (2 * 60_000 - 2_000)).toISOString();
  assert.equal(verifySyncRequest(secret, "device-a", "0", justInside, sign(justInside)), true, "a fresh request was refused");

  const wellOutside = new Date(now - 10 * 60_000).toISOString();
  assert.equal(verifySyncRequest(secret, "device-a", "0", wellOutside, sign(wellOutside)), false, "a stale request was replayable");

  const fromTheFuture = new Date(now + 10 * 60_000).toISOString();
  assert.equal(verifySyncRequest(secret, "device-a", "0", fromTheFuture, sign(fromTheFuture)), false, "the window must be two-sided");

  assert.equal(verifySyncRequest(secret, "device-a", "0", "not-a-timestamp", sign("not-a-timestamp")), false);
});

test("checkPairingRateLimit: allows exactly the documented number of attempts, then refuses", () => {
  // Killed mutants: `entry.count <= PAIR_RATE_LIMIT` → `<`, and the window comparisons.
  // This is what makes the 6-character pairing code impractical to brute-force; an
  // off-by-one either locks out a legitimate retry or widens the attack by one guess a
  // window, and nothing else in the suite pins the number.
  const ip = `10.0.0.${Math.floor(Math.random() * 200) + 1}`;
  const allowed: boolean[] = [];
  for (let i = 0; i < 10; i++) allowed.push(checkPairingRateLimit(ip));

  assert.deepEqual(allowed.slice(0, 8), Array(8).fill(true), "a legitimate run of attempts was cut short");
  assert.deepEqual(allowed.slice(8), [false, false], "attempts past the limit were still allowed");
});

test("checkPairingRateLimit: a different source address has its own budget", () => {
  const a = `10.1.0.${Math.floor(Math.random() * 200) + 1}`;
  const b = `10.2.0.${Math.floor(Math.random() * 200) + 1}`;
  for (let i = 0; i < 9; i++) checkPairingRateLimit(a);
  assert.equal(checkPairingRateLimit(a), false, "precondition: the first address is now blocked");
  assert.equal(checkPairingRateLimit(b), true, "one attacker must not lock out everyone else");
});

test("redeemInvite: a token is one-time, and an unknown token is refused", () => {
  // Killed mutants around the invite's expiry comparison. A token that survives redemption
  // is a token that can be replayed by anyone who saw it over the shoulder.
  const { token } = createInvite();
  assert.equal(redeemInvite(token), true);
  assert.equal(redeemInvite(token), false, "the invite was redeemable twice");
  assert.equal(redeemInvite("ZZZZZZ"), false);
  assert.equal(redeemInvite(token.toLowerCase()), false, "a consumed token must stay consumed however it is cased");
});

test("mergeSyncPayload: a tombstone identical to the one we hold is not re-adopted", () => {
  // Killed mutant: `remoteTomb.deletedAt > existingTombstone.deletedAt` → `>=`. Adopting an
  // identical tombstone stamps a fresh sequence number for no change at all, which makes
  // two peers re-notify each other about the same deletion forever.
  const store = emptyStore();
  const item = createTodo(store, { title: "doomed", agent: null, session: null }, "device-a", "A");
  tombstoneDelete(store, item, "device-a");
  const tombstone = { ...store.deletedUuids[0] };
  const counterBefore = store.seqCounter;

  mergeSyncPayload(store, { todos: [], deletedUuids: [tombstone], serverTime: new Date().toISOString(), protocolVersion: 2 }, "peer");
  assert.equal(store.seqCounter, counterBefore, "re-receiving our own tombstone burned a sequence number");
  assert.equal(store.deletedUuids.length, 1, "and duplicated it");
});

test("generateShortCode: the pairing code has the length and charset the brute-force argument depends on", () => {
  // Killed mutant: `CODE_LENGTH = 6` → anything else. Six characters from a 32-symbol
  // unambiguous set is ~1.07e9 combinations; together with the 5-minute single-use TTL and
  // the rate limit above, that is the whole reason a pairing code is safe to read aloud.
  // Change either half and the argument stops holding, silently.
  const codes = Array.from({ length: 200 }, () => generateShortCode());
  for (const code of codes) {
    assert.equal(code.length, 6, `pairing code "${code}" is not 6 characters`);
    assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/, `"${code}" uses characters outside the unambiguous set`);
  }
  // 0/O and 1/I/L are excluded because a human reads this across a room; if they reappear,
  // the code is harder to transcribe rather than more secure.
  assert.ok(!codes.join("").match(/[01OIL]/), "an easily-misread character entered the charset");
  assert.ok(new Set(codes).size > 190, "codes are not being drawn from the space randomly");
});

test("mergeSyncPayload: a tombstone stamped at exactly the item's updatedAt still deletes it", () => {
  // Killed mutant: `local.updatedAt <= effective.deletedAt` → `<`.
  //
  // Two places decide the same tie and MUST agree: this one applies an incoming deletion,
  // and the todos loop above refuses to re-insert an item its tombstone covers
  // (`tombstone.deletedAt >= remote.updatedAt`). Both give an exact tie to the tombstone. If
  // only one flips, the same record is deleted by one path and resurrected by the other on
  // every tick — the item flickers in and out of the list forever instead of settling.
  const store = emptyStore();
  const item = createTodo(store, { title: "tie", agent: null, session: null }, "device-a", "A");
  const exactTie = item.updatedAt;

  const result = mergeSyncPayload(
    store,
    { todos: [], deletedUuids: [{ uuid: item.uuid, deletedAt: exactTie, deviceId: "device-b", localSeq: 1 }], serverTime: new Date().toISOString(), protocolVersion: 2 },
    "device-b",
  );
  assert.equal(result.deleted, 1, "a deletion at the same instant as the last edit must win the tie");
  assert.equal(store.todos.length, 0);

  // ...and the other half of the rule: the peer re-sending that same item must not undo it.
  mergeSyncPayload(
    store,
    { todos: [structuredClone(item)], deletedUuids: [], serverTime: new Date().toISOString(), protocolVersion: 2 },
    "device-b",
  );
  assert.equal(store.todos.length, 0, "the item came back — the two tie rules disagree and it will flicker forever");
});
