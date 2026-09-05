import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getDataDirectory } from "./data-dir.js";
import { withFileLock, LeaseLostError, type Lease } from "./filelock.js";
import { atomicWriteFile, syncDirectory } from "./fs-atomic.js";
import { newGeneration, readGeneration } from "./generation.js";
import { log } from "./log.js";
import { listSessions } from "./sessions.js";
import { resetStoreEpoch } from "./storage.js";

// Everything a fresh machine needs to become this device again: its identity (so paired
// peers keep recognizing it — a NEW identity would look like a brand-new, unpaired device
// to everyone it was synced with), the at-rest encryption key, and the encrypted stores
// themselves. Deliberately NOT re-decrypting todos/peers first — the backup stays exactly
// as sensitive as the live data directory either way, and re-encrypting a copy would be
// pure extra risk (a second place a bug could leak plaintext) for no benefit.
const BACKUP_FILES = [
  "device.json",
  "key",
  "todos.json.enc",
  "history.json.enc",
  "peers.json.enc",
  "viewers.json.enc",
  // The self-hosted server's registry of authorised devices. Without it, restoring a server
  // backup onto a fresh machine gives you the todos and the server's identity but not the
  // list of clients allowed to talk to it — every paired device silently stops
  // authenticating, which is exactly the disaster the backup was taken for.
  "devices.json.enc",
];

/**
 * The locks that must be held to read a COHERENT set of those files.
 *
 * Backup used to read them one after another while the rest of the machine kept working, so
 * a bundle could hold a todos.json.enc from before a sync and a peers.json.enc from after
 * it. Nothing detects that: each file is individually valid, and the mixture only shows up
 * later as a peer whose cursor points past records the restored store has never had.
 *
 * Taken in sorted order, which is the canonical order for every multi-lock acquisition in
 * this codebase — nothing else takes two at once today, and this is what keeps that true
 * cheaply. `key` needs none (written once, by exclusive create, and never modified) and
 * history.json.enc needs none of its own (it is only ever written inside the store's lock).
 */
function snapshotLockPaths(dir: string): string[] {
  return ["device.json", "todos.json.enc", "peers.json.enc", "viewers.json.enc", "devices.json.enc"]
    .map((name) => join(dir, `${name}.lock`))
    .sort();
}

/**
 * Holds every lock in the list at once and hands the callback all of their leases.
 *
 * The leases are the point. Taking the locks is not the same as still holding them: a
 * process starved past the staleness window — a loaded machine, a suspended laptop — has its
 * locks legitimately reaped while it is still inside, and a backup that carried on reading
 * would assemble a bundle from two different moments and report success. Every other commit
 * path in this codebase re-checks before it acts; a snapshot has to re-check before it
 * claims to be one.
 */
async function withLocks<T>(lockPaths: readonly string[], fn: (leases: Lease[]) => Promise<T>): Promise<T> {
  const held: Lease[] = [];
  const take = async (index: number): Promise<T> => {
    if (index === lockPaths.length) return fn(held);
    return withFileLock(lockPaths[index], async (lease) => {
      held.push(lease);
      return take(index + 1);
    });
  };
  return take(0);
}

/** Throws LeaseLostError if any of them is no longer ours. */
async function assertAllOwned(leases: readonly Lease[]): Promise<void> {
  for (const lease of leases) await lease.assertOwned();
}

/** Files whose contents only make sense alongside the store they were captured with. */
const STORE_COUPLED_FILES = ["history.json.enc"];
const MAGIC = "docket-backup-v1";
/**
 * The bundle's INNER format version, independent of the envelope magic — old backups must
 * keep restoring, so the magic cannot move. v2 adds the manifest and the generation.
 */
const BUNDLE_FORMAT = 2;
const JOURNAL_NAME = "restore-journal.json";
const STAGING_PREFIX = ".restore-staging-";
/** How many times a snapshot read is retried after losing a lock to a reap. */
const SNAPSHOT_ATTEMPTS = 4;
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

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** Per-file integrity, so a restore can tell "this bundle is intact" from "this bundle decrypted". */
interface BackupManifestEntry {
  sha256: string;
  bytes: number;
}

