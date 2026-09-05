import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dataPath } from "./data-dir.js";
import { atomicCreateOrRead, atomicWriteFile } from "./fs-atomic.js";

/**
 * Which incarnation of the data directory this process is talking to.
 *
 * Every long-running Docket process caches state it can never re-derive: the at-rest key
 * (crypto.ts), this device's identity (device.ts), the store epoch (storage.ts), the admin
 * token (server/admin-token.ts). All four are correct for the data directory the process
 * started against — and all four are silently wrong the moment `docket restore` replaces
 * that directory underneath it.
 *
 * What follows is not hypothetical. A `docket serve` still holding the OLD at-rest key
 * writes one more todo after a restore and the store is now half-encrypted under a key that
 * no longer exists on disk; nothing reports an error, and the file is unreadable from the
 * next start onwards. The lock does not help: the restoring process and the serving process
 * are cooperating correctly with each other, about two different sets of bytes.
 *
 * So the data directory carries a generation id, minted once and re-minted by restore. A
 * process pins it at startup, and every persistent write re-checks it immediately before
 * committing — the same place, and for the same reason, as the lock lease and the content
 * stamp. A process whose generation has moved stops writing and says exactly why.
 *
 * The store epoch is NOT this. The epoch tells paired devices that their sync cursors are
 * void; it is about the store's history, is sent over the wire, and says nothing about the
 * key or the identity. This is about the bytes on this one disk.
 */
const GENERATION_PATH = await dataPath("generation");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let pinned: string | null = null;

/** The generation this process is working against, pinned on first use for the life of the process. */
export async function getGeneration(): Promise<string> {
  if (pinned) return pinned;
  const contents = await atomicCreateOrRead(
    GENERATION_PATH,
    () => Buffer.from(randomUUID()),
    (buf) => UUID_RE.test(buf.toString("utf8").trim()),
  );
  pinned = contents.toString("utf8").trim();
  return pinned;
}

/** What is on disk right now, or null if the file has never been created. */
export async function readGeneration(): Promise<string | null> {
  try {
    const text = (await readFile(GENERATION_PATH, "utf8")).trim();
    return UUID_RE.test(text) ? text : null;
  } catch {
    return null;
  }
}

export class GenerationChangedError extends Error {
  constructor(pinnedGeneration: string, current: string | null) {
    super(
      `docket: this data directory was replaced while this process was running ` +
        `(started against generation ${pinnedGeneration.slice(0, 8)}, found ${current?.slice(0, 8) ?? "none"}). ` +
        `Nothing was written. Restart docket — and any MCP host, \`docket serve\` or web dashboard — to pick up the restored data.`,
    );
    this.name = "GenerationChangedError";
  }
}

/**
 * Throws if the data directory is no longer the one this process has been working against.
 *
 * Called immediately before a commit, never at the start of an operation: the whole point is
 * to catch a replacement that happened while the operation was in flight.
 *
 * The FIRST call in a process pins rather than checks. That is not a shortcut — it is the
 * only way the guard covers the processes that matter. An MCP session or a `docket serve`
 * may never touch the version endpoint or anything else that would ask for a generation, so
 * gating the check on "has this process already pinned one?" made it a no-op for exactly the
 * long-running writers it exists to stop. Pinning on the first write establishes the
 * baseline at the moment the process first commits, which is also the moment it first has
 * cached state worth protecting.
 *
 * An ABSENT generation after this process has pinned one is a mismatch, not a pass. The
 * upgrade case — a data directory written by a build that predates this file — is covered by
 * the pin itself, which mints the file. A generation that existed and is now gone means the
 * directory was replaced or wiped underneath a process still holding its key.
 */
export async function assertSameGeneration(): Promise<void> {
  if (!pinned) {
    await getGeneration();
    return;
  }
  const current = await readGeneration();
  if (current === pinned) return;
  throw new GenerationChangedError(pinned, current);
}

/**
 * Declares a new incarnation. Called by restore, as the last step of its commit, so that
 * every process still holding the previous one stops writing rather than corrupting what
 * was just restored.
 */
export async function newGeneration(): Promise<string> {
  const next = randomUUID();
  await atomicWriteFile(GENERATION_PATH, next);
  pinned = next;
  return next;
}

/** Test seam: forget the pin so a fresh "process" can be simulated in one test run. */
export function resetPinnedGeneration(): void {
  pinned = null;
}
