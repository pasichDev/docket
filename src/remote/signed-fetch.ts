import { generateNonce, hashBody, signDeviceRequest } from "./device-auth.js";
import { DEVICE_AUTH_HEADERS } from "./protocol.js";

/**
 * A minimal signed GET (RFC "Local and Self-Hosted Backend Modes" §14), for the handful of
 * callers that need a one-off authenticated request without the rest of
 * RemoteTodoRepository's machinery (id mapping, compatibility caching, mutation error
 * types) — `docket status` (does it reach the server, and is this device still
 * authorized?) and `docket backend use/localize` (inspecting remote state before
 * migrating). RemoteTodoRepository is NOT reused here because pulling in its
 * TodoNotFoundError/RemoteUnavailableError translation would be the wrong shape for a
 * plain "what's the raw HTTP status" check.
 */
export interface SignedRequestResult {
  status: number;
  ok: boolean;
  body: unknown;
}

export async function signedGet(serverUrl: string, deviceId: string, secret: string, path: string, timeoutMs = 8000): Promise<SignedRequestResult> {
  const timestamp = new Date().toISOString();
  const nonce = generateNonce();
  const bodyHash = hashBody("");
  const signature = signDeviceRequest(secret, "GET", path, timestamp, nonce, bodyHash);
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}${path}`, {
    method: "GET",
    headers: {
      [DEVICE_AUTH_HEADERS.device]: deviceId,
      [DEVICE_AUTH_HEADERS.timestamp]: timestamp,
      [DEVICE_AUTH_HEADERS.nonce]: nonce,
      [DEVICE_AUTH_HEADERS.signature]: signature,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON response — leave body null, caller only inspects `status`/`ok` in that case.
    }
  }
  return { status: res.status, ok: res.ok, body };
}
