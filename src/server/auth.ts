import type { IncomingMessage } from "node:http";
import { hashBody, verifyDeviceRequest } from "../remote/device-auth.js";
import { DEVICE_AUTH_HEADERS } from "../remote/protocol.js";
import { findDeviceById, type PairedDevice } from "./devices.js";

/**
 * Real per-device request authentication (RFC "Local and Self-Hosted Backend Modes" §14),
 * replacing the placeholder single shared bearer token this file used to hold (see git
 * history / Phase 1's report — that function was explicitly temporary and is gone now
 * that Phase 3's real pairing exists). Every route in routes.ts calls ONLY this function
 * and never inspects a device-auth header itself, same seam discipline the bearer-token
 * version had.
 */

export type DeviceAuthResult = { ok: true; device: PairedDevice } | { ok: false; status: number; error: string };

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const REASON_MESSAGES: Record<string, string> = {
  timestamp_out_of_range: "request timestamp is outside the allowed window — check the client's clock",
  replayed_nonce: "replayed request (this nonce was already used)",
  bad_signature: "invalid signature",
};

/**
 * `path` MUST be exactly what the caller signed — pathname + search, no scheme/host
 * (see remote/protocol.ts's canonicalRequestString). `rawBody` is the exact bytes of the
 * request body the caller hashed, read BEFORE any JSON.parse — routes.ts reads it once
 * and reuses it both here and for its own body parsing, so there's only one place that
 * could disagree with what was actually signed.
 */
export async function checkDeviceAuth(req: IncomingMessage, method: string, path: string, rawBody: string): Promise<DeviceAuthResult> {
  const deviceId = header(req, DEVICE_AUTH_HEADERS.device);
  const timestamp = header(req, DEVICE_AUTH_HEADERS.timestamp);
  const nonce = header(req, DEVICE_AUTH_HEADERS.nonce);
  const signature = header(req, DEVICE_AUTH_HEADERS.signature);
  if (!deviceId || !timestamp || !nonce || !signature) {
    return {
      ok: false,
      status: 401,
      error: `missing device auth headers — every remote request must be signed (RFC §14): ${Object.values(DEVICE_AUTH_HEADERS).join(", ")}`,
    };
  }

  const device = await findDeviceById(deviceId);
  if (!device) {
    return { ok: false, status: 401, error: "unknown device — pair it first with `docket devices pair` on the server" };
  }
  if (device.revoked) {
    return { ok: false, status: 401, error: "this device has been revoked" };
  }

  const bodyHash = hashBody(rawBody);
  const result = verifyDeviceRequest(device.secret, deviceId, method, path, timestamp, nonce, bodyHash, signature);
  if (!result.ok) {
    return { ok: false, status: 401, error: REASON_MESSAGES[result.reason ?? "bad_signature"] };
  }
  return { ok: true, device };
}
