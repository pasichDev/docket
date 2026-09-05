import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../http.js";
import { deriveSharedSecret, getDevicePublicKey, setDeviceRole } from "../../device.js";
import { log } from "../../log.js";
import { recordCreated, recordResolved } from "../../notifications.js";
import { addPeer } from "../../peers.js";
import { addIncomingRequest, addOutgoingRequest, checkPairingRateLimit, confirmProof, createInvite, getIncomingRequest, getOutgoingRequest, listIncomingRequests, pairingSas, redeemInvite, removeIncomingRequest, resolveOutgoingRequest, verifyConfirmProof } from "../../sync/peering.js";
import { json, readJsonBody } from "../http.js";

/**
 * Becoming paired with another device this person owns — the peer-to-peer handshake, both
 * sides of it.
 *
 * The largest group by far, and the least often touched, which is exactly why it was the worst
 * thing to leave buried in the middle of a 792-line function. See sync/peering.ts for the state
 * machine these routes drive, and remote/enrolment.ts for the DIFFERENT handshake that attaches
 * a device to a server.
 */

function isPrivateNetworkUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname;
  const octets = host.split(".");
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return false;
  const [a, b] = octets.map(Number);
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

async function postPairConfirm(callbackUrl: string, requestId: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${callbackUrl.replace(/\/$/, "")}/api/pair/confirm/${requestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`confirm callback rejected: ${res.status}`);
}

