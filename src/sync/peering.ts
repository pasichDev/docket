import { createHmac } from "node:crypto";
import { generateShortCode } from "../short-code.js";
import { hmac, safeEqual } from "./auth.js";

/**
 * Device-to-device pairing: two machines the same person owns, meeting as equals on a LAN.
 *
 * Deliberately NOT the same thing as remote/enrolment.ts, which attaches a device to a
 * central server — that is a client-to-authority handshake with a different trust model.
 * The two share a code alphabet (../short-code.ts) and nothing else.
 *
 * All state here is ephemeral and in-memory. Pairing does not need to survive a restart,
 * and keeping it off disk shrinks what a stolen backup or disk image could expose.
 */

const INVITE_TTL_MS = 5 * 60_000; // one-time pairing token, 5 minutes
const OUTGOING_TTL_MS = 5 * 60_000; // give up waiting for approval after 5 minutes
const INCOMING_TTL_MS = 5 * 60_000; // an incoming request nobody approved/denied in time disappears, rather than sitting forever for a stale click later
const PAIR_RATE_LIMIT = 8; // pairing-request attempts...
const PAIR_RATE_WINDOW_MS = 5 * 60_000; // ...per source IP, per this window

interface PendingInvite {
  expiresAt: number;
}

interface PendingIncoming {
  deviceId: string;
  deviceName: string;
  callbackUrl: string;
  /** The requester's X25519 public key — we derive the shared secret from this + our own private key; it is never transmitted. */
  peerPublicKeyX: string;
  receivedAt: number;
  /** Short Authentication String — shown to the human alongside Approve/Deny so they can
   * compare it against what the OTHER device shows before confirming. See pairingSas(). */
  sas: string;
}

interface PendingOutgoing {
  peerUrl: string;
  status: "pending" | "confirmed" | "denied";
  peerDeviceId?: string;
  peerDeviceName?: string;
  createdAt: number;
  /** The host's public key, if it was carried in the invite (QR/full-line paste) rather than
   * just the bare 6-char code — lets this device anchor trust in the host's identity via the
   * SAME out-of-band channel as the code, before any network round-trip. */
  expectedPublicKeyX?: string;
  /** Computed the moment this device redeems, from its own locally-derived secret — shown to
   * the human so they can compare it against the host's screen. Present only when
   * expectedPublicKeyX was available. */
  sas?: string;
}

// Ephemeral, in-memory only — pairing state does not need to survive a restart,
// and keeping it off disk shrinks what a compromised backup/disk could expose.
const pendingInvites = new Map<string, PendingInvite>();
const pendingIncoming = new Map<string, PendingIncoming>();
const pendingOutgoing = new Map<string, PendingOutgoing>();
const pairAttempts = new Map<string, { count: number; windowStart: number }>();

function reapExpired(): void {
  const now = Date.now();
  for (const [token, invite] of pendingInvites) if (invite.expiresAt < now) pendingInvites.delete(token);
  for (const [id, req] of pendingOutgoing) if (now - req.createdAt > OUTGOING_TTL_MS) pendingOutgoing.delete(id);
  for (const [id, req] of pendingIncoming) if (now - req.receivedAt > INCOMING_TTL_MS) pendingIncoming.delete(id);
  for (const [ip, entry] of pairAttempts) if (now - entry.windowStart > PAIR_RATE_WINDOW_MS) pairAttempts.delete(ip);
}

/** Caps pairing attempts per source IP so the one-time invite token can't be brute-forced. */
export function checkPairingRateLimit(sourceIp: string): boolean {
  reapExpired();
  const now = Date.now();
  const entry = pairAttempts.get(sourceIp);
  if (!entry || now - entry.windowStart > PAIR_RATE_WINDOW_MS) {
    pairAttempts.set(sourceIp, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= PAIR_RATE_LIMIT;
}

export function createInvite(): { token: string; expiresAt: number } {
  reapExpired();
  let token: string;
  do {
    token = generateShortCode();
  } while (pendingInvites.has(token)); // astronomically unlikely, but never silently collide two invites
  const expiresAt = Date.now() + INVITE_TTL_MS;
  pendingInvites.set(token, { expiresAt });
  return { token, expiresAt };
}

/** One-time: the token is consumed whether or not the caller goes on to approve. */
export function redeemInvite(token: string): boolean {
  reapExpired();
  const normalized = token.trim().toUpperCase();
  const invite = pendingInvites.get(normalized);
  if (!invite) return false;
  pendingInvites.delete(normalized);
  return invite.expiresAt >= Date.now();
}

export function addIncomingRequest(requestId: string, req: PendingIncoming): void {
  reapExpired();
  pendingIncoming.set(requestId, req);
}

export function getIncomingRequest(requestId: string): PendingIncoming | undefined {
  reapExpired();
  return pendingIncoming.get(requestId);
}

export function removeIncomingRequest(requestId: string): void {
  pendingIncoming.delete(requestId);
}

export function listIncomingRequests(): Array<{ requestId: string } & Omit<PendingIncoming, "peerPublicKeyX">> {
  reapExpired();
  return [...pendingIncoming.entries()].map(([requestId, req]) => {
    const { peerPublicKeyX: _peerPublicKeyX, ...safe } = req;
    return { requestId, ...safe };
  });
}

export function addOutgoingRequest(requestId: string, req: Omit<PendingOutgoing, "createdAt">): void {
  pendingOutgoing.set(requestId, { ...req, createdAt: Date.now() });
}

export function getOutgoingRequest(requestId: string): PendingOutgoing | undefined {
  reapExpired();
  return pendingOutgoing.get(requestId);
}

export function resolveOutgoingRequest(
  requestId: string,
  outcome: { status: "confirmed"; peerDeviceId: string; peerDeviceName: string } | { status: "denied" },
): boolean {
  const req = pendingOutgoing.get(requestId);
  if (!req) return false;
  req.status = outcome.status;
  if (outcome.status === "confirmed") {
    req.peerDeviceId = outcome.peerDeviceId;
    req.peerDeviceName = outcome.peerDeviceName;
  }
  return true;
}

/** Proves the confirm callback actually derived the same ECDH secret we did, not just that it knows the request id. */
export function confirmProof(secret: string, requestId: string): string {
  return hmac(secret, `confirm:${requestId}`);
}

/**
 * Short Authentication String — a human-comparable code binding the derived secret to
 * BOTH devices' public keys (transcript binding). If an active attacker on the LAN
 * substituted either public key in transit, the two sides end up deriving different
 * secrets and this code differs — comparing it on both screens catches that before a
 * human clicks Approve. Order-independent so either side can compute it the same way
 * without agreeing in advance who's "A" and who's "B".
 */
export function pairingSas(secretHex: string, publicKeyA: string, publicKeyB: string): string {
  const [first, second] = [publicKeyA, publicKeyB].sort();
  const digest = createHmac("sha256", Buffer.from(secretHex, "hex")).update(`sas:${first}:${second}`).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export function verifyConfirmProof(secret: string, requestId: string, proof: string): boolean {
  return safeEqual(confirmProof(secret, requestId), proof);
}
