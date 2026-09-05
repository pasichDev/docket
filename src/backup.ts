import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDirectory } from "./data-dir.js";
import { resetStoreEpoch } from "./storage.js";

// Everything a fresh machine needs to become this device again: its identity (so paired
// peers keep recognizing it — a NEW identity would look like a brand-new, unpaired device
// to everyone it was synced with), the at-rest encryption key, and the encrypted stores
// themselves. Deliberately NOT re-decrypting todos/peers first — the backup stays exactly
// as sensitive as the live data directory either way, and re-encrypting a copy would be
// pure extra risk (a second place a bug could leak plaintext) for no benefit.
const BACKUP_FILES = ["device.json", "key", "todos.json.enc", "history.json.enc", "peers.json.enc", "viewers.json.enc"];
/** Files whose contents only make sense alongside the store they were captured with. */
const STORE_COUPLED_FILES = ["history.json.enc"];
const MAGIC = "docket-backup-v1";
// RFC 7914's own "interactive login" recommendation (N=2^14, r=8, p=1) — strong enough to
// meaningfully slow down offline password guessing against a stolen backup file, while
// staying under Node's default scrypt maxmem (32MiB) and fast enough for an interactive
// CLI prompt not to feel broken/hung.
const SCRYPT_N = 2 ** 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

/** Encrypts the whole data directory (identity, key, todos, peers, viewers) into one portable, password-protected file. */
export async function createBackup(password: string): Promise<Buffer> {
  const dir = await getDataDirectory();
  const files: Record<string, string> = {};
  for (const name of BACKUP_FILES) {
    try {
      files[name] = (await readFile(join(dir, name))).toString("base64");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Not every install has every file (e.g. no viewers.json.enc until a viewer is ever
      // added) — absence just means restore has nothing to write back for that one.
    }
  }
  if (Object.keys(files).length === 0) throw new Error("nothing to back up — no docket data directory found");

  const plaintext = JSON.stringify({ magic: MAGIC, createdAt: new Date().toISOString(), files });
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(password, salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const header = Buffer.from(JSON.stringify({ magic: MAGIC, salt: salt.toString("base64"), iv: iv.toString("base64") }), "utf8");
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32BE(header.length);
  return Buffer.concat([headerLen, header, authTag, ciphertext]);
}

export function isBackupFile(buf: Buffer): boolean {
  try {
    if (buf.length < 4) return false;
    const headerLen = buf.readUInt32BE(0);
    const header = JSON.parse(buf.subarray(4, 4 + headerLen).toString("utf8")) as { magic?: string };
    return header.magic === MAGIC;
  } catch {
    return false;
  }
}

/**
 * Decrypts and writes every file the backup contains back into the (live) data directory.
 * Overwrites this device's current identity/todos/peers/viewers — the caller is
 * responsible for confirming that with the human first; see `docket restore` in index.ts.
 * Anything currently on disk is renamed aside (never deleted outright) before being
 * replaced, so a restore into the wrong directory or with a stale backup is still
 * recoverable afterwards.
 */
export async function restoreBackup(buf: Buffer, password: string): Promise<{ restoredFiles: string[] }> {
  if (buf.length < 4) throw new Error("not a docket backup file");
  const headerLen = buf.readUInt32BE(0);
  let header: { magic?: string; salt?: string; iv?: string };
  try {
    header = JSON.parse(buf.subarray(4, 4 + headerLen).toString("utf8"));
  } catch {
    throw new Error("not a docket backup file");
  }
  if (header.magic !== MAGIC || typeof header.salt !== "string" || typeof header.iv !== "string") {
    throw new Error("not a docket backup file");
  }
  const authTag = buf.subarray(4 + headerLen, 4 + headerLen + AUTH_TAG_LEN);
  const ciphertext = buf.subarray(4 + headerLen + AUTH_TAG_LEN);
  const key = deriveKey(password, Buffer.from(header.salt, "base64"));
  let plaintext: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.iv, "base64"));
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("wrong password, or the backup file is corrupted");
  }
  const parsed = JSON.parse(plaintext) as { magic: string; files: Record<string, string> };

  const dir = await getDataDirectory();
  const restoreStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const restoredFiles: string[] = [];
  for (const [name, base64] of Object.entries(parsed.files)) {
    // A backup file is self-encrypted — whoever wrote it chose both the plaintext AND the
    // password, so its `files` keys are attacker-controlled input, not trusted metadata.
    // Without this allowlist, a key like "../../../.ssh/authorized_keys" would let a
    // crafted backup file write anywhere the process can, via the join() below.
    if (!BACKUP_FILES.includes(name)) continue;
    const targetPath = join(dir, name);
    try {
      await rename(targetPath, `${targetPath}.pre-restore-${restoreStamp}.bak`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, Buffer.from(base64, "base64"), { mode: 0o600 });
    await rename(tmpPath, targetPath);
    restoredFiles.push(name);
  }

  // A backup that carries no history side file must not leave the CURRENT one in place.
  // history.json.enc is keyed by todo uuid and is a continuation of each item's inline
  // history, so pairing a restored (older) store with a newer sidecar produces an audit log
  // describing edits the store does not contain, attached to items that may not exist.
  //
  // Only this file. peers.json.enc and viewers.json.enc are independent state — which
  // devices you have paired is not a property of the todo list — and sweeping them aside
  // because a backup happened to predate them would silently unpair every device. Likewise
  // `key`: a backup without one cannot have carried a readable store anyway, and moving the
  // live key aside would make the data directory unreadable rather than restored.
  for (const name of STORE_COUPLED_FILES) {
    if (restoredFiles.includes(name)) continue;
    const stalePath = join(dir, name);
    try {
      await rename(stalePath, `${stalePath}.pre-restore-${restoreStamp}.bak`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  // The restored store is a different incarnation from the one paired devices were reading:
  // its sequence counter has gone backwards, so every cursor they hold points past records
  // they have never seen. Re-minting the epoch is what makes them notice and re-sync. One
  // plaintext write, so this path still never decrypts anything (see the note above).
  await resetStoreEpoch();
  return { restoredFiles };
}
