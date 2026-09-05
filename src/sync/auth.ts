import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The HMAC layer both pairing flows and every sync request are built on.
 *
 * Split out of the old sync.ts because it is the one piece with no opinion about WHAT is
 * being signed: peering signs a confirm callback, the sync client signs a cursor request,
 * and neither needs to know about the other to do it.
 */

// Reject sync requests whose timestamp is off by more than this — replay protection.
const SIGNATURE_WINDOW_MS = 2 * 60_000; // reject sync requests with a timestamp off by more than this (replay protection)

function hmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time compare. Every signature check in this package goes through it. */
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

export { hmac, safeEqual };
