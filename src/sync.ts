import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { decryptWithKey, encryptWithKey } from "./crypto.js";
import { dedupeHistory, pushHistory } from "./history.js";
import { log } from "./log.js";
import { FIELD_KEYS, isSafeUrl, stampSeq, type FieldKey } from "./mutations.js";
import { loadPeers, markPeerSynced } from "./peers.js";
import type { Peer, Todo, TodoStore, Tombstone } from "./types.js";

const INVITE_TTL_MS = 5 * 60_000; // one-time pairing token, 5 minutes
const OUTGOING_TTL_MS = 5 * 60_000; // give up waiting for approval after 5 minutes
const INCOMING_TTL_MS = 5 * 60_000; // an incoming request nobody approved/denied in time disappears, rather than sitting forever for a stale click later
const SIGNATURE_WINDOW_MS = 2 * 60_000; // reject sync requests with a timestamp off by more than this (replay protection)
// Per-ITEM history cap, not a delivery limit: a genuine guard against a peer (buggy or
// hostile) stuffing an unbounded history array into one record. Delivery is bounded by
// PAGE_SIZE and the caller's page loop instead — see pullFromPeer.
const MAX_HISTORY_ENTRIES = 2000;
const PAIR_RATE_LIMIT = 8; // pairing-request attempts...
const PAIR_RATE_WINDOW_MS = 5 * 60_000; // ...per source IP, per this window

// No 0/O, 1/I/L — easy to misread across a room or off a low-res screen. 6 chars
// from this 32-symbol set is ~1.07e9 combinations; with a 5-minute single-use TTL
// and PAIR_RATE_LIMIT above, brute-forcing it isn't practical.
// Exported for reuse by server-pairing codes (src/server/devices.ts, RFC §13) — same
// unambiguous charset/length, no reason to invent a second one.
export const CODE_CHARSET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

export function generateShortCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARSET[randomInt(CODE_CHARSET.length)];
  return code;
}

interface PendingInvite {
  expiresAt: number;
}

interface PendingIncoming {
  deviceId: string;
  deviceName: string;
  callbackUrl: string;
  /** The requester's X25519 public key — we derive the shared secret from this + our own private key; it is never transmitted. */
  peerPublicKeyX: string;
  receivedAt: number;
  /** Short Authentication String — shown to the human alongside Approve/Deny so they can
   * compare it against what the OTHER device shows before confirming. See pairingSas(). */
  sas: string;
}

interface PendingOutgoing {
  peerUrl: string;
  status: "pending" | "confirmed" | "denied";
  peerDeviceId?: string;
  peerDeviceName?: string;
  createdAt: number;
  /** The host's public key, if it was carried in the invite (QR/full-line paste) rather than
   * just the bare 6-char code — lets this device anchor trust in the host's identity via the
   * SAME out-of-band channel as the code, before any network round-trip. */
  expectedPublicKeyX?: string;
  /** Computed the moment this device redeems, from its own locally-derived secret — shown to
   * the human so they can compare it against the host's screen. Present only when
   * expectedPublicKeyX was available. */
  sas?: string;
}

// Ephemeral, in-memory only — pairing state does not need to survive a restart,
// and keeping it off disk shrinks what a compromised backup/disk could expose.
const pendingInvites = new Map<string, PendingInvite>();
const pendingIncoming = new Map<string, PendingIncoming>();
const pendingOutgoing = new Map<string, PendingOutgoing>();
const pairAttempts = new Map<string, { count: number; windowStart: number }>();

function reapExpired(): void {
  const now = Date.now();
  for (const [token, invite] of pendingInvites) if (invite.expiresAt < now) pendingInvites.delete(token);
  for (const [id, req] of pendingOutgoing) if (now - req.createdAt > OUTGOING_TTL_MS) pendingOutgoing.delete(id);
  for (const [id, req] of pendingIncoming) if (now - req.receivedAt > INCOMING_TTL_MS) pendingIncoming.delete(id);
  for (const [ip, entry] of pairAttempts) if (now - entry.windowStart > PAIR_RATE_WINDOW_MS) pairAttempts.delete(ip);
}