interface BackupBundle {
  magic: string;
  formatVersion?: number;
  createdAt: string;
  /** The data-directory incarnation this snapshot was taken from. Informational; restore mints a new one. */
  generation?: string | null;
  files: Record<string, string>;
  manifest?: Record<string, BackupManifestEntry>;
}

/**
 * Encrypts the whole data directory (identity, key, todos, peers, viewers, server devices)
 * into one portable, password-protected file — as a single coherent moment, not as whatever
 * each file happened to contain when it was read.
 */
export async function createBackup(password: string): Promise<Buffer> {
  const dir = await getDataDirectory();
  let files: Record<string, string> = {};
  let manifest: Record<string, BackupManifestEntry> = {};
  let generation: string | null = null;

  for (let attempt = 1; ; attempt++) {
    try {
      const read: Record<string, string> = {};
      const readManifest: Record<string, BackupManifestEntry> = {};
      generation = await withLocks(snapshotLockPaths(dir), async (leases) => {
        for (const name of BACKUP_FILES) {
          try {
            const contents = await readFile(join(dir, name));
            read[name] = contents.toString("base64");
            readManifest[name] = { sha256: sha256(contents), bytes: contents.length };
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            // Not every install has every file (e.g. no viewers.json.enc until a viewer is
            // ever added) — absence just means restore has nothing to write back for that one.
          }
        }
        // Read inside the locks too, so the recorded generation belongs to the same moment.
        const currentGeneration = await readGeneration();
        // The whole read happened while these were ours, or none of it counts.
        await assertAllOwned(leases);
        return currentGeneration;
      });
      files = read;
      manifest = readManifest;
      break;
    } catch (err) {
      if (!(err instanceof LeaseLostError) || attempt >= SNAPSHOT_ATTEMPTS) {
        if (err instanceof LeaseLostError) {
          throw new Error(
            `docket: could not read a coherent snapshot of ${dir} in ${SNAPSHOT_ATTEMPTS} attempts — ` +
              `this machine is heavily loaded, or a docket process is stuck holding a lock. No backup was written.`,
          );
        }
        throw err;
      }
      log(`backup: lost a lock mid-snapshot on attempt ${attempt} — re-reading rather than writing a bundle from two moments`);
    }
  }

  if (Object.keys(files).length === 0) throw new Error("nothing to back up — no docket data directory found");

  const bundle: BackupBundle = {
    magic: MAGIC,
    formatVersion: BUNDLE_FORMAT,
    createdAt: new Date().toISOString(),
    generation,
    files,
    manifest,
  };
  const plaintext = JSON.stringify(bundle);
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

function decodeBundle(buf: Buffer, password: string): BackupBundle {
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
  return JSON.parse(plaintext) as BackupBundle;
}

/* ==========================================================================================
 * Who else is holding this data directory
 * ========================================================================================== */

/**
 * Restore replaces the at-rest key, the device identity and every store. A process that
 * started before it — an MCP session, the web dashboard, a `docket serve` — is still holding
 * all three in memory, and one more write from any of them lands ciphertext encrypted under
 * a key that is no longer on disk.
 *
 * The generation check in storage.ts and registry.ts is the guarantee: no old process CAN
 * commit into the new generation. This list is the courtesy — telling the operator what to
 * stop, before doing something they would rather do with the machine quiet.
 */
export async function liveHoldersOfDataDirectory(): Promise<string[]> {
  const holders: string[] = [];
  for (const session of await listSessions()) {
    holders.push(`${session.agent ?? "an MCP session"} (pid ${session.pid}) in ${session.cwd}`);
  }
  const mine = await readGeneration();
  const probes: Array<{ label: string; port: number; hint: string }> = [
    { label: "the web dashboard", port: Number(process.env.DOCKET_WEB_PORT ?? 8787), hint: "stop it, or close the MCP host that auto-started it" },
    { label: "`docket serve`", port: Number(process.env.DOCKET_SERVER_PORT ?? 8788), hint: "stop it before restoring" },
  ];
  for (const { label, port, hint } of probes) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(500) });
      if (!res.ok) continue;
      // A docket process on the expected port is not necessarily a process holding THIS data
      // directory — a second install, a container, another user's dashboard. Warning about
      // one of those would be noise the user cannot act on, and would train them to pass
      // --force. Only a matching generation means it is reading the files about to be
      // replaced; an older build that does not report one is assumed to be, since silence is
      // not evidence of absence.
      const body = (await res.json().catch(() => null)) as { generation?: unknown } | null;
      const theirs = typeof body?.generation === "string" ? body.generation : null;
      if (theirs !== null && mine !== null && theirs !== mine) continue;
      holders.push(`${label} on 127.0.0.1:${port} — ${hint}`);
    } catch {
      // Nothing listening, which is what we want.
    }
  }
  return holders;
}

