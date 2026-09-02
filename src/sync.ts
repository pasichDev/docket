import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { decryptWithKey, encryptWithKey } from "./crypto.js";
import { log } from "./log.js";
import { FIELD_KEYS, type FieldKey } from "./mutations.js";
import { loadPeers, markPeerSynced } from "./peers.js";
import type { Peer, Todo, TodoStore, Tombstone } from "./types.js";

const INVITE_TTL_MS = 5 * 60_000; // one-time pairing token, 5 minutes
const OUTGOING_TTL_MS = 5 * 60_000; // give up waiting for approval after 5 minutes
const INCOMING_TTL_MS = 5 * 60_000; // an incoming request nobody approved/denied in time disappears, rather than sitting forever for a stale click later
const SIGNATURE_WINDOW_MS = 2 * 60_000; // reject sync requests with a timestamp off by more than this (replay protection)
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000; // 30 days
const MAX_SYNC_ITEMS = 2000; // guard against a misbehaving/malicious peer sending an unbounded payload
const PAIR_RATE_LIMIT = 8; // pairing-request attempts...
const PAIR_RATE_WINDOW_MS = 5 * 60_000; // ...per source IP, per this window

// No 0/O, 1/I/L — easy to misread across a room or off a low-res screen. 6 chars
// from this 32-symbol set is ~1.07e9 combinations; with a 5-minute single-use TTL
// and PAIR_RATE_LIMIT above, brute-forcing it isn't practical.
const CODE_CHARSET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

function generateShortCode(): string {
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
}

interface PendingOutgoing {
  peerUrl: string;
  status: "pending" | "confirmed" | "denied";
  peerDeviceId?: string;
  peerDeviceName?: string;
  createdAt: number;
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

export interface SyncPayload {
  todos: Todo[];
  deletedUuids: Tombstone[];
  serverTime: string;
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

function fieldTimeOf(t: Todo, field: FieldKey): string {
  // Falls back to createdAt, NOT updatedAt: updatedAt reflects the record's most
  // recent change to ANY field, so using it here would make an untouched field
  // look like it changed whenever a DIFFERENT field on the same record did —
  // exactly the whole-object clobbering per-field merge exists to avoid.
  return t.fieldTimestamps?.[field] ?? t.createdAt;
}

/** Copies whichever fields the remote touched more recently onto `local`, field by field, so two independent edits to DIFFERENT fields both survive instead of one whole-record timestamp clobbering the other. Returns whether anything changed. */
function mergeTodoFields(local: Todo, remote: Todo): boolean {
  let changed = false;
  local.fieldTimestamps = local.fieldTimestamps ?? {};
  for (const field of FIELD_KEYS) {
    const remoteTime = fieldTimeOf(remote, field);
    const localTime = fieldTimeOf(local, field);
    if (remoteTime > localTime) {
      (local as unknown as Record<FieldKey, unknown>)[field] = (remote as unknown as Record<FieldKey, unknown>)[field];
      local.fieldTimestamps[field] = remoteTime;
      changed = true;
    }
  }
  if (remote.updatedAt > local.updatedAt) {
    local.updatedAt = remote.updatedAt;
    local.deviceId = remote.deviceId;
    local.deviceName = remote.deviceName;
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

  const incomingTodos = Array.isArray(payload.todos) ? payload.todos.slice(0, MAX_SYNC_ITEMS).filter(isPlausibleTodo) : [];
  const incomingTombstones = Array.isArray(payload.deletedUuids) ? payload.deletedUuids.slice(0, MAX_SYNC_ITEMS) : [];

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

  const cutoff = new Date(Date.now() - TOMBSTONE_RETENTION_MS).toISOString();
  store.deletedUuids = store.deletedUuids.filter((t) => t.deletedAt > cutoff);

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
  const since = peer.lastSyncAt ?? "1970-01-01T00:00:00.000Z";
  const timestamp = new Date().toISOString();
  const signature = signSyncRequest(peer.secret, deviceId, since, timestamp);
  const url = `${peer.url.replace(/\/$/, "")}/api/sync?since=${encodeURIComponent(since)}&deviceId=${encodeURIComponent(deviceId)}&timestamp=${encodeURIComponent(timestamp)}&signature=${signature}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { reason?: string };
      if (body.reason === "unpaired") {
        log(`sync: peer ${peer.name} (${peer.id}) says it no longer knows this device — was unpaired on their side`);
        return true;
      }
      throw new Error(`peer responded ${res.status}`);
    }
    const body = (await res.json()) as { encrypted: string };
    const payload = decryptSyncPayload(peer.secret, body.encrypted);
    await withStore((store) => {
      mergeSyncPayload(store, payload, peer.id);
    });
    // Use the PEER's own clock (what it just told us "now" is), not ours — otherwise clock
    // skew between the two machines could permanently blind this cursor to real updates.
    await markPeerSynced(peer.id, true, payload.serverTime);
  } catch (err) {
    log(`sync: pull from peer ${peer.name} (${peer.id}) failed: ${(err as Error).message}`);
    await markPeerSynced(peer.id, false);
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
