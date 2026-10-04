import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../http.js";
import { loadPeers } from "../../peers.js";
import { readDigestStore } from "../../digests.js";
import { getStoreEpoch, readStore } from "../../storage.js";
import { DIGEST_SYNC_PATH, encryptDigestPage, verifyDigestRequest } from "../../sync/digests.js";
import { verifySyncRequest } from "../../sync/auth.js";
import { MIN_COMPATIBLE_SYNC_PROTOCOL_VERSION, buildLegacySyncPayload, buildSyncPayload, encryptSyncPayload, isSyncProtocolCompatible } from "../../sync/payload.js";
import { json } from "../http.js";
import type { Peer } from "../../types.js";

/**
 * The one route a PEER calls. Everything before the payload build is authentication and
 * protocol negotiation; see sync/payload.ts for what the answer contains and why maxSeq is
 * the careful part.
 */

export async function handleSyncRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<boolean> {
  // 30. Peer Sync - Sync Endpoint
  if (req.method === "GET" && url.pathname === "/api/sync") {
    const since = url.searchParams.get("since") ?? "";
    // Protocol v2's cursor. Present → the caller signed THIS value in the `since` slot and
    // wants seq-paged delivery; absent → a v1 caller on the timestamp path, served exactly
    // as before. One endpoint, two cursors, no version negotiation round trip.
    const sinceSeqRaw = url.searchParams.get("sinceSeq");
    const signedCursor = sinceSeqRaw ?? since;
    const callerDeviceId = url.searchParams.get("deviceId") ?? "";
    const timestamp = url.searchParams.get("timestamp") ?? "";
    const signature = url.searchParams.get("signature") ?? "";
    const callerProtocolVersionRaw = url.searchParams.get("protocolVersion");
    const callerProtocolVersion = callerProtocolVersionRaw === null ? null : Number(callerProtocolVersionRaw);
    const peer = await pairedPeerOr403(res, callerDeviceId);
    if (!peer) return true;
    if (!verifySyncRequest(peer.secret, callerDeviceId, signedCursor, timestamp, signature)) {
      json(res, 403, { error: "signature invalid or expired" });
      return true;
    }
    if (!isSyncProtocolCompatible(callerProtocolVersion)) {
      json(res, 409, {
        error: `caller's sync protocol v${callerProtocolVersion} is older than this device supports`,
        reason: "protocol-incompatible",
        minVersion: MIN_COMPATIBLE_SYNC_PROTOCOL_VERSION,
      });
      return true;
    }
    const store = await readStore();
    const sinceSeq = sinceSeqRaw === null ? null : Number(sinceSeqRaw);
    if (sinceSeq !== null && !Number.isSafeInteger(sinceSeq)) {
      json(res, 400, { error: "sinceSeq must be an integer" });
      return true;
    }
    const payload = sinceSeq === null ? buildLegacySyncPayload(store, since) : buildSyncPayload(store, sinceSeq, await getStoreEpoch());
    json(res, 200, encryptSyncPayload(peer.secret, payload));
    return true;
  }

  // Digests, on their own cursor — see sync/digests.ts for why this is not part of /api/sync.
  if (req.method === "GET" && url.pathname === DIGEST_SYNC_PATH) {
    const sinceSeqRaw = url.searchParams.get("sinceSeq") ?? "";
    const callerDeviceId = url.searchParams.get("deviceId") ?? "";
    const timestamp = url.searchParams.get("timestamp") ?? "";
    const signature = url.searchParams.get("signature") ?? "";
    const peer = await pairedPeerOr403(res, callerDeviceId);
    if (!peer) return true;
    if (!verifyDigestRequest(peer, callerDeviceId, sinceSeqRaw, timestamp, signature)) {
      json(res, 403, { error: "signature invalid or expired" });
      return true;
    }
    const sinceSeq = Number(sinceSeqRaw);
    if (!sinceSeqRaw || !Number.isSafeInteger(sinceSeq) || sinceSeq < 0) {
      json(res, 400, { error: "sinceSeq must be a non-negative integer" });
      return true;
    }
    json(res, 200, encryptDigestPage(peer, await readDigestStore(), sinceSeq, await getStoreEpoch()));
    return true;
  }

  return false;
}

/** The two refusals every peer-facing route gives before it looks at a signature. Answers the request itself when it refuses. */
async function pairedPeerOr403(res: ServerResponse, callerDeviceId: string): Promise<Peer | null> {
  const peers = await loadPeers();
  const peer = peers.find((p) => p.id === callerDeviceId);
  if (!peer) {
    json(res, 403, { error: "not a paired device", reason: "unpaired" });
    return null;
  }
  if (peer.revoked) {
    json(res, 403, { error: "this peer has been revoked", reason: "revoked" });
    return null;
  }
  return peer;
}