/* ==========================================================================================
 * Restore, as a transaction
 * ========================================================================================== */

interface RestoreJournal {
  stamp: string;
  staging: string;
  /** The files to move into place, in order. */
  names: string[];
  /** Files whose live copy must be swept aside because the bundle did not carry one. */
  sweep: string[];
}

const journalPathIn = (dir: string): string => join(dir, JOURNAL_NAME);

/**
 * Decrypts and writes every file the backup contains back into the (live) data directory.
 * Overwrites this device's current identity/todos/peers/viewers — the caller is responsible
 * for confirming that with the human first; see `docket restore` in index.ts.
 *
 * Structured as stage → journal → commit → clean, because the one-by-one version was not
 * crash-consistent: it replaced `key` and then each ciphertext file in turn, so a crash in
 * the middle left a data directory holding the NEW key and some of the OLD ciphertext —
 * unreadable, and unreadable in a way no later run could diagnose or undo. Now nothing is
 * touched until every file has been validated and staged, the journal names the whole set
 * before the first move, and an interrupted commit is finished on the next start.
 *
 * Anything currently on disk is renamed aside (never deleted outright) before being
 * replaced, so a restore into the wrong directory or with a stale backup is still
 * recoverable afterwards.
 */
export async function restoreBackup(buf: Buffer, password: string): Promise<{ restoredFiles: string[] }> {
  const parsed = decodeBundle(buf, password);
  const dir = await getDataDirectory();

  // ---- Validate everything, before anything on disk is touched -------------------------
  const staged: Array<{ name: string; contents: Buffer }> = [];
  for (const [name, base64] of Object.entries(parsed.files ?? {})) {
    // A backup file is self-encrypted — whoever wrote it chose both the plaintext AND the
    // password, so its `files` keys are attacker-controlled input, not trusted metadata.
    // Without this allowlist, a key like "../../../.ssh/authorized_keys" would let a
    // crafted backup file write anywhere the process can, via the join() below.
    if (!BACKUP_FILES.includes(name)) continue;
    const contents = Buffer.from(base64, "base64");
    const expected = parsed.manifest?.[name];
    if (expected && (expected.bytes !== contents.length || expected.sha256 !== sha256(contents))) {
      // The envelope's GCM tag already proves the bundle was not tampered with; this catches
      // the other thing — a bundle written by a build with a base64 or truncation bug — and
      // catches it before a single live file has been moved.
      throw new Error(`backup is damaged: ${name} does not match the manifest recorded when it was created`);
    }
    staged.push({ name, contents });
  }
  if (staged.length === 0) throw new Error("this backup contains no recognisable docket files");

  // ---- Stage --------------------------------------------------------------------------
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const staging = join(dir, `${STAGING_PREFIX}${stamp}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  for (const { name, contents } of staged) await atomicWriteFile(join(staging, name), contents);
  await syncDirectory(staging);

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
  const restoredNames = staged.map(({ name }) => name);
  const journal: RestoreJournal = {
    stamp,
    staging,
    names: restoredNames,
    sweep: STORE_COUPLED_FILES.filter((name) => !restoredNames.includes(name)),
  };

  // ---- Commit, under every lock, with the journal written first -------------------------
  await withLocks(snapshotLockPaths(dir), async (leases) => {
    await assertAllOwned(leases);
    await atomicWriteFile(journalPathIn(dir), JSON.stringify(journal, null, 2));
    await applyJournal(dir, journal);
  });

  return { restoredFiles: restoredNames };
}

/** Moves a live file aside, keeping any earlier .bak from this same restore intact. */
async function setAside(targetPath: string, stamp: string): Promise<void> {
  const backupPath = `${targetPath}.pre-restore-${stamp}.bak`;
  try {
    await stat(backupPath);
    return; // an interrupted run already set this one aside; that copy is the original
  } catch {
    // no .bak yet — fall through
  }
  try {
    await rename(targetPath, backupPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * The commit itself, written so that running it twice is the same as running it once — which
 * is what makes recovery from an interrupted restore possible at all. A staged file that is
 * still there has not been applied; one that is gone has. Nothing else is consulted.
 */
async function applyJournal(dir: string, journal: RestoreJournal): Promise<void> {
  for (const name of journal.names) {
    const stagedPath = join(journal.staging, name);
    try {
      await stat(stagedPath);
    } catch {
      continue; // already moved into place by an earlier, interrupted run
    }
    const targetPath = join(dir, name);
    await setAside(targetPath, journal.stamp);
    await rename(stagedPath, targetPath);
  }
  for (const name of journal.sweep) await setAside(join(dir, name), journal.stamp);
  await syncDirectory(dir);

  // Both of these are re-runnable, and both must happen before the journal is dropped.
  //
  // The generation stops every process that predates this restore from writing anything: it
  // is still holding the OLD at-rest key and the OLD device identity, and one more write
  // from it would encrypt part of the restored store under a key that is no longer on disk.
  //
  // The store epoch is the other half, facing outward: the restored store's sequence counter
  // has gone backwards, so every paired device's cursor points past records it has never
  // seen. Re-minting it is what makes them re-sync instead of silently skipping.
  await newGeneration();
  await resetStoreEpoch();

  await rm(journalPathIn(dir), { force: true });
  await rm(journal.staging, { recursive: true, force: true });
  await syncDirectory(dir);
}

/**
 * Finishes a restore that was interrupted partway through its commit. Called at startup,
 * before anything reads the store.
 *
 * Returns null when there was nothing to do, which is every ordinary start.
 */
export async function recoverInterruptedRestore(): Promise<{ stamp: string; names: string[] } | null> {
  const dir = await getDataDirectory();
  let journal: RestoreJournal;
  try {
    journal = JSON.parse(await readFile(journalPathIn(dir), "utf8")) as RestoreJournal;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A corrupt journal is worse than no journal: it names files this process is about to
    // move. Leave it and everything else exactly as it is, loudly.
    throw new Error(
      `docket: ${join(dir, JOURNAL_NAME)} is unreadable (${(err as Error).message}). A restore was interrupted and cannot be finished automatically — ` +
        `the staged copies are in ${dir} under "${STAGING_PREFIX}*" and the previous files under "*.pre-restore-*.bak".`,
    );
  }
  if (!journal || typeof journal.staging !== "string" || !Array.isArray(journal.names)) {
    throw new Error(`docket: ${join(dir, JOURNAL_NAME)} is not a restore journal this version understands`);
  }

  log(`restore: finishing an interrupted restore from ${journal.stamp}`);
  await withLocks(snapshotLockPaths(dir), () => applyJournal(dir, journal));
  return { stamp: journal.stamp, names: journal.names };
}

/** For `docket status` and the tests: staging directories left behind by a restore that never committed. */
export async function abandonedRestoreStaging(): Promise<string[]> {
  const dir = await getDataDirectory();
  try {
    return (await readdir(dir)).filter((name) => name.startsWith(STAGING_PREFIX)).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/**
 * The startup hook every entry point calls before it reads anything.
 *
 * Failure here is fatal by design: a half-applied restore is precisely the state in which
 * carrying on would write good data into a directory that is half old and half new.
 */
export async function finishAnyInterruptedRestore(): Promise<void> {
  const finished = await recoverInterruptedRestore();
  if (!finished) return;
  console.error(
    `docket: finished a restore that was interrupted (${finished.names.join(", ")}). ` +
      `The previous files are alongside them as *.pre-restore-${finished.stamp}.bak.`,
  );
}
