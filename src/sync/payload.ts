import { decryptWithKey, encryptWithKey } from "../crypto.js";
import type { Todo, TodoStore, Tombstone } from "../types.js";

/**
 * The wire format: protocol negotiation, what one page of a sync response contains, and
 * the envelope rules that decide how far a response may move the caller's cursor.
 *
 * Both halves of the conversation live here on purpose — the server builds a page and the
 * client validates one, and the two rules only make sense read side by side.
 */

/**
 * Bump on any wire-format change a peer running the previous version would misread.
 * A peer that doesn't send its version at all predates this negotiation entirely —
 * treated as compatible (there's nothing to compare against), never rejected outright.
 */
export const SYNC_PROTOCOL_VERSION = 2;
/** The oldest peer protocolVersion this build still knows how to talk to. Deliberately still
 * 1 for v3.0: a v1 peer is degraded (see the fallback in pullFromPeer, which says so out
 * loud on the peer record) but not cut off, so upgrading a mesh doesn't have to be atomic.
 * This is a shim with an expiry, not furniture — it should move to 2 in the release that
 * removes P2P sync, taking the fallback path and MAX_INCOMING_ITEMS's generous ceiling with
 * it. */
export const MIN_COMPATIBLE_SYNC_PROTOCOL_VERSION = 1;

export function isSyncProtocolCompatible(peerProtocolVersion: number | null | undefined): boolean {
  if (peerProtocolVersion == null) return true; // legacy peer, predates negotiation — allow
  return peerProtocolVersion >= MIN_COMPATIBLE_SYNC_PROTOCOL_VERSION;
}

export interface SyncPayload {
  todos: Todo[];
  deletedUuids: Tombstone[];
  serverTime: string;
  protocolVersion: number;
  /** How far into THIS store's localSeq space the page reaches. The caller's new cursor —
   * and only ever a point everything below which was actually sent. Absent from a v1 peer's
   * response, which is how the client detects one (see pullFromPeer). */
  maxSeq?: number;
  /** True when records above `maxSeq` are still waiting. The caller loops rather than
   * assuming one page is the whole story. */
  hasMore?: boolean;
  /** Which incarnation of the sender's store `maxSeq` counts in — see getStoreEpoch in
   * storage.ts. A caller holding a cursor from a different epoch must discard it: the
   * sender restored a backup and its counter went backwards, so every number the caller
   * remembers now points past records it has never seen. */
  epoch?: string;
}

/** One page of records per sync response. Chosen for a payload that stays comfortably inside one encrypted response body, not for any protocol reason — the caller pages until `hasMore` is false, so the exact value is a tuning knob, not a limit on what can sync. */
export const PAGE_SIZE = 500;

/**
 * Hard ceiling on what ONE response may put into the store. Deliberately far above
 * PAGE_SIZE: this is a guard against a peer (buggy or hostile) sending an unbounded
 * payload, not a delivery limit. Conflating the two is what made the old cap dangerous —
 * a v1 peer doesn't page at all, so clamping its response to a page size would silently
 * drop the tail exactly the way v3.0 exists to stop. `mergeSyncPayload` reports when it
 * had to clamp so the caller can refuse to advance its cursor past the gap.
 */
export const MAX_INCOMING_ITEMS = 20_000;

/**
 * The pre-v8 timestamp cursor, kept verbatim for peers still on sync protocol v1. It is the
 * buggy path — a record merged in from a third device carries that device's older
 * `updatedAt` and falls below this filter — which is exactly why the client that receives
 * one of these responses flags the peer instead of pretending the sync was clean.
 */
export function buildLegacySyncPayload(store: TodoStore, since: string): SyncPayload {
  return {
    todos: store.todos.filter((t) => t.updatedAt > since),
    deletedUuids: (store.deletedUuids ?? []).filter((t) => t.deletedAt > since),
    serverTime: new Date().toISOString(),
    protocolVersion: SYNC_PROTOCOL_VERSION,
  };
}

/**
 * Builds the response a peer's GET /api/sync gets back. Lives here rather than inline in
 * web/api.ts's route handler so the delivery rule (what a peer is and isn't told about)
 * is testable without standing up an HTTP server, and so the client half in this same
 * file can be reasoned about next to it.
 *
 * `maxSeq` is the whole point: it is the highest sequence number this page can PROMISE is
 * fully delivered. Todos and tombstones page independently off the same cursor, so when
 * either stream is truncated the promise is capped at that stream's last row — advancing
 * to the other stream's (higher) end would step over records the truncated stream still
 * owes. Cheap to get right here; impossible to detect later, because the symptom is
 * silence.
 */
