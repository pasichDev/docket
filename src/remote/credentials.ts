import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dataPath } from "../data-dir.js";
import { decryptFromBuffer, encryptToBuffer } from "../crypto.js";
import { withFileLock } from "../filelock.js";

/**
 * This device's credentials for the ONE remote server it's paired with (RFC "Local and
 * Self-Hosted Backend Modes" §10: device credentials belong in the existing protected
 * data directory, not the general config.json). Encrypted at rest exactly like
 * peers.json — `secret` is exactly as sensitive as a P2P peer's shared secret, since it's
 * what authenticates every request this device makes to the server.
 *
 * A single record, not a list: the product surface is "this device optionally uses ONE
 * self-hosted server" (RFC §3's UI — a radio choice, not a list of servers), unlike
 * peers.json's array of P2P partners.
 */
export interface RemoteServerCredentials {
  serverUrl: string;
  /** The server's own device.ts identity id, learned from GET /api/v1/info at pairing time — kept so a future `docket status` can show which server this actually is even if serverUrl changes. */
  serverDeviceId: string;
  /** ECDH+HKDF("docket/server-auth/v1")-derived secret (see device.ts deriveServerAuthSecret) — never transmitted. */
  secret: string;
  pairedAt: string;
}

const CREDENTIALS_PATH = await dataPath("remote-server.json.enc");
const LOCK_PATH = `${CREDENTIALS_PATH}.lock`;

export async function loadRemoteCredentials(): Promise<RemoteServerCredentials | null> {
  try {
    const encrypted = await readFile(CREDENTIALS_PATH);
    const json = await decryptFromBuffer(encrypted);
    return JSON.parse(json) as RemoteServerCredentials;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveRemoteCredentials(creds: RemoteServerCredentials): Promise<void> {
  await withFileLock(LOCK_PATH, async () => {
    const tmpPath = `${CREDENTIALS_PATH}.${randomUUID()}.tmp`;
    const encrypted = await encryptToBuffer(JSON.stringify(creds, null, 2));
    await writeFile(tmpPath, encrypted, { mode: 0o600 });
    await rename(tmpPath, CREDENTIALS_PATH);
  });
}

/** Used by a future `docket backend localize` (RFC §29) — not called by anything in this phase, kept alongside save/load since it's the obvious counterpart and trivial to get right here. */
export async function clearRemoteCredentials(): Promise<void> {
  await withFileLock(LOCK_PATH, async () => {
    await rm(CREDENTIALS_PATH, { force: true });
  });
}
