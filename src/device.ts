import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomUUID } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dataPath } from "./data-dir.js";
import { withFileLock, type Lease } from "./filelock.js";
import { atomicWriteFile } from "./fs-atomic.js";

const DEVICE_PATH = await dataPath("device.json");
const DEVICE_LOCK_PATH = `${DEVICE_PATH}.lock`;
// Domain-separated per RFC "Local and Self-Hosted Backend Modes" §12: each protocol gets
// its own HKDF info string so the SAME ECDH shared point never yields the same derived
// bytes for two different purposes — a device pairing with both a P2P peer and a remote
// server ends up with two unrelated secrets, even against the same peer public key.
// P2P_SYNC_HKDF_INFO's literal value is unchanged from before this constant existed
// ("docket-sync-v1", not "docket/p2p-sync/v1") — renaming it would derive different bytes
// and silently break every already-paired peer's stored secret.
const P2P_SYNC_HKDF_INFO = Buffer.from("docket-sync-v1");
const SERVER_AUTH_HKDF_INFO = Buffer.from("docket/server-auth/v1");

interface X25519Jwk {
  x: string;
  d?: string;
}

export type DeviceRole = "host" | "guest";

interface DeviceIdentity {
  id: string;
  name: string;
  /** X25519 keypair used to derive per-peer shared secrets via ECDH — never transmitted, unlike the derived secret's ancestor in v1 (a random value sent in the clear during pairing). */
  publicKeyX: string;
  privateKeyJwk: X25519Jwk;
  /**
   * "host" (default, sovereign) can invite and approve other devices. The
   * moment a device successfully redeems someone ELSE's invite (joins their
   * group via "I have a code"), it becomes a "guest" and permanently loses
   * the ability to invite/approve further devices itself — only the host
   * that originated a group can grow it, so a joined device can't silently
   * become a new entry point into the group without that host's action.
   */
  role: DeviceRole;
}

let cached: DeviceIdentity | null = null;

/**
 * device.json holds the X25519 private key — exactly as sensitive as the peers/todos
 * encryption keys, so it gets the same owner-only permissions (the temp file is created
 * with the mode directly, and rename carries it over, so there is no window where the key
 * sits on disk world-readable).
 *
 * The lease is not decoration. This file IS this machine's identity: losing a write here
 * does not lose a todo, it swaps the keypair every already-paired peer authenticates
 * against. A process suspended inside its critical section — a closed laptop lid is enough
 * — wakes with the lock long since reaped and taken over, and would otherwise overwrite a
 * newer identity with the one it read minutes ago. Proving the lock is still ours
 * immediately before the write is the whole guard.
 */
async function writeIdentity(identity: DeviceIdentity, lease: Lease): Promise<void> {
  await lease.assertOwned();
  await atomicWriteFile(DEVICE_PATH, JSON.stringify(identity, null, 2));
}

type StoredIdentity = Partial<DeviceIdentity> & { id: string; name: string };

/** Null when there's no device.json yet — any other read/parse failure is a real error and propagates. */
async function readIdentityFile(): Promise<StoredIdentity | null> {
  try {
    return JSON.parse(await readFile(DEVICE_PATH, "utf8")) as StoredIdentity;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * A stable identity for THIS machine, separate from the per-process MCP
 * `agent`/`session` fields — used to show which physical device an item
 * came from, and as the party identity in device-pairing. The X25519
 * keypair is not secret in the sense the todos/peers files are (a public
 * key is, by definition, fine to hand out), but the private half must
 * never leave this file.
 */
async function getOrCreateIdentity(): Promise<DeviceIdentity> {
  if (cached) return cached;
  return withFileLock(DEVICE_LOCK_PATH, async (lease) => {
    // Another process can create the identity while this process waits for the
    // lock. Recheck inside the critical section before generating any keypair.
    if (cached) return cached;
    const stored = await readIdentityFile();

    if (stored?.publicKeyX && stored.privateKeyJwk && stored.role) {
      cached = stored as DeviceIdentity;
      // Self-heal a device.json created before permissions were tightened to owner-only.
      await chmod(DEVICE_PATH, 0o600).catch(() => {});
      return cached;
    }

    // Either brand new, or an older device.json missing fields added since — in the
    // latter case keep the existing id/name and fill in only what's absent. A device
    // with no recorded role has never joined anyone else's group, so: host.
    const keys = stored?.publicKeyX && stored.privateKeyJwk
      ? { publicKeyX: stored.publicKeyX, privateKeyJwk: stored.privateKeyJwk }
      : generateX25519();
    const identity: DeviceIdentity = {
      id: stored?.id ?? randomUUID(),
      name: stored?.name ?? hostname().replace(/\.local$/, ""),
      role: stored?.role ?? "host",
      ...keys,
    };
    await writeIdentity(identity, lease);
    cached = identity;
    return identity;
  });
}

function generateX25519(): { publicKeyX: string; privateKeyJwk: X25519Jwk } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ format: "jwk" }) as X25519Jwk;
  const priv = privateKey.export({ format: "jwk" }) as X25519Jwk;
  return { publicKeyX: pub.x, privateKeyJwk: priv };
}

