import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dataPath } from "./data-dir.js";

const KEY_PATH = await dataPath("key");
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

let cachedKey: Buffer | null = null;

/**
 * Local-machine-only encryption key for at-rest storage. Protects the data
 * file against accidental exposure (a stray `git add -A`, a backup tool that
 * doesn't preserve permissions, another account on a shared machine) — not
 * against anyone with read access to this user account, since the key sits
 * right next to the data it protects.
 */
async function getOrCreateKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  try {
    cachedKey = await readFile(KEY_PATH);
    return cachedKey;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = randomBytes(32);
  await writeFile(KEY_PATH, key, { mode: 0o600 });
  await chmod(KEY_PATH, 0o600); // writeFile's mode is masked by umask on some platforms — re-assert.
  cachedKey = key;
  return key;
}

/** AES-256-GCM encrypt with an arbitrary 32-byte key — the building block both at-rest storage and peer-sync encryption share. */
export function encryptWithKey(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/** Throws (via GCM auth-tag verification) if `data` was truncated, corrupted, or encrypted under a different key. */
export function decryptWithKey(key: Buffer, data: Buffer): string {
  const iv = data.subarray(0, IV_LEN);
  const authTag = data.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const ciphertext = data.subarray(IV_LEN + AUTH_TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export async function encryptToBuffer(plaintext: string): Promise<Buffer> {
  return encryptWithKey(await getOrCreateKey(), plaintext);
}

export async function decryptFromBuffer(data: Buffer): Promise<string> {
  return decryptWithKey(await getOrCreateKey(), data);
}
