import { dedupeHistory, pushHistory } from "../history.js";
import { log } from "../log.js";
import { FIELD_KEYS, stampSeq, type FieldKey } from "../mutations.js";
import type { Todo, TodoStore, Tombstone } from "../types.js";
import { MAX_INCOMING_ITEMS, type SyncPayload } from "./payload.js";
import { isPlausibleTodo, sanitizeRemoteTodo, sanitizeTombstone } from "./sanitize.js";

/**
 * Conflict resolution: last-write-wins per FIELD, with a total order for ties.
 *
 * The only pure module in this directory — no I/O, no clock beyond what the records carry,
 * no network. That is what makes convergence testable by generating random topologies and
 * replaying them (sync.convergence.property.test.ts), and it is worth keeping that way.
 */

function fieldTimeOf(t: Todo, field: FieldKey): string {
  // Falls back to createdAt, NOT updatedAt: updatedAt reflects the record's most
  // recent change to ANY field, so using it here would make an untouched field
  // look like it changed whenever a DIFFERENT field on the same record did —
  // exactly the whole-object clobbering per-field merge exists to avoid.
  return t.fieldTimestamps?.[field] ?? t.createdAt;
}

/**
 * Deterministic tie-break for an EXACT timestamp tie (both devices touched the same field
 * at the identical wall-clock instant — rare, but the plain `remoteTime > localTime`
 * comparison this replaces silently favored "local incumbent" on a tie without either side
 * agreeing that's the rule, so the two devices weren't guaranteed to converge on the same
 * winner. This makes it an explicit, symmetric rule both sides evaluate the same way.
 * Doesn't address clock SKEW itself (one device's timestamps running systematically fast
 * or slow) — that needs a logical/hybrid clock replacing wall-clock timestamps outright,
 * a bigger format change given how much of the stored data is plain ISO strings today.
 */
function remoteWinsTie(remote: Todo, local: Todo): boolean {
  return (remote.deviceId ?? "") > (local.deviceId ?? "");
}

/**
 * Tie-break for one FIELD, and unlike the record-level one above it has to be TOTAL.
 *
 * `remoteWinsTie` breaks a tie by deviceId, which is fine until both copies carry the same
 * deviceId — which happens routinely, because a merged record adopts the deviceId of
 * whoever last wrote it, so two peers that merged from the same origin end up agreeing on
 * it. Then the comparison returns false in BOTH directions: each side keeps its own value
 * and neither ever adopts the other's. That is not a slow convergence, it is a permanent
 * split, and no amount of further syncing repairs it.
 *
 * Falling back to the values themselves fixes it because it is the one thing guaranteed to
 * differ when there is anything to resolve, and both sides compute the same answer from it.
 * Which value wins is arbitrary; that they AGREE is the entire point.
 */
function remoteWinsFieldTie(remote: Todo, local: Todo, remoteValue: unknown, localValue: unknown): boolean {
  const byDevice = (remote.deviceId ?? "").localeCompare(local.deviceId ?? "");
  if (byDevice !== 0) return byDevice > 0;
  return JSON.stringify(remoteValue ?? null) > JSON.stringify(localValue ?? null);
}

