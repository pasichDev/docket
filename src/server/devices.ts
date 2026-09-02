import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dataPath } from "../data-dir.js";
import { decryptFromBuffer, encryptToBuffer } from "../crypto.js";
import { deriveServerAuthSecret, getDevicePublicKey } from "../device.js";
import { withFileLock } from "../filelock.js";
import { checkPairingRateLimit, CODE_CHARSET, generateShortCode, pairingSas } from "../sync.js";

/**
 * Server-side half of RFC "Local and Self-Hosted Backend Modes" §13 (Pairing) — the
 * registry of devices a `docket serve` instance has approved, plus the ephemeral pairing
 * handshake that gets a device into it. Modeled directly on sync.ts's P2P pairing (same
 * short pairing code, same SAS, same rate limiting) and peers.ts's persistence (same
 * encrypted-JSON + file-lock pattern) — this is genuinely a server talking to N clients
 * instead of one device talking to one peer, so it gets its own small module rather than
 * shoehorning server semantics into sync.ts/peers.ts.
 */

const PAIR_CODE_TTL_MS = 5 * 60_000;
const PENDING_REQUEST_TTL_MS = 5 * 60_000;

export interface PairedDevice {
  /** The client's own device.ts identity id — NOT assigned by the server. */
  id: string;
  name: string;
  publicKeyX: string;
  /** The ECDH+HKDF("docket/server-auth/v1")-derived secret both sides computed independently — never transmitted (see device.ts deriveServerAuthSecret). Signs every request from this device (src/remote/device-auth.ts). */
  secret: string;
  pairedAt: string;
  /** Explicit revocation, same shape as peers.ts's Peer.revoked — a revoked device's signature still verifies (it still knows the secret) but every route rejects it once looked up, same as an unpaired peer. */
  revoked?: boolean;
}

const DEVICES_PATH = await dataPath("devices.json.enc");
const DEVICES_LOCK_PATH = `${DEVICES_PATH}.lock`;