export async function handlePairingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<boolean> {
  // 14. Pair - Create Invite
  if (req.method === "POST" && url.pathname === "/api/pair/invite") {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    if (ctx.deviceRole !== "host") {
      json(res, 403, { error: "this device joined another device's group as a guest — only that host can invite further devices" });
      return true;
    }
    if (!ctx.lanUrl) {
      json(res, 400, { error: "No LAN IP found — can't be paired from another device without one." });
      return true;
    }
    const { token, expiresAt } = createInvite();
    // publicKeyX travels in the invite itself (QR / full-line paste) — the ONE channel an
    // active LAN attacker can't tamper with — so the redeeming device can anchor trust in
    // this device's real identity before ever making a network call. See pairingSas().
    json(res, 200, {
      token,
      expiresAt,
      deviceId: ctx.deviceId,
      deviceName: ctx.deviceName,
      url: ctx.lanUrl,
      publicKeyX: await getDevicePublicKey(),
    });
    return true;
  }

  // 15. Pair - Remote Request
  if (req.method === "POST" && url.pathname === "/api/pair/request") {
    if (ctx.deviceRole !== "host") {
      json(res, 403, { error: "this device is a guest and can't accept pairing requests" });
      return true;
    }
    const sourceIp = req.socket.remoteAddress ?? "unknown";
    if (!checkPairingRateLimit(sourceIp)) {
      json(res, 429, { error: "too many pairing attempts from this address — try again later" });
      return true;
    }
    const body = (await readJsonBody(req)) as {
      token?: unknown;
      deviceId?: unknown;
      deviceName?: unknown;
      callbackUrl?: unknown;
      publicKeyX?: unknown;
    };
    if (
      typeof body.token !== "string" ||
      typeof body.deviceId !== "string" ||
      typeof body.deviceName !== "string" ||
      typeof body.callbackUrl !== "string" ||
      typeof body.publicKeyX !== "string"
    ) {
      json(res, 400, { error: "malformed pairing request" });
      return true;
    }
    if (!isPrivateNetworkUrl(body.callbackUrl)) {
      json(res, 400, { error: "callbackUrl must be a private-network address" });
      return true;
    }
    if (body.deviceId === ctx.deviceId) {
      json(res, 400, { error: "can't pair a device with itself" });
      return true;
    }
    if (!redeemInvite(body.token)) {
      json(res, 400, { error: "invite token is invalid, expired, or already used" });
      return true;
    }
    const requestId = randomUUID();
    const secret = await deriveSharedSecret(body.publicKeyX);
    addIncomingRequest(requestId, {
      deviceId: body.deviceId,
      deviceName: body.deviceName.slice(0, 80),
      callbackUrl: body.callbackUrl,
      peerPublicKeyX: body.publicKeyX,
      receivedAt: Date.now(),
      sas: pairingSas(secret, await getDevicePublicKey(), body.publicKeyX),
    });
    recordCreated(requestId, "pairing", body.deviceName.slice(0, 80));
    log(`pairing: incoming request ${requestId} from ${body.deviceName} — awaiting approval`);
    json(res, 200, { requestId });
    return true;
  }

  // 16. Pair - List Incoming
  if (req.method === "GET" && url.pathname === "/api/pair/incoming") {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    json(res, 200, { requests: listIncomingRequests() });
    return true;
  }

  // 17. Pair - Approve Incoming
  const approveMatch = url.pathname.match(/^\/api\/pair\/approve\/([\w-]+)$/);
  if (req.method === "POST" && approveMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    if (ctx.deviceRole !== "host") {
      json(res, 403, { error: "only the host device can approve pairing requests" });
      return true;
    }
    const requestId = approveMatch[1];
    const pending = getIncomingRequest(requestId);
    if (!pending) {
      json(res, 404, { error: "no such pending request (it may have expired)" });
      return true;
    }
    const secret = await deriveSharedSecret(pending.peerPublicKeyX);
    try {
      await postPairConfirm(pending.callbackUrl, requestId, { proof: confirmProof(secret, requestId) });
    } catch (err) {
      log(`pairing: confirm callback to ${pending.deviceName} failed, not pairing: ${(err as Error).message}`);
      json(res, 502, { error: "couldn't reach the other device to confirm pairing — try again" });
      return true;
    }
    await addPeer({
      id: pending.deviceId,
      name: pending.deviceName,
      url: pending.callbackUrl,
      secret,
      pairedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastSyncOk: true,
      publicKeyX: pending.peerPublicKeyX,
    });
    removeIncomingRequest(requestId);
    recordResolved(requestId, "approved");
    log(`pairing: approved ${pending.deviceName} (${pending.deviceId})`);
    json(res, 200, { paired: true });
    return true;
  }

  // 18. Pair - Deny Incoming
  const denyMatch = url.pathname.match(/^\/api\/pair\/deny\/([\w-]+)$/);
  if (req.method === "POST" && denyMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    if (ctx.deviceRole !== "host") {
      json(res, 403, { error: "only the host device can respond to pairing requests" });
      return true;
    }
    const requestId = denyMatch[1];
    const pending = getIncomingRequest(requestId);
    if (!pending) {
      json(res, 404, { error: "no such pending request" });
      return true;
    }
    removeIncomingRequest(requestId);
    recordResolved(requestId, "denied");
    log(`pairing: denied ${pending.deviceName} (${pending.deviceId})`);
    try {
      const secret = await deriveSharedSecret(pending.peerPublicKeyX);
      await postPairConfirm(pending.callbackUrl, requestId, { denied: true, proof: confirmProof(secret, requestId) });
    } catch {}
    json(res, 200, { denied: true });
    return true;
  }

  // 19. Pair - Redeem Local
  if (req.method === "POST" && url.pathname === "/api/pair/redeem") {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const body = (await readJsonBody(req)) as { peerUrl?: unknown; token?: unknown; publicKeyX?: unknown };
    if (typeof body.peerUrl !== "string" || typeof body.token !== "string" || !body.peerUrl || !body.token) {
      json(res, 400, { error: "peerUrl and token are required" });
      return true;
    }
    if (!ctx.lanUrl) {
      json(res, 400, { error: "No LAN IP on this machine — can't receive the pairing callback." });
      return true;
    }
    // If the invite carried the host's public key (QR / full-line paste, not just the bare
    // 6-char code), anchor trust in it via the out-of-band channel — derive the secret and
    // an SAS to show the human RIGHT NOW, before any network round-trip can be tampered with.
    const expectedPublicKeyX = typeof body.publicKeyX === "string" ? body.publicKeyX : undefined;
    let sas: string | undefined;
    if (expectedPublicKeyX) {
      const secret = await deriveSharedSecret(expectedPublicKeyX);
      sas = pairingSas(secret, expectedPublicKeyX, await getDevicePublicKey());
    }
    try {
      const upstream = await fetch(`${body.peerUrl.replace(/\/$/, "")}/api/pair/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: body.token,
          deviceId: ctx.deviceId,
          deviceName: ctx.deviceName,
          callbackUrl: ctx.lanUrl,
          publicKeyX: await getDevicePublicKey(),
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!upstream.ok) {
        const errBody = (await upstream.json().catch(() => ({}))) as { error?: string };
        json(res, 400, { error: errBody.error ?? `peer responded ${upstream.status}` });
        return true;
      }
      const { requestId } = (await upstream.json()) as { requestId: string };
      addOutgoingRequest(requestId, { peerUrl: body.peerUrl, status: "pending", expectedPublicKeyX, sas });
      json(res, 200, { requestId, sas });
    } catch (err) {
      json(res, 502, { error: `couldn't reach that device: ${(err as Error).message}` });
    }
    return true;
  }

  // 20. Pair - Outgoing Status
  const outgoingStatusMatch = url.pathname.match(/^\/api\/pair\/outgoing\/([\w-]+)$/);
  if (req.method === "GET" && outgoingStatusMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const pendingOut = getOutgoingRequest(outgoingStatusMatch[1]);
    if (!pendingOut) {
      json(res, 404, { error: "unknown or expired pairing request" });
      return true;
    }
    json(res, 200, { status: pendingOut.status, deviceName: pendingOut.peerDeviceName, sas: pendingOut.sas });
    return true;
  }

  // 21. Pair - Confirm Callback
  const confirmMatch = url.pathname.match(/^\/api\/pair\/confirm\/([\w-]+)$/);
  if (req.method === "POST" && confirmMatch) {
    const requestId = confirmMatch[1];
    const pending = getOutgoingRequest(requestId);
    if (!pending) {
      json(res, 404, { error: "unknown or expired pairing request" });
      return true;
    }
    const body = (await readJsonBody(req)) as { denied?: unknown; proof?: unknown };
    if (typeof body.proof !== "string") {
      json(res, 400, { error: "malformed confirmation" });
      return true;
    }

    let peerInfo: { id: string; name: string; publicKeyX: string };
    try {
      const infoRes = await fetch(`${pending.peerUrl.replace(/\/$/, "")}/api/device`, { signal: AbortSignal.timeout(5000) });
      if (!infoRes.ok) throw new Error(`status ${infoRes.status}`);
      const raw = (await infoRes.json()) as Partial<typeof peerInfo>;
      if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.publicKeyX !== "string") {
        throw new Error("malformed device info");
      }
      peerInfo = { id: raw.id, name: raw.name, publicKeyX: raw.publicKeyX };
    } catch (err) {
      json(res, 502, { error: `couldn't verify the pairing device's identity: ${(err as Error).message}` });
      return true;
    }

    // If this device redeemed with the host's public key already anchored via the invite
    // itself, an attacker who intercepted the pairing traffic and swapped in a different
    // /api/device response here would be caught by this mismatch, not silently trusted.
    if (pending.expectedPublicKeyX && pending.expectedPublicKeyX !== peerInfo.publicKeyX) {
      json(res, 403, { error: "the confirming device's public key doesn't match the one from the pairing invite" });
      return true;
    }

    const secret = await deriveSharedSecret(peerInfo.publicKeyX);
    if (!verifyConfirmProof(secret, requestId, body.proof)) {
      json(res, 403, { error: "invalid proof" });
      return true;
    }
    if (body.denied) {
      resolveOutgoingRequest(requestId, { status: "denied" });
      json(res, 200, { ok: true });
      return true;
    }
    const peerName = peerInfo.name.slice(0, 80);
    await addPeer({
      id: peerInfo.id,
      name: peerName,
      url: pending.peerUrl,
      secret,
      pairedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastSyncOk: true,
      publicKeyX: peerInfo.publicKeyX,
    });
    resolveOutgoingRequest(requestId, { status: "confirmed", peerDeviceId: peerInfo.id, peerDeviceName: peerName });
    if (ctx.deviceRole !== "guest") {
      ctx.setDeviceRoleState("guest");
      await setDeviceRole("guest");
      log(`pairing: this device is now a guest of ${peerName}'s group (joined via invite)`);
    }
    log(`pairing: confirmed with ${peerName} (${peerInfo.id})`);
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}
