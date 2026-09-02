import { randomUUID } from "node:crypto";

/**
 * A browser on the LAN asking "let me view/edit this list" — separate from
 * device sync-pairing. Ephemeral and in-memory only, same as pairing state in
 * sync.ts: this is a short-lived handshake, not something that needs to
 * survive a restart, and keeping it off disk shrinks what a compromised
 * backup/disk could expose.
 */
const REQUEST_TTL_MS = 10 * 60_000;
// Once resolved, the requester's own poll loop picks it up within seconds — but reap on
// a separate, shorter clock from REQUEST_TTL_MS anyway, so a host who takes nearly the
// full 10 minutes to click Approve can't have the token reaped out from under a requester
// that hasn't had a chance to poll it yet.
const DELIVERY_GRACE_MS = 2 * 60_000;
const ACCESS_RATE_LIMIT = 6;
const ACCESS_RATE_WINDOW_MS = 5 * 60_000;

interface PendingAccessRequest {
  ip: string;
  receivedAt: number;
  status: "pending" | "approved" | "denied";
  resolvedAt?: number;
  /** Set once approved; handed to the requester's own poll call exactly once, then cleared. */
  grantedToken?: string;
}

const pendingAccess = new Map<string, PendingAccessRequest>();
const accessAttempts = new Map<string, { count: number; windowStart: number }>();

function reapExpired(): void {
  const now = Date.now();
  for (const [id, req] of pendingAccess) {
    const age = req.status === "pending" ? now - req.receivedAt : now - (req.resolvedAt ?? req.receivedAt);
    const ttl = req.status === "pending" ? REQUEST_TTL_MS : DELIVERY_GRACE_MS;
    if (age > ttl) pendingAccess.delete(id);
  }
  for (const [ip, entry] of accessAttempts) if (now - entry.windowStart > ACCESS_RATE_WINDOW_MS) accessAttempts.delete(ip);
}

/** Caps access-request attempts per source IP so the poll/approve handshake can't be spammed. */
export function checkAccessRateLimit(sourceIp: string): boolean {
  reapExpired();
  const now = Date.now();
  const entry = accessAttempts.get(sourceIp);
  if (!entry || now - entry.windowStart > ACCESS_RATE_WINDOW_MS) {
    accessAttempts.set(sourceIp, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= ACCESS_RATE_LIMIT;
}

export function createAccessRequest(ip: string): string {
  reapExpired();
  const id = randomUUID();
  pendingAccess.set(id, { ip, receivedAt: Date.now(), status: "pending" });
  return id;
}

export function listAccessRequests(): Array<{ requestId: string; ip: string; receivedAt: number }> {
  reapExpired();
  return [...pendingAccess.entries()]
    .filter(([, r]) => r.status === "pending")
    .map(([requestId, r]) => ({ requestId, ip: r.ip, receivedAt: r.receivedAt }));
}

export function approveAccessRequest(id: string, token: string): boolean {
  reapExpired();
  const req = pendingAccess.get(id);
  if (!req || req.status !== "pending") return false;
  req.status = "approved";
  req.grantedToken = token;
  req.resolvedAt = Date.now();
  return true;
}

export function denyAccessRequest(id: string): boolean {
  reapExpired();
  const req = pendingAccess.get(id);
  if (!req || req.status !== "pending") return false;
  req.status = "denied";
  req.resolvedAt = Date.now();
  return true;
}

export type AccessPollResult = { status: "pending" | "denied" | "expired" } | { status: "approved"; token: string };

/** Consumes the granted token on the first poll that observes it, so it's never retrievable twice. */
export function pollAccessRequest(id: string): AccessPollResult {
  reapExpired();
  const req = pendingAccess.get(id);
  if (!req) return { status: "expired" };
  if (req.status === "approved" && req.grantedToken) {
    const token = req.grantedToken;
    pendingAccess.delete(id);
    return { status: "approved", token };
  }
  if (req.status === "denied") {
    pendingAccess.delete(id);
    return { status: "denied" };
  }
  return { status: "pending" };
}