/** Copies whichever fields the remote touched more recently onto `local`, field by field, so two independent edits to DIFFERENT fields both survive instead of one whole-record timestamp clobbering the other. Returns whether anything changed. */
function mergeTodoFields(local: Todo, remote: Todo): boolean {
  let changed = false;
  local.fieldTimestamps = local.fieldTimestamps ?? {};
  // Fields where BOTH sides independently touched it (local had its own fieldTimestamp
  // already) and disagreed on the value — a genuine conflict the merge resolved, worth
  // recording distinctly from "remote simply had data local never touched" (below).
  const conflictsResolved: string[] = [];
  for (const field of FIELD_KEYS) {
    const remoteTime = fieldTimeOf(remote, field);
    const localTime = fieldTimeOf(local, field);
    const localValue = (local as unknown as Record<FieldKey, unknown>)[field];
    const remoteValue = (remote as unknown as Record<FieldKey, unknown>)[field];
    if (remoteTime > localTime || (remoteTime === localTime && remoteWinsFieldTie(remote, local, remoteValue, localValue))) {
      if (field in local.fieldTimestamps && localValue !== remoteValue) conflictsResolved.push(field);
      (local as unknown as Record<FieldKey, unknown>)[field] = remoteValue;
      local.fieldTimestamps[field] = remoteTime;
      // Only a different VALUE counts as a change. Adopting a newer timestamp for a value
      // we already hold is bookkeeping, and reporting it as a change would stamp a new
      // sequence number and bounce the identical record around the mesh for another hop.
      if (localValue !== remoteValue) changed = true;
    }
  }
  if (remote.updatedAt > local.updatedAt || (remote.updatedAt === local.updatedAt && remoteWinsTie(remote, local))) {
    local.updatedAt = remote.updatedAt;
    local.deviceId = remote.deviceId;
    local.deviceName = remote.deviceName;
  }
  if (conflictsResolved.length > 0) {
    pushHistory(
      local,
      "sync",
      "synced",
      `conflict resolved from ${remote.deviceName ?? remote.deviceId ?? "peer"}: ${conflictsResolved.join(", ")} — peer's newer edit won`,
      remote.deviceName ?? null,
    );
  }
  local.history = mergeHistories(local.history, remote.history);
  return changed;
}

/**
 * Merges a peer's sync response into the local store. Pure function over the
 * store the caller already holds the write lock for — never fetches or writes
 * peers.json itself.
 */
