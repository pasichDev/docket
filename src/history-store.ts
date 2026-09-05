import { readFile } from "node:fs/promises";
import { decryptFromBuffer, encryptToBuffer } from "./crypto.js";
import { dedupeHistory, HISTORY_FLUSH_THRESHOLD, HISTORY_INLINE_MAX, type HistoryEntry } from "./history.js";
import { log } from "./log.js";
import type { TodoStore } from "./types.js";
import { dataPath } from "./data-dir.js";
import { atomicWriteFile } from "./fs-atomic.js";

const HISTORY_PATH = await dataPath("history.json.enc");

/** The full audit log, keyed by todo uuid. Encrypted at rest exactly like the store — it describes the same work. */
export type HistoryLog = Record<string, HistoryEntry[]>;

/**
 * `readable: false` means the file exists but could not be read — a wrong key mid-restore,
 * a truncated write, a permissions change. Distinguished from "not there yet" because the
 * two demand opposite behaviour: an absent log is safe to create, an unreadable one must
 * never be overwritten with a fresh empty object, which would turn a recoverable file into
 * a permanently lost one.
 */
interface HistoryLogRead {
  entries: HistoryLog;
  readable: boolean;
}

/**
 * History lives beside the store rather than inside it because of what a write costs.
 * Every mutation re-serialises, re-encrypts and rewrites the ENTIRE store, and history is
 * the only part of a Todo that grows without bound — so an item that has been worked on
 * all week made every subsequent unrelated write to any item more expensive.
 *
 * Read lazily and only by the two callers that want the whole log (`todo_history` and the
 * web UI's detail panel); nothing on the list path touches this file at all, and the write
 * path touches it only once per HISTORY_FLUSH_THRESHOLD writes to a given item.
 */
export async function readHistoryLog(): Promise<HistoryLogRead> {
  try {
    return { entries: JSON.parse(await decryptFromBuffer(await readFile(HISTORY_PATH))) as HistoryLog, readable: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: {}, readable: true };
    // A corrupt or unreadable audit log must not take down the thing it audits. Losing
    // history is bad; refusing to list todos because history is unreadable is worse.
    log(`history: could not read ${HISTORY_PATH} (${(err as Error).message}) — continuing with inline history only`);
    return { entries: {}, readable: false };
  }
}

async function writeHistoryLog(logData: HistoryLog): Promise<void> {
  await atomicWriteFile(HISTORY_PATH, await encryptToBuffer(JSON.stringify(logData)));
}

/**
 * Folds a snapshot's audit log into this one, keeping both sides.
 *
 * Dedupe is by content (see dedupeHistory), which is what makes re-importing the same
 * snapshot after a failed transfer a no-op rather than a doubled log.
 */
export async function mergeHistoryLog(incoming: HistoryLog): Promise<void> {
  const uuids = Object.keys(incoming);
  if (uuids.length === 0) return;
  const { entries, readable } = await readHistoryLog();
  if (!readable) {
    log(`history: ${HISTORY_PATH} is unreadable — the imported audit log was not merged, and the items themselves are unaffected`);
    return;
  }
  for (const uuid of uuids) entries[uuid] = dedupeHistory([...(entries[uuid] ?? []), ...incoming[uuid]]);
  await writeHistoryLog(entries);
}

/**
 * Replaces the whole audit log, moving the current one aside first.
 *
 * Only for a bulk store replacement (`docket backend localize`, a snapshot import). The
 * sidecar is keyed by todo uuid and is a continuation of each item's inline history, so
 * leaving the old one beside a replaced store produces an audit log describing edits that
 * store does not contain, attached to items that may not exist — the same coupling `docket
 * restore` has to respect.
 */
export async function replaceHistoryLog(logData: HistoryLog, backupSuffix: string): Promise<void> {
  const { rename } = await import("node:fs/promises");
  await rename(HISTORY_PATH, `${HISTORY_PATH}.${backupSuffix}.bak`).catch(() => {});
  await writeHistoryLog(logData);
}

