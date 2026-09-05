import { log } from "../log.js";
import { loadPeers, markPeerSynced } from "../peers.js";
import type { Peer, TodoStore } from "../types.js";
import { signSyncRequest } from "./auth.js";
import { mergeSyncPayload } from "./merge.js";
import {
  cursorAfterPage,
  decryptSyncPayload,
  isSyncProtocolCompatible,
  MIN_COMPATIBLE_SYNC_PROTOCOL_VERSION,
  SYNC_PROTOCOL_VERSION,
  type SyncPayload,
} from "./payload.js";

/**
 * The pulling half: walk each paired peer, page through what it owes us, merge, and move
 * the cursor exactly as far as the pages actually delivered.
 *
 * `withStore` is injected rather than imported so this module has no dependency on the
 * storage layer — which is also what lets the pagination and transitive-sync tests drive a
 * full pull against a store they built in memory.
 */

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
  // Hoisted out of the try so the failure path can still record credit for pages that DID
  // land before the connection went away.
  let mergedThrough = peer.lastSeq ?? 0;
  try {
    // A peer already known to speak v2 skips the probe entirely; only peers that have
    // never answered, or last answered v1, pay for the fallback round trip — which is
    // exactly the set we want to keep nagging about.
    const mayBeV1 = (peer.protocolVersion ?? 1) < 2;
    let cursor = peer.lastSeq ?? 0;
    // The peer's store incarnation as this tick understands it — updated the moment a change
    // is acted on, so one restore causes exactly one cursor reset.
    let knownEpoch = peer.epoch;
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
      if (payload.epoch && knownEpoch && payload.epoch !== knownEpoch && cursor !== 0) {
        log(`sync: peer ${peer.name} (${peer.id}) reports a new store epoch — its cursor is void, re-syncing from scratch`);
        cursor = 0;
        mergedThrough = 0; // the old number counts in a store incarnation that no longer exists
        knownEpoch = payload.epoch;
        // Remember it NOW, not at the end of the tick. peer.epoch is the value that was on
        // disk when this tick started, so leaving it in place made every page after the
        // first one look like a fresh restore: the cursor was reset to 0 again, the same
        // first page re-merged, and the tick ping-ponged 0 -> PAGE_SIZE -> 0 until it ran
        // out of pages. A peer with more than one page of data therefore needed a second
        // tick to finish catching up, having wasted the whole of the first.
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
      // merged — never to "wherever the peer is now", and never past what this page
      // carried. See cursorAfterPage for why the peer's own number cannot be trusted.
      const advanced = degraded ? cursor : cursorAfterPage(payload, cursor);
      const stalled = advanced === cursor;
      cursor = advanced;
      mergedThrough = advanced;
      // A v1 peer does not page: it answers with everything since the timestamp it was
      // given. So the cursor may advance to its `serverTime` exactly when nothing was
      // clamped, and must not move at all when something was — otherwise the next request
      // starts past records that never landed. Staying in the PEER's clock is the point:
      // a merged record can have been authored by a third device, and its `updatedAt` says
      // nothing about where this peer's own timeline has reached.
      if (degraded && !merged.truncated) legacyCursor = payload.serverTime;
      if (payload.hasMore !== true) break;
      // "More to come" plus a cursor that did not move is a peer that will hand back this
      // same page forever. The page cap already bounds the damage; stopping here means the
      // tick ends instead of spending its whole budget re-merging one response.
      if (stalled && !degraded) {
        log(`sync: peer ${peer.name} (${peer.id}) says hasMore but its cursor did not advance past ${cursor} — stopping this tick`);
        break;
      }
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
    log(`sync: pull from peer ${peer.name} (${peer.id}) failed after merging through ${mergedThrough}: ${(err as Error).message}`);
    await markPeerSynced(peer.id, false, { error: (err as Error).message, lastSeq: mergedThrough });
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