/** Caps pairing attempts per source IP so the one-time invite token can't be brute-forced. */
export function checkPairingRateLimit(sourceIp: string): boolean {
  reapExpired();
  const now = Date.now();
  const entry = pairAttempts.get(sourceIp);
  if (!entry || now - entry.windowStart > PAIR_RATE_WINDOW_MS) {
    pairAttempts.set(sourceIp, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= PAIR_RATE_LIMIT;
}

export function createInvite(): { token: string; expiresAt: number } {
  reapExpired();
  let token: string;
  do {
    token = generateShortCode();
  } while (pendingInvites.has(token)); // astronomically unlikely, but never silently collide two invites
  const expiresAt = Date.now() + INVITE_TTL_MS;
  pendingInvites.set(token, { expiresAt });
  return { token, expiresAt };
}

/** One-time: the token is consumed whether or not the caller goes on to approve. */
export function redeemInvite(token: string): boolean {
  reapExpired();
  const normalized = token.trim().toUpperCase();
  const invite = pendingInvites.get(normalized);
  if (!invite) return false;
  pendingInvites.delete(normalized);
  return invite.expiresAt >= Date.now();
}

export function addIncomingRequest(requestId: string, req: PendingIncoming): void {
  reapExpired();
  pendingIncoming.set(requestId, req);
}

export function getIncomingRequest(requestId: string): PendingIncoming | undefined {
  reapExpired();
  return pendingIncoming.get(requestId);
}

export function removeIncomingRequest(requestId: string): void {
  pendingIncoming.delete(requestId);
}

export function listIncomingRequests(): Array<{ requestId: string } & Omit<PendingIncoming, "peerPublicKeyX">> {
  reapExpired();
  return [...pendingIncoming.entries()].map(([requestId, req]) => {
    const { peerPublicKeyX: _peerPublicKeyX, ...safe } = req;
    return { requestId, ...safe };
  });
}

export function addOutgoingRequest(requestId: string, req: Omit<PendingOutgoing, "createdAt">): void {
  pendingOutgoing.set(requestId, { ...req, createdAt: Date.now() });
}

export function getOutgoingRequest(requestId: string): PendingOutgoing | undefined {
  reapExpired();
  return pendingOutgoing.get(requestId);
}

export function resolveOutgoingRequest(
  requestId: string,
  outcome: { status: "confirmed"; peerDeviceId: string; peerDeviceName: string } | { status: "denied" },
): boolean {
  const req = pendingOutgoing.get(requestId);
  if (!req) return false;
  req.status = outcome.status;
  if (outcome.status === "confirmed") {
    req.peerDeviceId = outcome.peerDeviceId;
    req.peerDeviceName = outcome.peerDeviceName;
  }
  return true;
}

function hmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Proves the confirm callback actually derived the same ECDH secret we did, not just that it knows the request id. */
export function confirmProof(secret: string, requestId: string): string {
  return hmac(secret, `confirm:${requestId}`);
}

/**
 * Short Authentication String — a human-comparable code binding the derived secret to
 * BOTH devices' public keys (transcript binding). If an active attacker on the LAN
 * substituted either public key in transit, the two sides end up deriving different
 * secrets and this code differs — comparing it on both screens catches that before a
 * human clicks Approve. Order-independent so either side can compute it the same way
 * without agreeing in advance who's "A" and who's "B".
 */
export function pairingSas(secretHex: string, publicKeyA: string, publicKeyB: string): string {
  const [first, second] = [publicKeyA, publicKeyB].sort();
  const digest = createHmac("sha256", Buffer.from(secretHex, "hex")).update(`sas:${first}:${second}`).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export function verifyConfirmProof(secret: string, requestId: string, proof: string): boolean {
  return safeEqual(confirmProof(secret, requestId), proof);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function signSyncRequest(secret: string, deviceId: string, since: string, timestamp: string): string {
  return hmac(secret, `${deviceId}|${since}|${timestamp}`);
}

export function verifySyncRequest(
  secret: string,
  deviceId: string,
  since: string,
  timestamp: string,
  signature: string,
): boolean {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIGNATURE_WINDOW_MS) return false;
  return safeEqual(signSyncRequest(secret, deviceId, since, timestamp), signature);
}

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

/** AES-256-GCM encrypt a sync response with the peer's derived secret, so payload contents aren't plaintext on the LAN. */
export function encryptSyncPayload(secretHex: string, payload: SyncPayload): { encrypted: string } {
  const key = Buffer.from(secretHex, "hex");
  return { encrypted: encryptWithKey(key, JSON.stringify(payload)).toString("base64") };
}

export function decryptSyncPayload(secretHex: string, encryptedBase64: string): SyncPayload {
  const key = Buffer.from(secretHex, "hex");
  return JSON.parse(decryptWithKey(key, Buffer.from(encryptedBase64, "base64"))) as SyncPayload;
}

/** What a peer is allowed to hand us over the wire — reject anything else before it touches the store. */
function isPlausibleTodo(t: unknown): t is Todo {
  if (typeof t !== "object" || t === null) return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o.uuid === "string" &&
    typeof o.title === "string" &&
    typeof o.done === "boolean" &&
    (o.list === "todo" || o.list === "backlog") &&
    typeof o.createdAt === "string" &&
    typeof o.updatedAt === "string" &&
    Array.isArray(o.history)
  );
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// Same safe-charset shape as every action string this codebase produces. The web UI renders
// history actions without HTML-escaping them, so anything outside this never enters the store.
const HISTORY_ACTION_RE = /^[a-z][a-z-]{0,31}$/;

function nullableString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function sanitizeHistory(entries: unknown[]): Todo["history"] {
  const out: Todo["history"] = [];
  for (const e of entries.slice(0, MAX_HISTORY_ENTRIES)) {
    if (typeof e !== "object" || e === null) continue;
    const h = e as Record<string, unknown>;
    if (typeof h.at !== "string" || !ISO_TIMESTAMP_RE.test(h.at) || typeof h.detail !== "string") continue;
    if (typeof h.action !== "string" || !HISTORY_ACTION_RE.test(h.action)) continue;
    out.push({
      at: h.at,
      agent: nullableString(h.agent),
      deviceName: nullableString(h.deviceName),
      action: h.action as Todo["history"][number]["action"],
      detail: h.detail,
    });
  }
  return out;
}

function sanitizeFieldTimestamps(v: unknown): Todo["fieldTimestamps"] {
  if (typeof v !== "object" || v === null) return {};
  const out: Todo["fieldTimestamps"] = {};
  for (const key of FIELD_KEYS) {
    const val = (v as Record<string, unknown>)[key];
    if (typeof val === "string") out[key] = val;
  }
  return out;
}

/**
 * isPlausibleTodo only guarantees the core identity fields. Everything else a peer sends
 * is clamped here field-by-field, because a buggy (or compromised) peer could otherwise
 * smuggle values the rest of the codebase never produces: wrong types that crash history
 * rendering, bogus enum values, an unsafe `javascript:` sourceUrl, or markup in fields the
 * web UI renders without escaping (dueDate, priority, history at/action). Also strips any
 * unknown extra keys so they can't silently persist and re-sync forever.
 */
function sanitizeRemoteTodo(t: Todo): Todo {
  const o = t as unknown as Record<string, unknown>;
  return {
    id: 0, // replaced with a fresh local id on insert; never merged onto an existing item
    uuid: t.uuid,
    title: t.title,
    description: nullableString(o.description),
    done: t.done,
    list: t.list,
    category: nullableString(o.category),
    priority: o.priority === "low" || o.priority === "medium" || o.priority === "high" ? o.priority : null,
    dueDate: typeof o.dueDate === "string" && DATE_ONLY_RE.test(o.dueDate) ? o.dueDate : null,
    sourceUrl: typeof o.sourceUrl === "string" && isSafeUrl(o.sourceUrl) ? o.sourceUrl : null,
    agent: nullableString(o.agent),
    session: nullableString(o.session),
    workspace: nullableString(o.workspace),
    workingAgent: nullableString(o.workingAgent),
    workingSince: nullableString(o.workingSince),
    workingSession: nullableString(o.workingSession),
    workingLeaseExpiresAt: nullableString(o.workingLeaseExpiresAt),
    workingDeviceId: nullableString(o.workingDeviceId),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    revision: typeof o.revision === "number" && Number.isInteger(o.revision) && o.revision > 0 ? o.revision : 1,
    fieldTimestamps: sanitizeFieldTimestamps(o.fieldTimestamps),
    completedAt: nullableString(o.completedAt),
    deviceId: nullableString(o.deviceId),
    deviceName: nullableString(o.deviceName),
    history: sanitizeHistory(t.history),
    // Deliberately NOT copied from the wire: a peer's sequence numbers are meaningless in
    // this store, and adopting one would put the record at an arbitrary point in our own
    // delivery order. mergeSyncPayload stamps it from our counter on the way in.
    localSeq: 0,
  };
}

/** Tombstones get the same treatment: only the exact expected shape enters the store. */
function sanitizeTombstone(t: unknown): Tombstone | null {
  if (typeof t !== "object" || t === null) return null;
  const o = t as Record<string, unknown>;
  if (typeof o.uuid !== "string" || typeof o.deletedAt !== "string") return null;
  return { uuid: o.uuid, deletedAt: o.deletedAt, deviceId: nullableString(o.deviceId), localSeq: 0 }; // localSeq re-stamped locally, same as todos
}

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

const EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * How many pages one sync tick will chase before yielding. A first sync of a very large
 * store finishes over several ticks rather than holding the write lock for the whole
 * transfer — the cursor is durable between ticks, so stopping early costs a delay, never
 * a gap.
 */
export const MAX_PAGES_PER_TICK = 20;

/** Recorded on the peer alongside a SUCCESSFUL sync — the pull worked, it is just degraded. */
export const V1_PEER_WARNING =
  "peer is on sync protocol v1 — updates from a third device may not reach this one; update that peer";

/** The peer says it no longer knows this device (unpaired on their side). Not transient: the caller cleans up locally instead of retrying forever. */
class PeerUnpairedError extends Error {}
/** The peer would not accept a request signed over a numeric cursor — it predates protocol v2. */
class PeerPredatesSeqCursorError extends Error {}

/**
 * One GET /api/sync round trip, decrypted.
 *
 * `cursor.value` goes into the `since` slot of the signature whichever parameter carries
 * it, so the signed material stays exactly `deviceId|since|timestamp` — three fields, as
 * v1 peers expect. Adding a fourth would make every not-yet-updated peer reject us for the
 * whole release.
 *
 * NOTE ON THE SPEC: rev 2 says a v1 peer is detected by "response has no maxSeq". It can't
 * be. A v1 server reads only `since` (absent here), so it verifies the signature over ""
 * while we signed the number — it answers 403, not a 200 without `maxSeq`. Detection is
 * therefore: an unexplained 403 on the seq path, or a 200 lacking `maxSeq` (a peer that
 * accepted the request but doesn't page). Both are treated identically below.
 */
async function fetchSyncPage(
  peer: Peer,
  deviceId: string,
  cursor: { param: "sinceSeq" | "since"; value: string },
): Promise<SyncPayload> {
  const timestamp = new Date().toISOString();
  const signature = signSyncRequest(peer.secret, deviceId, cursor.value, timestamp);
  // protocolVersion rides outside the signed portion (deviceId|since|timestamp) — it's
  // informational, not security-sensitive, and adding it here can't break peers signed
  // before this field existed.
  const url =
    `${peer.url.replace(/\/$/, "")}/api/sync?${cursor.param}=${encodeURIComponent(cursor.value)}` +
    `&deviceId=${encodeURIComponent(deviceId)}&timestamp=${encodeURIComponent(timestamp)}` +
    `&signature=${signature}&protocolVersion=${SYNC_PROTOCOL_VERSION}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { reason?: string; minVersion?: number };
    if (body.reason === "unpaired") throw new PeerUnpairedError("peer no longer knows this device");
    // Revoked is also a 403, and must not be mistaken for a v1 peer below — that would
    // cost a pointless second round trip and then report "peer responded 403" instead of
    // the reason the user can actually act on.
    if (body.reason === "revoked") throw new Error("this peer has revoked this device — re-pair from that device to resume syncing");
    if (body.reason === "protocol-incompatible") {
      throw new Error(
        `this peer requires sync protocol v${body.minVersion}+ — this device is running an older docket; update it (npm install -g docket@latest) to resume syncing`,
      );
    }
    // A 403 the peer gave no reason for, on the seq path, is overwhelmingly a v1 peer
    // refusing a signature over a cursor parameter it has never heard of.
    if (res.status === 403 && cursor.param === "sinceSeq") throw new PeerPredatesSeqCursorError();
    throw new Error(`peer responded ${res.status}`);
  }
  const body = (await res.json()) as { encrypted: string };
  return decryptSyncPayload(peer.secret, body.encrypted);
}

/** Returns true if the peer told us plainly that it no longer knows this device (unpaired on its side) — the caller should stop retrying and clean up locally, rather than treating it as a transient failure. */
export async function pullFromPeer(
  peer: Peer,
  deviceId: string,
  withStore: <T>(fn: (store: TodoStore) => T | Promise<T>) => Promise<T>,
): Promise<boolean> {
  if (peer.revoked) return false; // revoked locally — don't even attempt, see peers.ts revokePeer
  try {
    // A peer already known to speak v2 skips the probe entirely; only peers that have
    // never answered, or last answered v1, pay for the fallback round trip — which is
    // exactly the set we want to keep nagging about.
    const mayBeV1 = (peer.protocolVersion ?? 1) < 2;
    let cursor = peer.lastSeq ?? 0;
    let legacyCursor = peer.lastSyncAt ?? EPOCH;
    let degraded: string | undefined;
    let payload: SyncPayload | undefined;
    let pages = 0;

    for (; pages < MAX_PAGES_PER_TICK; pages++) {
      try {
        payload = await fetchSyncPage(peer, deviceId, { param: "sinceSeq", value: String(cursor) });
        if (payload.maxSeq === undefined) throw new PeerPredatesSeqCursorError();
      } catch (err) {
        if (!(err instanceof PeerPredatesSeqCursorError) || !mayBeV1) throw err;
        // Degraded, not broken: the timestamp cursor still delivers this peer's OWN edits.
        // What it cannot deliver is anything this peer merged in from a third device, which
        // is the bug v8 exists to fix — so say so on the peer record rather than syncing
        // quietly and letting the user discover the gap themselves.
        degraded = V1_PEER_WARNING;
        payload = await fetchSyncPage(peer, deviceId, { param: "since", value: legacyCursor });
      }

      // The peer's store is a different incarnation from the one this cursor counts in —
      // it restored a backup, so its counter went backwards and every number we remember
      // now points past records we have never seen. Start over; the peer re-sends
      // everything once, which is the correct outcome for a bulk replacement.
      if (payload.epoch && peer.epoch && payload.epoch !== peer.epoch && cursor !== 0) {
        log(`sync: peer ${peer.name} (${peer.id}) reports a new store epoch — its cursor is void, re-syncing from scratch`);
        cursor = 0;
        continue;
      }

      if (!isSyncProtocolCompatible(payload.protocolVersion)) {
        const msg = `peer's sync protocol v${payload.protocolVersion} is older than this device supports (min v${MIN_COMPATIBLE_SYNC_PROTOCOL_VERSION}) — update the peer to resume syncing`;
        log(`sync: pull from peer ${peer.name} (${peer.id}) skipped — ${msg}`);
        await markPeerSynced(peer.id, false, { error: msg, protocolVersion: payload.protocolVersion });
        return false;
      }

      const merged = await withStore((store) => mergeSyncPayload(store, payload!, peer.id));
      // THE rule this stage exists for: the cursor advances only to what was actually
      // merged — never to "wherever the peer is now".
      cursor = payload.maxSeq ?? cursor;
      // A v1 peer does not page: it answers with everything since the timestamp it was
      // given. So the cursor may advance to its `serverTime` exactly when nothing was
      // clamped, and must not move at all when something was — otherwise the next request
      // starts past records that never landed. Staying in the PEER's clock is the point:
      // a merged record can have been authored by a third device, and its `updatedAt` says
      // nothing about where this peer's own timeline has reached.
      if (degraded && !merged.truncated) legacyCursor = payload.serverTime;
      if (!payload.hasMore) break;
    }

    // On the v2 path lastSyncAt is display only ("synced 4m ago") and uses the PEER's own
    // clock, so the label isn't skewed by a clock disagreement between the machines. On the
    // v1 fallback it is still a real cursor, and there it must be the merged-through value
    // computed above — never the peer's "now".
    const clockSkewMs = payload ? Date.parse(payload.serverTime) - Date.now() : undefined;
    await markPeerSynced(peer.id, true, {
      cursor: degraded ? legacyCursor : payload?.serverTime,
      lastSeq: cursor,
      epoch: payload?.epoch,
      protocolVersion: payload?.protocolVersion,
      clockSkewMs,
      error: degraded,
    });
    if (pages === MAX_PAGES_PER_TICK) {
      // Not an error and not a partial write: everything merged is merged and the cursor
      // reflects exactly that. The cap only bounds how long one tick can hold the store
      // lock; the next tick picks up from here.
      log(`sync: peer ${peer.id} still has more after ${pages} pages — continuing next tick`);
    }
  } catch (err) {
    if (err instanceof PeerUnpairedError) {
      log(`sync: peer ${peer.name} (${peer.id}) says it no longer knows this device — was unpaired on their side`);
      return true;
    }
    log(`sync: pull from peer ${peer.name} (${peer.id}) failed: ${(err as Error).message}`);
    await markPeerSynced(peer.id, false, { error: (err as Error).message });
  }
  return false;
}

/** Returns the ids of peers that reported this device was unpaired on their side, so the caller can remove them locally. */
export async function syncAllPeers(
  deviceId: string,
  withStore: <T>(fn: (store: TodoStore) => T | Promise<T>) => Promise<T>,
): Promise<string[]> {
  const peers = await loadPeers();
  const results = await Promise.allSettled(peers.map((peer) => pullFromPeer(peer, deviceId, withStore)));
  return peers.filter((_peer, i) => results[i].status === "fulfilled" && (results[i] as PromiseFulfilledResult<boolean>).value).map((p) => p.id);
}
