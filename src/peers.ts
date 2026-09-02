import { randomUUID } from "node:crypto";
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

/**
 * `cursor` should be the PEER's own clock (the `serverTime` it reported in the
 * sync response), not ours — using our local clock here would silently miss
 * updates whenever the two machines' clocks disagree (see sync.ts).
 */
export async function markPeerSynced(id: string, ok: boolean, cursor?: string): Promise<void> {
  await withPeers((peers) => {
    const peer = peers.find((p) => p.id === id);
    if (!peer) return;
    if (ok && cursor) peer.lastSyncAt = cursor;
    peer.lastSyncOk = ok;
  });
}
