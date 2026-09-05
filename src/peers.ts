import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dataPath } from "./data-dir.js";
import { decryptFromBuffer, encryptToBuffer } from "./crypto.js";
import { withFileLock } from "./filelock.js";
import type { Peer } from "./types.js";

const PEERS_PATH = await dataPath("peers.json.enc");
const LOCK_PATH = `${PEERS_PATH}.lock`;

/**
 * Paired devices, encrypted at rest like the todo store — each entry holds a
 * shared secret that authenticates sync requests to/from that peer, so this
 * file is exactly as sensitive as the data it protects.
 */
export async function loadPeers(): Promise<Peer[]> {
  try {
    const encrypted = await readFile(PEERS_PATH);
    const json = await decryptFromBuffer(encrypted);
    return JSON.parse(json) as Peer[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function savePeers(peers: Peer[]): Promise<void> {
  const tmpPath = `${PEERS_PATH}.${randomUUID()}.tmp`;
  const encrypted = await encryptToBuffer(JSON.stringify(peers, null, 2));
  await writeFile(tmpPath, encrypted, { mode: 0o600 });
  await rename(tmpPath, PEERS_PATH);
}

/**
 * Locked read-modify-write — several peers can finish syncing around the same
 * moment (syncAllPeers runs them concurrently via Promise.allSettled), and
 * without this two `markPeerSynced` calls landing close together would race:
 * both load(), both mutate their own peer, and whichever save()s last wins,
 * silently discarding the other's update.
 */
async function withPeers<T>(fn: (peers: Peer[]) => T | Promise<T>): Promise<T> {
  return withFileLock(LOCK_PATH, async () => {
    const peers = await loadPeers();
    const result = await fn(peers);
    await savePeers(peers);
    return result;
  });
}

export async function addPeer(peer: Peer): Promise<void> {
  await withPeers((peers) => {
    const existing = peers.findIndex((p) => p.id === peer.id);
    if (existing === -1) peers.push(peer);
    else peers[existing] = peer;
  });
}

export async function removePeer(id: string): Promise<boolean> {
  return withPeers((peers) => {
    const index = peers.findIndex((p) => p.id === id);
    if (index === -1) return false;
    peers.splice(index, 1);
    return true;
  });
}

/** Blocks sync with this peer without losing the pairing (secret, history) — reversible via restorePeer, unlike removePeer. */
export async function revokePeer(id: string): Promise<boolean> {
  return withPeers((peers) => {
    const peer = peers.find((p) => p.id === id);
    if (!peer) return false;
    peer.revoked = true;
    return true;
  });
}

export async function restorePeer(id: string): Promise<boolean> {
  return withPeers((peers) => {
    const peer = peers.find((p) => p.id === id);
    if (!peer) return false;
    peer.revoked = false;
    return true;
  });
}

/**
 * Manual recovery for a peer whose LAN address changed (new DHCP lease, moved networks) —
 * the caller must have already re-verified the new address answers as the SAME peer
 * (matching id and public key) before calling this; see the /api/peers/:id/address handler.
 * There is deliberately no automatic discovery (mDNS et al. — see backlog #138): binding
 * trust to "whatever answers at this IP" instead of a human-confirmed identity check is
 * exactly the class of mistake this manual path avoids.
 */
export async function updatePeerUrl(id: string, url: string): Promise<boolean> {
  return withPeers((peers) => {
    const peer = peers.find((p) => p.id === id);
    if (!peer) return false;
    peer.url = url;
    return true;
  });
}

export type PeerTrustState = "pending" | "verified" | "trusted" | "revoked";

/**
 * Derived, not stored — everything but `revoked` already lives on the peer record, so
 * computing this here (rather than tracking a redundant state machine that could drift
 * out of sync with the fields it would duplicate) can't ever disagree with reality.
 */
export function peerTrustState(peer: Peer): PeerTrustState {
  if (peer.revoked) return "revoked";
  if (!peer.lastSyncAt) return "pending"; // paired, never synced successfully yet
  return peer.lastSyncOk ? "trusted" : "verified"; // has synced before; "verified" = currently failing
}

/** Short, human-comparable fingerprint of a peer's public key — same idea as an SSH key fingerprint. Not a secret; the key itself is public by design. */
export function peerFingerprint(publicKeyX: string): string {
  return createHash("sha256").update(publicKeyX).digest("hex").slice(0, 12).toUpperCase().replace(/(.{4})(?=.)/g, "$1 ");
}

/**
 * `lastSeq` is the delivery cursor: a point in the PEER's own localSeq space, advanced only
 * as far as what was actually merged (see pullFromPeer). `cursor` is the peer's reported
 * clock, kept only so the UI can say "synced 4m ago" — it stopped being a cursor in v8,
 * because a wall-clock cursor is what let a third device's edits vanish.
 *
 * `error` is honoured even when `ok` is true: a sync can genuinely succeed and still be
 * degraded (a peer stuck on sync protocol v1). Recording that as a failure would be a lie;
 * dropping it silently is the exact habit v3.0 exists to break.
 */
export async function markPeerSynced(
  id: string,
  ok: boolean,
  details: { cursor?: string; lastSeq?: number; epoch?: string; error?: string; protocolVersion?: number; clockSkewMs?: number } = {},
): Promise<void> {
  await withPeers((peers) => {
    const peer = peers.find((p) => p.id === id);
    if (!peer) return;
    if (ok && details.cursor) peer.lastSyncAt = details.cursor;
    // Not gated on `ok`, unlike the rest. lastSeq records what actually MERGED, which is a
    // fact about this store and not about whether the tick finished: a pull that merged four
    // pages and then lost the connection has still merged four pages. Discarding that credit
    // made the next tick re-fetch and re-merge them, so a peer that fails late every time
    // would re-do the same work forever and never converge.
    if (details.lastSeq !== undefined) peer.lastSeq = details.lastSeq;
    if (ok && details.epoch !== undefined) peer.epoch = details.epoch;
    peer.lastSyncOk = ok;
    peer.lastError = details.error ?? (ok ? null : "unknown error");
    if (details.protocolVersion !== undefined) peer.protocolVersion = details.protocolVersion;
    if (details.clockSkewMs !== undefined) peer.clockSkewMs = details.clockSkewMs;
  });
}
