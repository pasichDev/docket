import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { decryptWithKey, encryptWithKey } from "./crypto.js";
import { pushHistory } from "./history.js";
import { log } from "./log.js";
import { FIELD_KEYS, isSafeUrl, type FieldKey } from "./mutations.js";
import { loadPeers, markPeerSynced } from "./peers.js";
import type { Peer, Todo, TodoStore, Tombstone } from "./types.js";

const INVITE_TTL_MS = 5 * 60_000; // one-time pairing token, 5 minutes
const OUTGOING_TTL_MS = 5 * 60_000; // give up waiting for approval after 5 minutes
const INCOMING_TTL_MS = 5 * 60_000; // an incoming request nobody approved/denied in time disappears, rather than sitting forever for a stale click later
const SIGNATURE_WINDOW_MS = 2 * 60_000; // reject sync requests with a timestamp off by more than this (replay protection)
const MAX_SYNC_ITEMS = 2000; // guard against a misbehaving/malicious peer sending an unbounded payload
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
export const SYNC_PROTOCOL_VERSION = 1;
/** The oldest peer protocolVersion this build still knows how to talk to. */
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
  for (const e of entries.slice(0, MAX_SYNC_ITEMS)) {
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
  };
}

/** Tombstones get the same treatment: only the exact expected shape enters the store. */
function sanitizeTombstone(t: unknown): Tombstone | null {
  if (typeof t !== "object" || t === null) return null;
  const o = t as Record<string, unknown>;
  if (typeof o.uuid !== "string" || typeof o.deletedAt !== "string") return null;
  return { uuid: o.uuid, deletedAt: o.deletedAt, deviceId: nullableString(o.deviceId) };
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
    if (remoteTime > localTime || (remoteTime === localTime && remoteWinsTie(remote, local))) {
      const localValue = (local as unknown as Record<FieldKey, unknown>)[field];
      const remoteValue = (remote as unknown as Record<FieldKey, unknown>)[field];
      if (field in local.fieldTimestamps && localValue !== remoteValue) conflictsResolved.push(field);
      (local as unknown as Record<FieldKey, unknown>)[field] = remoteValue;
      local.fieldTimestamps[field] = remoteTime;
      changed = true;
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
): { inserted: number; updated: number; deleted: number } {
  let inserted = 0;
  let updated = 0;
  let deleted = 0;

  store.deletedUuids = store.deletedUuids ?? [];
  const localTombstones = new Map(store.deletedUuids.map((t) => [t.uuid, t]));

  const incomingTodos = Array.isArray(payload.todos)
    ? payload.todos.slice(0, MAX_SYNC_ITEMS).filter(isPlausibleTodo).map(sanitizeRemoteTodo)
    : [];
  const incomingTombstones = Array.isArray(payload.deletedUuids)
    ? payload.deletedUuids
        .slice(0, MAX_SYNC_ITEMS)
        .map(sanitizeTombstone)
        .filter((t): t is Tombstone => t !== null)
    : [];

  for (const remote of incomingTodos) {
    const tombstone = localTombstones.get(remote.uuid);
    if (tombstone && tombstone.deletedAt >= remote.updatedAt) continue; // deleted locally after (or at) the remote edit — stays deleted

    const local = store.todos.find((t) => t.uuid === remote.uuid);
    if (!local) {
      store.todos.push({ ...remote, id: store.nextId });
      store.nextId += 1;
      inserted += 1;
      continue;
    }
    if (mergeTodoFields(local, remote)) updated += 1;
  }

  for (const remoteTomb of incomingTombstones) {
    const local = store.todos.find((t) => t.uuid === remoteTomb.uuid);
    const existingTombstone = localTombstones.get(remoteTomb.uuid);
    if (!existingTombstone) {
      store.deletedUuids.push(remoteTomb);
      localTombstones.set(remoteTomb.uuid, remoteTomb);
    }
    if (local && local.updatedAt <= remoteTomb.deletedAt) {
      store.todos = store.todos.filter((t) => t.uuid !== remoteTomb.uuid);
      deleted += 1;
    }
  }

  // Tombstones are kept indefinitely — NOT purged by age. A device that's been offline
  // longer than any fixed retention window (a laptop unused for a couple of months, say)
  // would otherwise reconnect to find the tombstone for an item it still has already
  // gone, sync its still-alive copy back out, and resurrect a deletion every other peer
  // already agreed on. GC-by-age trades that correctness risk for disk space this app
  // doesn't meaningfully need to reclaim; a future ACK-based GC (only drop a tombstone
  // once every paired peer has confirmed seeing it) would reclaim space safely instead.

  if (inserted || updated || deleted) log(`sync: merged from peer ${peerId} — +${inserted} ~${updated} -${deleted}`);
  return { inserted, updated, deleted };
}

function mergeHistories(a: Todo["history"], b: Todo["history"]): Todo["history"] {
  const seen = new Set<string>();
  const merged = [...a, ...b].filter((h) => {
    const key = `${h.at}|${h.agent}|${h.action}|${h.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  merged.sort((x, y) => x.at.localeCompare(y.at));
  return merged;
}

/** Returns true if the peer told us plainly that it no longer knows this device (unpaired on its side) — the caller should stop retrying and clean up locally, rather than treating it as a transient failure. */
export async function pullFromPeer(
  peer: Peer,
  deviceId: string,
  withStore: <T>(fn: (store: TodoStore) => T | Promise<T>) => Promise<T>,
): Promise<boolean> {
  if (peer.revoked) return false; // revoked locally — don't even attempt, see peers.ts revokePeer
  const since = peer.lastSyncAt ?? "1970-01-01T00:00:00.000Z";
  const timestamp = new Date().toISOString();
  const signature = signSyncRequest(peer.secret, deviceId, since, timestamp);
  // protocolVersion rides outside the signed portion (deviceId|since|timestamp) — it's
  // informational, not security-sensitive, and adding it here can't break peers signed
  // before this field existed.
  const url = `${peer.url.replace(/\/$/, "")}/api/sync?since=${encodeURIComponent(since)}&deviceId=${encodeURIComponent(deviceId)}&timestamp=${encodeURIComponent(timestamp)}&signature=${signature}&protocolVersion=${SYNC_PROTOCOL_VERSION}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { reason?: string; minVersion?: number };
      if (body.reason === "unpaired") {
        log(`sync: peer ${peer.name} (${peer.id}) says it no longer knows this device — was unpaired on their side`);
        return true;
      }
      if (body.reason === "protocol-incompatible") {
        const msg = `this peer requires sync protocol v${body.minVersion}+ — this device is running an older docket; update it (npm install -g docket@latest) to resume syncing`;
        log(`sync: pull from peer ${peer.name} (${peer.id}) rejected — ${msg}`);
        await markPeerSynced(peer.id, false, { error: msg });
        return false;
      }
      throw new Error(`peer responded ${res.status}`);
    }
    const body = (await res.json()) as { encrypted: string };
    const payload = decryptSyncPayload(peer.secret, body.encrypted);
    if (!isSyncProtocolCompatible(payload.protocolVersion)) {
      const msg = `peer's sync protocol v${payload.protocolVersion} is older than this device supports (min v${MIN_COMPATIBLE_SYNC_PROTOCOL_VERSION}) — update the peer to resume syncing`;
      log(`sync: pull from peer ${peer.name} (${peer.id}) skipped — ${msg}`);
      await markPeerSynced(peer.id, false, { error: msg, protocolVersion: payload.protocolVersion });
      return false;
    }
    await withStore((store) => {
      mergeSyncPayload(store, payload, peer.id);
    });
    // Use the PEER's own clock (what it just told us "now" is), not ours — otherwise clock
    // skew between the two machines could permanently blind this cursor to real updates.
    const clockSkewMs = Date.parse(payload.serverTime) - Date.now();
    await markPeerSynced(peer.id, true, { cursor: payload.serverTime, protocolVersion: payload.protocolVersion, clockSkewMs });
  } catch (err) {
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
