import { dataPath } from "../data-dir.js";
import { atomicWriteFile } from "../fs-atomic.js";
import { readFile } from "node:fs/promises";
import { withFileLock } from "../filelock.js";
import { assertSameGeneration } from "../generation.js";

/**
 * Which snapshot imports this store has already applied.
 *
 * The point of recording them is that a migration is a network operation and networks fail
 * halfway. Without this, the only honest thing a retry could do was refuse — the previous
 * behaviour, which left both sides populated and told the user to sort it out by hand. With
 * it, a retry of the same migration is a no-op that reports what already landed, so
 * "run it again" is always the right advice.
 *
 * Plaintext, deliberately: it holds migration ids and counts, no user content, and it must
 * be readable by a process that has just been handed a snapshot and needs to decide whether
 * to apply it — before anything is decrypted.
 */
const APPLIED_PATH = await dataPath("applied-migrations.json");
const LOCK_PATH = `${APPLIED_PATH}.lock`;

/** How many ids to remember. Far more than any real sequence of migrations, and bounded so this file cannot grow without limit. */
const MAX_REMEMBERED = 200;

export interface AppliedMigration {
  migrationId: string;
  appliedAt: string;
  imported: number;
  alreadyPresent: number;
  tombstones: number;
}

async function readApplied(): Promise<AppliedMigration[]> {
  try {
    const parsed = JSON.parse(await readFile(APPLIED_PATH, "utf8")) as AppliedMigration[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function findAppliedMigration(migrationId: string): Promise<AppliedMigration | null> {
  return (await readApplied()).find((m) => m.migrationId === migrationId) ?? null;
}

export async function recordAppliedMigration(entry: AppliedMigration): Promise<void> {
  await withFileLock(LOCK_PATH, async (lease) => {
    const applied = await readApplied();
    if (applied.some((m) => m.migrationId === entry.migrationId)) return;
    applied.push(entry);
    await lease.assertOwned();
    await assertSameGeneration();
    await atomicWriteFile(APPLIED_PATH, JSON.stringify(applied.slice(-MAX_REMEMBERED), null, 2));
  });
}