export function buildSyncPayload(store: TodoStore, sinceSeq: number, epoch?: string): SyncPayload {
  const bySeq = (a: { localSeq: number }, b: { localSeq: number }) => a.localSeq - b.localSeq;
  const todoCandidates = store.todos.filter((t) => t.localSeq > sinceSeq).sort(bySeq);
  const tombCandidates = (store.deletedUuids ?? []).filter((t) => t.localSeq > sinceSeq).sort(bySeq);
  const todos = todoCandidates.slice(0, PAGE_SIZE);
  const deletedUuids = tombCandidates.slice(0, PAGE_SIZE);
  const todosTruncated = todoCandidates.length > PAGE_SIZE;
  const tombsTruncated = tombCandidates.length > PAGE_SIZE;

  const ceiling = (page: Array<{ localSeq: number }>, truncated: boolean) =>
    truncated ? page[page.length - 1].localSeq : (store.seqCounter ?? 0);

  return {
    todos,
    deletedUuids,
    serverTime: new Date().toISOString(),
    protocolVersion: SYNC_PROTOCOL_VERSION,
    maxSeq: Math.max(sinceSeq, Math.min(ceiling(todos, todosTruncated), ceiling(deletedUuids, tombsTruncated))),
    hasMore: todosTruncated || tombsTruncated,
    epoch,
  };
}

/** Thrown when a response's envelope — the fields that steer the cursor — is not usable. */
export class InvalidSyncEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSyncEnvelopeError";
  }
}

const isSeq = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * How far one response is allowed to move the delivery cursor.
 *
 * The cursor is the single piece of sync state where a wrong value is both silent and
 * permanent: advance it past records that were never delivered and this device stops asking
 * for that range forever. Nothing downstream notices, because the symptom is an absence.
 * Until now `payload.maxSeq` was taken at face value, so one buggy peer — an off-by-one in
 * a reimplementation, a corrupted number, a counter reset without an epoch change — could
 * inflict exactly that.
 *
 * Two rules, and deliberately only two:
 *  - the number must BE a sequence number (a non-negative safe integer);
 *  - a page that carried records cannot promise more than its highest record. A correct
 *    peer's `maxSeq` is already at or below that (buildSyncPayload takes the min-ceiling of
 *    the two streams), so this clamps liars without touching honest peers.
 *
 * An EMPTY page is the peer saying "you are caught up", and there is nothing to check its
 * number against. That is not a hole this can close: a peer able to withhold records can
 * always simply withhold them. The epoch check upstream covers the honest version of this
 * (a peer whose counter went backwards after a restore).
 */
export function cursorAfterPage(payload: SyncPayload, current: number): number {
  if (!isSeq(payload.maxSeq)) {
    throw new InvalidSyncEnvelopeError(`peer sent maxSeq ${JSON.stringify(payload.maxSeq)}, which is not a sequence number`);
  }
  const delivered: number[] = [];
  for (const record of [...(payload.todos ?? []), ...(payload.deletedUuids ?? [])]) {
    const seq = (record as { localSeq?: unknown } | null)?.localSeq;
    if (isSeq(seq)) delivered.push(seq);
  }
  const promised = delivered.length > 0 ? Math.min(payload.maxSeq, Math.max(...delivered)) : payload.maxSeq;
  // Never backwards: re-merging is harmless but re-requesting the same range every tick is
  // not, and a peer that keeps sending a lower number would pin this device there forever.
  return Math.max(current, promised);
}

/** AES-256-GCM encrypt a sync response with the peer's derived secret, so payload contents aren't plaintext on the LAN. */
export function encryptSyncPayload(secretHex: string, payload: SyncPayload): { encrypted: string } {
  const key = Buffer.from(secretHex, "hex");
  return { encrypted: encryptWithKey(key, JSON.stringify(payload)).toString("base64") };
}

export function decryptSyncPayload(secretHex: string, encryptedBase64: string): SyncPayload {
  const key = Buffer.from(secretHex, "hex");
  return JSON.parse(decryptWithKey(key, Buffer.from(encryptedBase64, "base64"))) as SyncPayload;
}
