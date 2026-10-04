import { buildDigestPage, digestCursorAfterPage, mergeDigestPage, type DigestStore, type DigestSyncPage } from "../digests.js";
import { log } from "../log.js";
import { loadPeers, markPeerDigestSynced } from "../peers.js";
import type { Peer } from "../types.js";
import { signSyncRequest, verifySyncRequest } from "./auth.js";
import { decryptEnvelope, encryptEnvelope } from "./payload.js";

/**
 * Digest sync: the same pull-based, cursor-paged gossip as the todo sync, on its own
 * endpoint and its own cursor.
 *
 * Separate rather than folded into GET /api/sync so the todo path — the one with the
 * audited cursor rules, the v1 fallback and the epoch handling — is not touched at all. A
 * peer on a build without digests answers this endpoint 404, which is read as "nothing to
 * pull yet", never as a failure of the todo sync running beside it.
 */

export const DIGEST_SYNC_PATH = "/api/sync/digests";
const MAX_PAGES_PER_TICK = 10;

/**
 * What goes in the signature's `since` slot. Prefixed so a captured todo-sync signature can
 * never be replayed against this endpoint, or the other way round: the bare number would
 * verify on both.
 */
export function digestSignedCursor(seq: number | string): string {
  return `digests:${seq}`;
}

/** Thrown for a peer whose build has no digest endpoint. Expected during a rolling upgrade. */
class PeerWithoutDigestsError extends Error {}

async function fetchDigestPage(peer: Peer, deviceId: string, sinceSeq: number): Promise<Partial<DigestSyncPage>> {
  const timestamp = new Date().toISOString();
  const signature = signSyncRequest(peer.secret, deviceId, digestSignedCursor(sinceSeq), timestamp);
  const url =
    `${peer.url.replace(/\/$/, "")}${DIGEST_SYNC_PATH}?sinceSeq=${sinceSeq}` +
    `&deviceId=${encodeURIComponent(deviceId)}&timestamp=${encodeURIComponent(timestamp)}&signature=${signature}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) throw new PeerWithoutDigestsError();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
    // The same two refusals the todo sync turns into something the user can act on.
    if (body.reason === "unpaired") throw new Error("this peer no longer knows this device — it was unpaired on that side");
    if (body.reason === "revoked") throw new Error("this peer has revoked this device — re-pair from that device to resume syncing");
    throw new Error(`peer responded ${res.status}${body.error ? ` (${body.error})` : ""}`);
  }
  const body = (await res.json()) as { encrypted: string };
  return decryptEnvelope<Partial<DigestSyncPage>>(peer.secret, body.encrypted);
}

export const PEER_WITHOUT_DIGESTS = "this peer's docket predates digests — update it to share them";

export async function pullDigestsFromPeer(
  peer: Peer,
  deviceId: string,
  withDigests: <T>(fn: (store: DigestStore) => T | Promise<T>) => Promise<T>,
): Promise<number> {
  if (peer.revoked) return 0;
  let changed = 0;
  let cursor = peer.digestSeq ?? 0;
  let knownEpoch = peer.digestEpoch;
  let error: string | null = null;
  try {
    for (let pages = 0; pages < MAX_PAGES_PER_TICK; pages++) {
      const page = await fetchDigestPage(peer, deviceId, cursor);
      // The peer restored a backup: its counter went backwards and this cursor now points
      // past records never seen here. Start over once; re-merging is harmless.
      if (page.epoch && knownEpoch && page.epoch !== knownEpoch && cursor !== 0) {
        log(`sync: peer ${peer.name} (${peer.id}) reports a new store epoch — re-syncing its digests from scratch`);
        cursor = 0;
        knownEpoch = page.epoch;
        continue;
      }
      if (page.epoch) knownEpoch = page.epoch;
      const merged = await withDigests((store) => mergeDigestPage(store, page));
      changed += merged.inserted + merged.deleted;
      if (merged.inserted || merged.deleted) log(`sync: digests from peer ${peer.id} — +${merged.inserted} -${merged.deleted}`);
      const advanced = digestCursorAfterPage(page, cursor, merged.rejectedBelow);
      if (merged.rejectedBelow !== null) {
        error = `peer sent a digest at sequence ${merged.rejectedBelow} that failed validation — digest sync is held below it`;
        log(`sync: peer ${peer.name} (${peer.id}) — ${error}`);
      }
      const stalled = advanced === cursor;
      cursor = advanced;
      if (page.hasMore !== true || stalled) break;
    }
  } catch (err) {
    error = err instanceof PeerWithoutDigestsError ? PEER_WITHOUT_DIGESTS : (err as Error).message;
    if (!(err instanceof PeerWithoutDigestsError)) log(`sync: digest pull from peer ${peer.name} (${peer.id}) failed at ${cursor}: ${error}`);
  }
  // Credit for what merged is kept even when the tick failed late, as with the todo cursor.
  // Written only when something changed: this runs every tick for every peer.
  if (cursor !== (peer.digestSeq ?? 0) || knownEpoch !== peer.digestEpoch || error !== (peer.digestError ?? null)) {
    await markPeerDigestSynced(peer.id, { digestSeq: cursor, digestEpoch: knownEpoch, error });
  }
  return changed;
}

export async function syncDigestsWithAllPeers(
  deviceId: string,
  withDigests: <T>(fn: (store: DigestStore) => T | Promise<T>) => Promise<T>,
): Promise<number> {
  const peers = await loadPeers();
  const results = await Promise.allSettled(peers.map((peer) => pullDigestsFromPeer(peer, deviceId, withDigests)));
  return results.reduce((n, r) => n + (r.status === "fulfilled" ? r.value : 0), 0);
}

/** The serving half, for routes/sync.ts: authenticate as the todo route does, then answer with one page. */
export function verifyDigestRequest(peer: Peer, deviceId: string, sinceSeqRaw: string, timestamp: string, signature: string): boolean {
  return verifySyncRequest(peer.secret, deviceId, digestSignedCursor(sinceSeqRaw), timestamp, signature);
}

/**
 * `storeEpoch` is the todo store's incarnation, reset by `docket restore`; the digest file
 * carries its own, minted whenever the file is created afresh. Either changing voids every
 * peer's cursor into this sequence space — a restore puts an older digest file back, and a
 * recreated file restarts its counter at 0, and both would otherwise leave peers asking for
 * numbers above everything that now exists.
 */
export function digestPageEpoch(storeEpoch: string, store: DigestStore): string {
  return `${storeEpoch}:${store.epoch ?? "unminted"}`;
}

export function encryptDigestPage(peer: Peer, store: DigestStore, sinceSeq: number, storeEpoch: string): { encrypted: string } {
  return encryptEnvelope(peer.secret, buildDigestPage(store, sinceSeq, digestPageEpoch(storeEpoch, store)));
}