export function mergeSyncPayload(
  store: TodoStore,
  payload: SyncPayload,
  peerId: string,
): { inserted: number; updated: number; deleted: number; truncated: boolean } {
  let inserted = 0;
  let updated = 0;
  let deleted = 0;

  store.deletedUuids = store.deletedUuids ?? [];
  const localTombstones = new Map(store.deletedUuids.map((t) => [t.uuid, t]));
  // Indexed once rather than scanned per incoming record. A page is up to PAGE_SIZE
  // records and this runs inside the store's cross-process lock, so an O(incoming × store)
  // scan here doesn't just cost this merge — it holds every other docket process on the
  // machine behind it for the duration.
  const localByUuid = new Map(store.todos.map((t) => [t.uuid, t]));

  const rawTodos = Array.isArray(payload.todos) ? payload.todos : [];
  const rawTombstones = Array.isArray(payload.deletedUuids) ? payload.deletedUuids : [];
  // Truncation here is never routine: a v2 peer pages, and a v1 peer sends its whole
  // backlog at once, which MAX_INCOMING_ITEMS is sized to accept. Reported to the caller
  // because on the legacy path it is the difference between "everything the peer offered
  // landed" and "the cursor must not move".
  const truncated = rawTodos.length > MAX_INCOMING_ITEMS || rawTombstones.length > MAX_INCOMING_ITEMS;
  const incomingTodos = rawTodos.slice(0, MAX_INCOMING_ITEMS).filter(isPlausibleTodo).map(sanitizeRemoteTodo);
  const incomingTombstones = rawTombstones
    .slice(0, MAX_INCOMING_ITEMS)
    .map(sanitizeTombstone)
    .filter((t): t is Tombstone => t !== null);

  // The newest author-clock value this merge actually took in. The legacy (protocol v1)
  // cursor is a timestamp, and advancing it to the peer's "now" would step over anything
  // the merge didn't reach; advancing it to this instead can only ever under-advance,
  // which costs a re-fetch rather than a lost record.
  const removedUuids = new Set<string>();

  for (const remote of incomingTodos) {
    const tombstone = localTombstones.get(remote.uuid);
    if (tombstone && tombstone.deletedAt >= remote.updatedAt) continue; // deleted locally after (or at) the remote edit — stays deleted

    const local = localByUuid.get(remote.uuid);
    if (!local) {
      const insertedTodo = { ...remote, id: store.nextId };
      stampSeq(store, insertedTodo);
      store.todos.push(insertedTodo);
      localByUuid.set(insertedTodo.uuid, insertedTodo);
      store.nextId += 1;
      inserted += 1;
      continue;
    }
    // The actual fix for transitive propagation: accepting someone else's change is a
    // LOCAL write. Without a fresh local sequence number the record keeps the author's
    // older updatedAt, sits below a third peer's cursor, and is never handed on.
    const changed = mergeTodoFields(local, remote);
    if (changed) updated += 1;
    // ...and so is REFUSING one. If our copy still differs from what the peer just sent,
    // then their copy is stale and they don't know it: their cursor has already moved past
    // our record, so they will never ask for it again, and both sides keep their own value
    // forever. A merge is a conversation — winning it is exactly when the other side most
    // needs to hear from us. Once both agree there is nothing left to differ on, this stops
    // firing, so it settles rather than ping-ponging.
    const stillDiffers = FIELD_KEYS.some(
      (field) => (local as unknown as Record<FieldKey, unknown>)[field] !== (remote as unknown as Record<FieldKey, unknown>)[field],
    );
    if (changed || stillDiffers) stampSeq(store, local);
  }

  for (const remoteTomb of incomingTombstones) {
    const existingTombstone = localTombstones.get(remoteTomb.uuid);
    if (!existingTombstone) {
      stampSeq(store, remoteTomb);
      store.deletedUuids.push(remoteTomb);
      localTombstones.set(remoteTomb.uuid, remoteTomb);
    } else if (remoteTomb.deletedAt > existingTombstone.deletedAt) {
      // A LATER deletion of an item we already have a tombstone for. Adopting it is a
      // local write and must be sequenced, or the second deletion never reaches a third
      // device: it keeps comparing edits against the ORIGINAL, older deletedAt, decides
      // its copy is newer, and resurrects an item everyone else agreed was gone. Skipping
      // this case is what the spec's "stamp every newly ADDED tombstone" rule misses.
      existingTombstone.deletedAt = remoteTomb.deletedAt;
      existingTombstone.deviceId = remoteTomb.deviceId;
      stampSeq(store, existingTombstone);
    }
    const effective = localTombstones.get(remoteTomb.uuid)!;
    const local = localByUuid.get(remoteTomb.uuid);
    if (local && local.updatedAt <= effective.deletedAt) {
      // Collected, not spliced. Filtering the array per deletion rebuilds the whole store
      // each time — a bulk delete on a peer turns into O(deletions × store) copying, again
      // while holding the lock.
      removedUuids.add(remoteTomb.uuid);
      localByUuid.delete(remoteTomb.uuid);
      deleted += 1;
    }
  }
  if (removedUuids.size > 0) store.todos = store.todos.filter((t) => !removedUuids.has(t.uuid));

  // Tombstones are kept indefinitely — NOT purged by age. A device that's been offline
  // longer than any fixed retention window (a laptop unused for a couple of months, say)
  // would otherwise reconnect to find the tombstone for an item it still has already
  // gone, sync its still-alive copy back out, and resurrect a deletion every other peer
  // already agreed on. GC-by-age trades that correctness risk for disk space this app
  // doesn't meaningfully need to reclaim; a future ACK-based GC (only drop a tombstone
  // once every paired peer has confirmed seeing it) would reclaim space safely instead.

  if (inserted || updated || deleted) log(`sync: merged from peer ${peerId} — +${inserted} ~${updated} -${deleted}`);
  if (truncated) log(`sync: peer ${peerId} sent more than ${MAX_INCOMING_ITEMS} records in one response — merged what fit, cursor held back`);
  return { inserted, updated, deleted, truncated };
}

/**
 * A peer only ever sends the inline preview (see HISTORY_INLINE_MAX), so this merges recent
 * entries, not whole logs. That is the honest limit of history over sync: the audit log is
 * per-device and complete locally, and what crosses the wire is the tail. Trading a
 * complete cross-device log for a write path that doesn't grow without bound is the right
 * way round — the log is a diagnostic, and the store is the data.
 */
function mergeHistories(a: Todo["history"], b: Todo["history"]): Todo["history"] {
  // Deliberately NOT trimmed here. Trimming at merge time destroys local entries that were
  // never flushed to the side file — an item below the flush threshold has its whole log
  // inline and nowhere else — which would make docs/security.md's "complete on the device
  // that produced it" a lie. flushOverflowHistory runs later in the same withStore call and
  // is the one place allowed to drop an inline entry, because it has just persisted it.
  return dedupeHistory([...a, ...b]);
}
