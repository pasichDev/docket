import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../http.js";
import { removePeerAndMaybeRevertRole } from "../peer-admin.js";
import { log } from "../../log.js";
import { isSafeUrl } from "../../mutations.js";
import { loadPeers, peerFingerprint, peerTrustState, restorePeer, revokePeer, updatePeerUrl } from "../../peers.js";
import { signSyncRequest } from "../../sync/auth.js";
import { json, readJsonBody } from "../http.js";
import type { Peer } from "../../types.js";

/**
 * Managing devices this one is already paired with — listing, unpairing, revoking without
 * unpairing, and repairing a peer's address when its LAN IP moves.
 *
 * Distinct from pairing.ts, which is about becoming paired in the first place.
 */

export async function handlePeerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<boolean> {
  // 12. Peers - List
  if (req.method === "GET" && url.pathname === "/api/peers") {
    const peers = await loadPeers();
    json(res, 200, {
      peers: peers.map(({ secret: _secret, publicKeyX, ...safe }) => ({
        ...safe,
        trustState: peerTrustState({ ...safe, publicKeyX } as Peer),
        fingerprint: publicKeyX ? peerFingerprint(publicKeyX) : null,
      })),
    });
    return true;
  }

  // 13. Peers - Delete
  const unpairMatch = url.pathname.match(/^\/api\/peers\/([\w-]+)$/);
  if (req.method === "DELETE" && unpairMatch) {
    // Unpairing is pairing management — approved LAN viewers can view/edit the LIST,
    // but must never be able to detach this device's sync partners (every other
    // pairing-management route already requires the host browser's own session).
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const ok = await removePeerAndMaybeRevertRole(unpairMatch[1], ctx);
    json(res, ok ? 200 : 404, { removed: ok });
    return true;
  }

  // 13b. Peers - Revoke / Restore (blocks/resumes sync without dropping the pairing — see peers.ts)
  const peerRevokeMatch = url.pathname.match(/^\/api\/peers\/([\w-]+)\/revoke$/);
  if (req.method === "POST" && peerRevokeMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const ok = await revokePeer(peerRevokeMatch[1]);
    json(res, ok ? 200 : 404, { revoked: ok });
    return true;
  }
  const peerRestoreMatch = url.pathname.match(/^\/api\/peers\/([\w-]+)\/restore$/);
  if (req.method === "POST" && peerRestoreMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const ok = await restorePeer(peerRestoreMatch[1]);
    json(res, ok ? 200 : 404, { restored: ok });
    return true;
  }

  // 13c. Peers - Update Address (manual recovery when a peer's LAN address changes — see backlog #139)
  const peerAddressMatch = url.pathname.match(/^\/api\/peers\/([\w-]+)\/address$/);
  if (req.method === "POST" && peerAddressMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const peer = (await loadPeers()).find((p) => p.id === peerAddressMatch[1]);
    if (!peer) {
      json(res, 404, { error: "unknown peer" });
      return true;
    }
    const body = (await readJsonBody(req)) as { url?: unknown };
    if (typeof body.url !== "string" || !isSafeUrl(body.url)) {
      json(res, 400, { error: "invalid address" });
      return true;
    }
    const newUrl = body.url.replace(/\/$/, "");
    // Re-verify identity at the NEW address before trusting it — but NOT via /api/device's
    // self-reported id/publicKeyX, which anything can answer unauthenticated (and is all
    // most existing peers have on record anyway, from before publicKeyX was persisted).
    // Instead, prove it cryptographically: sign a sync request with the SECRET already on
    // file for this peer. Only the genuine paired device derived that same secret via ECDH,
    // so only it can produce a response the candidate address's own /api/sync accepts.
    const since = "9999-01-01T00:00:00.000Z"; // far future — verified via signature only, no data ever needs to come back
    const timestamp = new Date().toISOString();
    const signature = signSyncRequest(peer.secret, ctx.deviceId, since, timestamp);
    const proofUrl = `${newUrl}/api/sync?since=${encodeURIComponent(since)}&deviceId=${encodeURIComponent(ctx.deviceId)}&timestamp=${encodeURIComponent(timestamp)}&signature=${signature}`;
    try {
      const proofRes = await fetch(proofUrl, { signal: AbortSignal.timeout(5000) });
      if (!proofRes.ok) throw new Error(`status ${proofRes.status}`);
    } catch (err) {
      json(res, 403, { error: `the device at that address didn't prove it holds this peer's shared secret — refusing to update: ${(err as Error).message}` });
      return true;
    }
    await updatePeerUrl(peer.id, newUrl);
    log(`peers: updated address for ${peer.name} (${peer.id}) to ${newUrl} after re-verifying identity`);
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}
