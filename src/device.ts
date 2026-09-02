import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { dirname, join } from "node:path";

const DEVICE_PATH = join(homedir(), ".todo-mcp", "device.json");
const HKDF_INFO = Buffer.from("todo-mcp-sync-v1");

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

/** device.json holds the X25519 private key — exactly as sensitive as the peers/todos encryption keys, so it gets the same owner-only permissions (writeFile's mode is masked by umask on some platforms; the explicit chmod re-asserts it). */
async function writeIdentity(identity: DeviceIdentity): Promise<void> {
  await writeFile(DEVICE_PATH, JSON.stringify(identity, null, 2), { mode: 0o600 });
  await chmod(DEVICE_PATH, 0o600);
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
  cached = {
    id: stored?.id ?? randomUUID(),
    name: stored?.name ?? hostname().replace(/\.local$/, ""),
    role: stored?.role ?? "host",
    ...keys,
  };
  await mkdir(dirname(DEVICE_PATH), { recursive: true });
  await writeIdentity(cached);
  return cached;
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
  const identity = await getOrCreateIdentity();
  if (identity.role === role) return;
  identity.role = role;
  await writeIdentity(identity);
}

/**
 * Derives the shared sync secret with a peer, given their public key coordinate.
 * ECDH is commutative — the peer performs the same computation with our public
 * key and its own private key and arrives at the identical result, so the secret
 * itself never crosses the network in either direction.
 */
export async function deriveSharedSecret(peerPublicKeyX: string): Promise<string> {
  const identity = await getOrCreateIdentity();
  const privateKey = createPrivateKey({
    key: { kty: "OKP", crv: "X25519", x: identity.privateKeyJwk.x, d: identity.privateKeyJwk.d },
    format: "jwk",
  });
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: peerPublicKeyX }, format: "jwk" });
  const shared = diffieHellman({ privateKey, publicKey });
  const derived = hkdfSync("sha256", shared, Buffer.alloc(0), HKDF_INFO, 32);
  return Buffer.from(derived).toString("hex");
}
