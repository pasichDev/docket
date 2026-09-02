import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AUTH_TIMESTAMP_WINDOW_MS, canonicalRequestString, sha256Hex } from "./protocol.js";

/**
 * Per-request HMAC signing (RFC "Local and Self-Hosted Backend Modes" §14) — the real
 * scheme that replaces `docket serve`'s placeholder shared bearer token (src/server/auth.ts).
 * Modeled directly on sync.ts's signSyncRequest/verifySyncRequest (same HMAC-over-a-
 * canonical-string shape, same timing-safe comparison, same "reject a stale timestamp"
 * rule) but signs a per-REQUEST canonical string (method+path+timestamp+nonce+bodyHash)
 * instead of sync's per-PULL one (deviceId+since+timestamp), and adds a nonce replay
 * cache — sync.ts's pull requests don't need one because a replayed pull is idempotent
 * (it just re-reads), but a replayed mutating request here would double-apply a write.
 */

export function signDeviceRequest(secret: string, method: string, path: string, timestamp: string, nonce: string, bodyHash: string): string {
  return createHmac("sha256", secret).update(canonicalRequestString(method, path, timestamp, nonce, bodyHash)).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

export function hashBody(rawBody: string): string {
  return sha256Hex(rawBody);
}

export type DeviceAuthFailureReason =
  | "timestamp_out_of_range"
  | "replayed_nonce"
  | "bad_signature";

export interface DeviceAuthCheckResult {
  ok: boolean;
  reason?: DeviceAuthFailureReason;
}

/**
 * One replay cache per running server process — module-level, same lifetime tradeoff as
 * sync.ts's pendingInvites/pendingIncoming maps (RFC pairing state doesn't need to survive
 * a restart; the same is true here since AUTH_TIMESTAMP_WINDOW_MS already bounds how long
 * a genuinely-replayable request would even pass the timestamp check, so a restart can't
 * be exploited to replay something outside that window anyway). Keyed by
 * `deviceId|nonce` so two different devices can coincidentally generate the same random
 * nonce without colliding.
 */
const seenNonces = new Map<string, number>(); // key -> the timestamp (ms) it expires at

function reapExpiredNonces(now: number): void {
  for (const [key, expiresAt] of seenNonces) if (expiresAt < now) seenNonces.delete(key);
}

/** Exposed for tests that need deterministic replay-cache state between runs; production code never calls this. */
export function resetNonceCacheForTests(): void {
  seenNonces.clear();
}

/**
 * Verifies one signed request server-side. `secret` is the caller's OWN per-device
 * secret already looked up by deviceId (see src/server/devices.ts) — this function does
 * not know about the device registry at all, keeping it a pure, easily-unit-tested
 * function of (secret, request fields) exactly like verifySyncRequest.
 */
export function verifyDeviceRequest(
  secret: string,
  deviceId: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyHash: string,
  signature: string,
): DeviceAuthCheckResult {
  const ts = Date.parse(timestamp);
  const now = Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > AUTH_TIMESTAMP_WINDOW_MS) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }

  const expected = signDeviceRequest(secret, method, path, timestamp, nonce, bodyHash);
  if (!constantTimeEqual(expected, signature)) {
    return { ok: false, reason: "bad_signature" };
  }

  // Replay check comes AFTER signature verification: recording an unauthenticated
  // caller's nonce would let an attacker burn a legitimate device's future nonce by
  // guessing it, and rejecting on signature failure alone never touches the cache.
  reapExpiredNonces(now);
  const nonceKey = `${deviceId}|${nonce}`;
  if (seenNonces.has(nonceKey)) {
    return { ok: false, reason: "replayed_nonce" };
  }
  seenNonces.set(nonceKey, now + AUTH_TIMESTAMP_WINDOW_MS);
  return { ok: true };
}
