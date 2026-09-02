import { createHash } from "node:crypto";

/**
 * Wire-level constants shared by the remote client (src/remote/*) and the server
 * (src/server/*) — RFC "Local and Self-Hosted Backend Modes" §14 (Authentication) and
 * §23 (Health and compatibility negotiation). Living in its own module (rather than
 * inside client.ts or routes.ts) is what lets both sides import it without either
 * depending on the other's process shape.
 */

/** This build's own protocol version — bumped only for a wire-format change an older peer would misread. Currently identical to server/routes.ts's PROTOCOL_VERSION; kept as a separate constant because the two sides version independently in principle. */
export const CLIENT_PROTOCOL_VERSION = 1;
/** The oldest server protocolVersion this client still knows how to talk to. */
export const MIN_COMPATIBLE_SERVER_PROTOCOL = 1;

export const DEVICE_AUTH_HEADERS = {
  device: "x-docket-device",
  timestamp: "x-docket-timestamp",
  nonce: "x-docket-nonce",
  signature: "x-docket-signature",
} as const;

/** Reject a signed request whose timestamp is off by more than this — bounds the replay-nonce cache's lifetime too (RFC §14/§31: "Replay attack: Timestamp + nonce + signature"). */
export const AUTH_TIMESTAMP_WINDOW_MS = 5 * 60_000;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The exact bytes a device signs (and the server re-derives to verify) — RFC §14's
 * "method / path / timestamp / nonce / body hash", newline-joined so no field can bleed
 * into its neighbour (an HTTP method can never contain a newline, but this keeps the
 * format unambiguous regardless). `path` MUST be the request-target exactly as sent
 * (pathname + query string, no scheme/host) so a proxy rewriting the URL other than
 * pass-through would itself break signatures rather than silently being trusted.
 */
export function canonicalRequestString(method: string, path: string, timestamp: string, nonce: string, bodyHash: string): string {
  return [method.toUpperCase(), path, timestamp, nonce, bodyHash].join("\n");
}

/** RFC §19: the local numeric id is never part of the remote protocol — every wire Todo carries the short human-facing id in `id`, plus the canonical `uuid`. */
export type WireId = string;