async function loadDevices(): Promise<PairedDevice[]> {
  try {
    const encrypted = await readFile(DEVICES_PATH);
    const json = await decryptFromBuffer(encrypted);
    return JSON.parse(json) as PairedDevice[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function saveDevices(devices: PairedDevice[]): Promise<void> {
  const tmpPath = `${DEVICES_PATH}.${randomUUID()}.tmp`;
  const encrypted = await encryptToBuffer(JSON.stringify(devices, null, 2));
  await writeFile(tmpPath, encrypted, { mode: 0o600 });
  await rename(tmpPath, DEVICES_PATH);
}

async function withDevices<T>(fn: (devices: PairedDevice[]) => T | Promise<T>): Promise<T> {
  return withFileLock(DEVICES_LOCK_PATH, async () => {
    const devices = await loadDevices();
    const result = await fn(devices);
    await saveDevices(devices);
    return result;
  });
}

export async function listDevices(): Promise<PairedDevice[]> {
  return loadDevices();
}

export async function findDeviceById(id: string): Promise<PairedDevice | undefined> {
  return (await loadDevices()).find((d) => d.id === id);
}

export async function revokeDevice(id: string): Promise<boolean> {
  return withDevices((devices) => {
    const device = devices.find((d) => d.id === id);
    if (!device) return false;
    device.revoked = true;
    return true;
  });
}

export async function restoreDevice(id: string): Promise<boolean> {
  return withDevices((devices) => {
    const device = devices.find((d) => d.id === id);
    if (!device) return false;
    device.revoked = false;
    return true;
  });
}

export async function removeDevice(id: string): Promise<boolean> {
  return withDevices((devices) => {
    const index = devices.findIndex((d) => d.id === id);
    if (index === -1) return false;
    devices.splice(index, 1);
    return true;
  });
}

// --- Ephemeral pairing handshake state — in-memory only, same lifetime tradeoff as
// sync.ts's pendingInvites/pendingIncoming: doesn't need to survive a `docket serve`
// restart, and keeping it off disk shrinks what a compromised backup could expose.

interface PendingCode {
  expiresAt: number;
}

interface PendingPairingRequest {
  deviceId: string;
  deviceName: string;
  publicKeyX: string;
  secret: string;
  sas: string;
  status: "pending" | "approved" | "denied";
  receivedAt: number;
}

const pendingCodes = new Map<string, PendingCode>();
const pendingRequests = new Map<string, PendingPairingRequest>();

function reapExpired(): void {
  const now = Date.now();
  for (const [code, entry] of pendingCodes) if (entry.expiresAt < now) pendingCodes.delete(code);
  for (const [id, req] of pendingRequests) if (now - req.receivedAt > PENDING_REQUEST_TTL_MS) pendingRequests.delete(id);
}

/** Called by the loopback-only admin route backing `docket devices pair` (RFC §13). */
export function createPairingCode(): { code: string; expiresAt: number } {
  reapExpired();
  let code: string;
  do {
    code = generateShortCode();
  } while (pendingCodes.has(code));
  const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
  pendingCodes.set(code, { expiresAt });
  return { code, expiresAt };
}

/** One-time: consumed whether or not the resulting request is ultimately approved. */
function redeemPairingCode(code: string): boolean {
  reapExpired();
  const normalized = code.trim().toUpperCase();
  const entry = pendingCodes.get(normalized);
  if (!entry) return false;
  pendingCodes.delete(normalized);
  return entry.expiresAt >= Date.now();
}

export { checkPairingRateLimit, CODE_CHARSET };

export type PairingRequestOutcome =
  | { ok: true; requestId: string; sas: string }
  | { ok: false; error: "invalid_or_expired_code" | "already_paired" };

/**
 * Client presents a pairing code + its identity; this derives (never receives) the
 * shared secret via ECDH against the client's public key, exactly as the client does
 * against the server's — see device.ts's deriveServerAuthSecret. Stored as PENDING until
 * a human operator approves it via the loopback-only admin route.
 */
export async function requestPairing(code: string, deviceId: string, deviceName: string, publicKeyX: string): Promise<PairingRequestOutcome> {
  if (!redeemPairingCode(code)) return { ok: false, error: "invalid_or_expired_code" };
  if (await findDeviceById(deviceId)) return { ok: false, error: "already_paired" };
  const secret = await deriveServerAuthSecret(publicKeyX);
  const sas = pairingSas(secret, await getDevicePublicKey(), publicKeyX);
  const requestId = randomUUID();
  pendingRequests.set(requestId, { deviceId, deviceName, publicKeyX, secret, sas, status: "pending", receivedAt: Date.now() });
  return { ok: true, requestId, sas };
}

export function getPairingRequestStatus(requestId: string): { status: PendingPairingRequest["status"] } | null {
  reapExpired();
  const req = pendingRequests.get(requestId);
  if (!req) return null;
  return { status: req.status };
}

export function listPendingPairingRequests(): Array<{ requestId: string; deviceId: string; deviceName: string; sas: string; receivedAt: number }> {
  reapExpired();
  return [...pendingRequests.entries()].map(([requestId, req]) => ({
    requestId,
    deviceId: req.deviceId,
    deviceName: req.deviceName,
    sas: req.sas,
    receivedAt: req.receivedAt,
  }));
}

export async function approvePairingRequest(requestId: string): Promise<PairedDevice | null> {
  reapExpired();
  const req = pendingRequests.get(requestId);
  if (!req || req.status !== "pending") return null;
  const device: PairedDevice = {
    id: req.deviceId,
    name: req.deviceName,
    publicKeyX: req.publicKeyX,
    secret: req.secret,
    pairedAt: new Date().toISOString(),
  };
  await withDevices((devices) => {
    const existing = devices.findIndex((d) => d.id === device.id);
    if (existing === -1) devices.push(device);
    else devices[existing] = device;
  });
  req.status = "approved";
  return device;
}

export function denyPairingRequest(requestId: string): boolean {
  reapExpired();
  const req = pendingRequests.get(requestId);
  if (!req || req.status !== "pending") return false;
  req.status = "denied";
  return true;
}