/**
 * Moves the accumulated inline history into the side file and trims each item back to the
 * preview length. Returns true when it trimmed something, i.e. when the caller now holds a
 * store that differs from the one on disk and has to commit it.
 *
 * Called from inside withStore's lock, AFTER the mutation itself has been committed. That
 * ordering is the fix for the phantom-event bug: this used to run before the commit, so an
 * attempt that lost the optimistic-concurrency check left its entries in the audit log and
 * then re-ran the mutation, permanently recording an edit that never happened.
 *
 * Within this function the order is still append-then-trim, and for the original reason:
 *
 *  - A crash between the append and the caller's follow-up commit leaves the side file
 *    holding entries the store still has inline too, which the dedupe on the next flush
 *    absorbs. The reverse would drop exactly the entries that had just been trimmed away.
 *  - A failed side-file write leaves the store untrimmed rather than trimmed-and-lost. The
 *    mutation itself still succeeds: history is an audit log, and failing a user's edit
 *    because its audit entry couldn't be filed would be the wrong trade.
 *  - An UNREADABLE side file is never overwritten, only skipped, so a transient decryption
 *    failure doesn't turn into permanent data loss.
 *
 * Either way history can lag the store by one write; docs/security.md §5 says so out loud.
 */
export async function flushOverflowHistory(store: TodoStore): Promise<boolean> {
  const overflowing = store.todos.filter((t) => (t.history?.length ?? 0) > HISTORY_FLUSH_THRESHOLD);
  if (overflowing.length === 0) return false; // the common case: no file touched, nothing allocated

  const { entries: logData, readable } = await readHistoryLog();
  if (!readable) return false;

  for (const todo of overflowing) logData[todo.uuid] = dedupeHistory([...(logData[todo.uuid] ?? []), ...todo.history]);

  try {
    await writeHistoryLog(logData);
  } catch (err) {
    log(`history: could not write ${HISTORY_PATH} (${(err as Error).message}) — keeping history inline for now`);
    return false; // nothing trimmed, so nothing lost; the next write tries again
  }
  for (const todo of overflowing) todo.history = todo.history.slice(-HISTORY_INLINE_MAX);
  return true;
}

/**
 * Drops the side-file history of items that are gone for good. Runs AFTER the store commit,
 * unlike the flush above, and the asymmetry is the point:
 *
 *  - appending is idempotent, so doing it before the commit costs at worst some duplicate
 *    entries that the next flush's dedupe absorbs — which is what buys the crash-safety
 *    ordering described above;
 *  - deleting is not. withStore's write is optimistic and retries when another process got
 *    there first, so a prune done before the commit could delete the audit log of an item
 *    that the winning write had kept alive — a deletion that lost to a newer edit leaves
 *    both tombstone and item behind (see mergeSyncPayload). Nothing brings that log back.
 *
 * The cost of the later position is that a crash between the commit and this leaves an
 * orphaned log entry behind. The next delete's prune collects it.
 */
export async function pruneOrphanedHistory(store: TodoStore): Promise<void> {
  // Keyed on tombstoned uuids that are ACTUALLY gone, never on the tombstone alone.
  const live = new Set(store.todos.map((t) => t.uuid));
  const orphaned = store.deletedUuids.filter((t) => !live.has(t.uuid)).map((t) => t.uuid);
  if (orphaned.length === 0) return;

  const { entries: logData, readable } = await readHistoryLog();
  if (!readable) return;

  let removed = false;
  // An item's audit log outliving the item would keep describing work the user asked us to
  // forget.
  for (const uuid of orphaned) {
    if (uuid in logData) {
      delete logData[uuid];
      removed = true;
    }
  }
  if (!removed) return;

  try {
    await writeHistoryLog(logData);
  } catch (err) {
    log(`history: could not prune ${HISTORY_PATH} (${(err as Error).message}) — retrying on the next delete`);
  }
}

/**
 * The complete log for one item: the side file plus whatever is still inline, deduped.
 * Both halves are needed — an item that has never overflowed has nothing in the side file
 * at all, and one that has holds its most recent entries only inline.
 */
export async function fullHistoryFor(uuid: string, inline: HistoryEntry[]): Promise<HistoryEntry[]> {
  const { entries } = await readHistoryLog();
  return dedupeHistory([...(entries[uuid] ?? []), ...(inline ?? [])]);
}