export async function getDeviceId(): Promise<string> {
  return (await getOrCreateIdentity()).id;
}

export async function getDeviceName(): Promise<string> {
  return (await getOrCreateIdentity()).name;
}

/** This device's X25519 public key coordinate — safe to hand to a peer during pairing. */
export async function getDevicePublicKey(): Promise<string> {
  return (await getOrCreateIdentity()).publicKeyX;
}

export async function getDeviceRole(): Promise<DeviceRole> {
  return (await getOrCreateIdentity()).role;
}

/** Called once, the moment this device successfully joins another device's group via "I have a code" — permanent until manually reset by unpairing from everyone. */
export async function setDeviceRole(role: DeviceRole): Promise<void> {
  // Ensure the identity exists BEFORE taking the lock — getOrCreateIdentity takes the same
  // one, and this is a read-modify-write of the whole file, not a field update.
  await getOrCreateIdentity();
  await withFileLock(DEVICE_LOCK_PATH, async (lease) => {
    // Re-read inside the critical section: the cached copy was loaded at some earlier
    // point, and writing it back would undo anything another process has changed since.
    const stored = await readIdentityFile();
    const current: DeviceIdentity =
      stored?.publicKeyX && stored.privateKeyJwk && stored.role ? (stored as DeviceIdentity) : cached!;
    cached = current;
    if (current.role === role) return;
    const updated: DeviceIdentity = { ...current, role };
    await writeIdentity(updated, lease);
    cached = updated;
  });
}

/**
 * ECDH is commutative — the other side performs the same computation with our public key
 * and its own private key and arrives at the identical result, so the secret itself never
 * crosses the network in either direction. `info` is the HKDF domain-separation label
 * (RFC §12) — callers never pass a raw Buffer directly so the two purposes below can't
 * accidentally share one.
 */
async function deriveSecret(peerPublicKeyX: string, info: Buffer): Promise<string> {
  const identity = await getOrCreateIdentity();
  const privateKey = createPrivateKey({
    key: { kty: "OKP", crv: "X25519", x: identity.privateKeyJwk.x, d: identity.privateKeyJwk.d },
    format: "jwk",
  });
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: peerPublicKeyX }, format: "jwk" });
  const shared = diffieHellman({ privateKey, publicKey });
  const derived = hkdfSync("sha256", shared, Buffer.alloc(0), info, 32);
  return Buffer.from(derived).toString("hex");
}

/** Derives the shared P2P sync secret with a paired peer device (see sync.ts). */
export async function deriveSharedSecret(peerPublicKeyX: string): Promise<string> {
  return deriveSecret(peerPublicKeyX, P2P_SYNC_HKDF_INFO);
}

/**
 * Derives this device's per-device authentication secret with a `docket serve` server,
 * given the server's own X25519 public key (RFC "Local and Self-Hosted Backend Modes"
 * §12-14). Same ECDH primitive as deriveSharedSecret, but a different HKDF label, so
 * pairing with a remote server never produces the same bytes as pairing with a P2P peer
 * even against the same public key. Used to HMAC-sign every remote API request
 * (src/remote/device-auth.ts) — never to encrypt a payload the way the P2P secret does.
 */
export async function deriveServerAuthSecret(serverPublicKeyX: string): Promise<string> {
  return deriveSecret(serverPublicKeyX, SERVER_AUTH_HKDF_INFO);
}
