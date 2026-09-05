import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, readFile, rename, rm, stat } from "node:fs/promises";
import { dataPath } from "./data-dir.js";
import { atomicCreateOrRead, atomicWriteFile } from "./fs-atomic.js";
import { decryptFromBuffer, encryptToBuffer } from "./crypto.js";
import { withFileLock, LeaseLostError, type Lease } from "./filelock.js";
import { flushOverflowHistory, pruneOrphanedHistory } from "./history-store.js";
import { log } from "./log.js";
import { shortId, stampSeq } from "./mutations.js";
import type { Todo, TodoStore } from "./types.js";
import { uuidv7 } from "./uuid7.js";

const STORE_PATH = await dataPath("todos.json.enc");
/** Pre-encryption path. Only read once, to migrate; never written again after that. */
const LEGACY_PLAINTEXT_PATH = await dataPath("todos.json");
const LOCK_PATH = `${STORE_PATH}.lock`;
/**
 * Which incarnation of this store peers are looking at. A random id, in plaintext beside
 * the store, minted on first use and re-minted whenever the store is bulk-replaced.
 *
 * `localSeq` is only meaningful within one incarnation: a peer's cursor is a number in this
 * store's counter space, and `docket restore` puts an older store — with a lower counter —
 * back in place. Every peer then sits above the new high-water mark and hears nothing from
 * this device again. The epoch is what lets the peer notice, because the peer is the side
 * that actually owns the cursor and the only side that can be wrong about it.
 *
 * Deliberately NOT inside the encrypted store, and deliberately NOT in a backup:
 *  - Outside the store, so `restore` can re-mint it by writing one small file, without
 *    decrypting anything or touching a key it would then hold stale (see backup.ts).
 *  - Outside the backup, so restoring onto NEW hardware also mints a fresh one — that case
 *    brings `peers.json.enc` back with it, so remote peers still hold cursors into the dead
 *    machine's sequence space, and a value carried along in the backup would match them.
 */
const STORE_EPOCH_PATH = await dataPath("store-epoch");
/**
 * A byte-for-byte copy of the store as it was immediately before the v7 → v8 migration.
 *
 * This exists because of what 2.x does, not what 3.0 does. v2.3.1's `saveStore` serialises
 * the store from its own v7 type shape: it has never heard of `localSeq`, `workspace` or
 * `seqCounter`, so if a user upgrades, migrates, then reinstalls 2.x — the natural reaction
 * to anything feeling off — its very first write STRIPS those fields from every item. A
 * later re-upgrade then hands out fresh sequence numbers, and every paired peer's cursor
 * means something different than it did. We cannot patch a released 2.3.1, so the only
 * defence is to keep the pre-migration bytes where a human can put them back.
 */
const PRE_UPGRADE_STORE_PATH = await dataPath("todos.v7-pre-upgrade.enc");

/** The last published release that reads format v7 — what `restore --from-v7` tells the user to reinstall. */
export const LAST_V7_RELEASE = "2.3.1";

/** Bump this whenever the Todo/TodoStore shape changes in a way old code would misread. */
export const CURRENT_FORMAT_VERSION = 8; // v8: localSeq/seqCounter (a per-device delivery cursor separate from updatedAt, so a record merged in from a peer — which lands stamped with the AUTHOR's older updatedAt — can still be handed on to a third device) and `workspace` (v7: workingDeviceId; v6: revision)

const EMPTY_STORE: TodoStore = { formatVersion: CURRENT_FORMAT_VERSION, nextId: 1, todos: [], deletedUuids: [], seqCounter: 0 };

/**
 * Reads the raw JSON text of the store, transparently migrating a pre-encryption
 * plaintext todos.json to the encrypted todos.json.enc on first read. The encrypted
 * file is durably written FIRST (atomic tmp+rename); only then is the plaintext
 * renamed away as a one-time safety backup — so a crash mid-migration never loses
 * data, and a concurrent reader always sees either the old or the fully-migrated
 * state, never a gap.
 */
async function readRawStoreJson(): Promise<string | null> {
  try {
    const encrypted = await readFile(STORE_PATH);
    return decryptFromBuffer(encrypted);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let plaintext: string;
  try {
    plaintext = await readFile(LEGACY_PLAINTEXT_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  log(`storage: migrating legacy plaintext todos.json -> encrypted todos.json.enc`);
  await atomicWriteFile(STORE_PATH, await encryptToBuffer(plaintext));
  try {
    await rename(LEGACY_PLAINTEXT_PATH, `${LEGACY_PLAINTEXT_PATH}.bak`);
  } catch (err) {
    // Another process already migrated and renamed it away concurrently — fine.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return plaintext;
}

async function loadStore(): Promise<TodoStore> {
  return (await loadStoreWithVersion()).store;
}

/** `fileVersion` is what was actually ON DISK, before migration rewrote it — 0 for a store that predates versioning, and absent entirely for a store that doesn't exist yet. */
async function loadStoreWithVersion(): Promise<{ store: TodoStore; fileVersion: number | null }> {
  const raw = await readRawStoreJson();
  if (raw === null) return { store: { ...EMPTY_STORE }, fileVersion: null };
  const parsed = JSON.parse(raw) as TodoStore;
  const fileVersion = parsed.formatVersion ?? 0;

  if (fileVersion > CURRENT_FORMAT_VERSION) {
    const msg =
      `docket: todos.json.enc is format v${fileVersion}, this process only understands up to ` +
      `v${CURRENT_FORMAT_VERSION} — it's running stale code. Rebuild (npm run build in ` +
      `~/repo/docket) and reconnect this MCP client / restart the web server before ` +
      `reading or writing, instead of guessing at unfamiliar fields.`;
    log(`loadStore: refusing stale read — ${msg}`);
    throw new Error(msg);
  }

  // Back-compat: todos written before the todo/backlog split have no `list`,
  // before categories have no `category`, before agent/session tracking have
  // neither, before the title/description split have `text` instead of `title`,
  // before device-sync have no uuid/updatedAt/deviceId/deviceName, before
  // field-level merge have no fieldTimestamps/workingLeaseExpiresAt.
  parsed.todos = parsed.todos.map((raw: Todo & { text?: string }) => {
    const { text, ...todo } = raw;
    return {
      ...todo,
      uuid: todo.uuid ?? uuidv7(),
      title: todo.title ?? text ?? "",
      description: todo.description ?? null,
      list: todo.list ?? "todo",
      category: todo.category ?? null,
      priority: todo.priority ?? null,
      dueDate: todo.dueDate ?? null,
      sourceUrl: todo.sourceUrl ?? null,
      agent: todo.agent ?? null,
      session: todo.session ?? null,
      workingAgent: todo.workingAgent ?? null,
      workingSince: todo.workingSince ?? null,
      workingSession: todo.workingSession ?? null,
      workingLeaseExpiresAt: todo.workingLeaseExpiresAt ?? null,
      workingDeviceId: todo.workingDeviceId ?? null,
      updatedAt: todo.updatedAt ?? todo.createdAt ?? new Date().toISOString(),
      revision: todo.revision ?? 1,
      fieldTimestamps: todo.fieldTimestamps ?? {},
      deviceId: todo.deviceId ?? null,
      deviceName: todo.deviceName ?? null,
      history: (todo.history ?? []).map((h) => ({ ...h, deviceName: h.deviceName ?? null })),
      localSeq: todo.localSeq ?? 0, // 0 = "not yet assigned"; backfilled below
      // Deliberately NOT guessed for legacy items. There is no honest way to know which
      // project a v7 item came from, and a wrong workspace hides an item somewhere its
      // author will never look — strictly worse than an "Unfiled" bucket they can see.
      workspace: todo.workspace ?? null,
    };
  });
  parsed.deletedUuids = (parsed.deletedUuids ?? []).map((t) => ({ ...t, localSeq: t.localSeq ?? 0 }));
  backfillLocalSeq(parsed);
  parsed.formatVersion = CURRENT_FORMAT_VERSION;
  return { store: parsed, fileVersion };
}

/**
 * Copies the pre-migration store aside, once, before the first write that would persist a
 * newer format. `COPYFILE_EXCL` is the whole mechanism: if the file is already there the
 * migration already happened, and overwriting it would replace the last v7 bytes with
 * post-migration ones — destroying the one thing it exists to protect.
 *
 * The at-rest key is deliberately NOT copied: it is a single unversioned `key` file that
 * 2.x and 3.0 read identically, so the backup decrypts with whatever key is present.
 */
async function backUpBeforeUpgrade(fileVersion: number): Promise<void> {
  try {
    await copyFile(STORE_PATH, PRE_UPGRADE_STORE_PATH, constants.COPYFILE_EXCL);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return; // already taken; never overwrite
    // Not fatal: failing the user's first write because a safety copy couldn't be made
    // would be worse than proceeding. Loud, though — this is the one line that tells them
    // the net exists.
    log(`storage: could not write the pre-upgrade backup at ${PRE_UPGRADE_STORE_PATH}: ${(err as Error).message}`);
    return;
  }
  const message =
    `docket: migrating this store from data format v${fileVersion} to v${CURRENT_FORMAT_VERSION}. ` +
    `A copy of the v${fileVersion} store was saved to ${PRE_UPGRADE_STORE_PATH} — if you need to go back to ` +
    `docket ${LAST_V7_RELEASE}, run \`docket restore --from-v7\` FIRST. Downgrading without it silently ` +
    `strips the new fields from every item.`;
  log(message);
  process.stderr.write(`${message}\n`);
}

/**
 * v7 → v8: hand every pre-existing record a delivery sequence number.
 *
 * The order has to be STABLE, not merely valid, because this runs on every READ and
 * readStore() is lock-free: between an upgrade and the first locked write, the MCP process
 * and the web server can each backfill the same v7 store in memory, and if they disagreed
 * about which item got which number, whichever wrote first would decide — while the other
 * had already answered a sync request using the other numbering. Sorting by creation time
 * with `uuid` as the tiebreak makes every process reach the same answer without
 * coordinating. Records that already have a number keep it, so a number a peer may already
 * have used as a cursor is never reassigned underneath it.
 */
function backfillLocalSeq(store: TodoStore): void {
  let counter = store.seqCounter ?? 0;
  for (const t of store.todos) counter = Math.max(counter, t.localSeq ?? 0);
  for (const t of store.deletedUuids) counter = Math.max(counter, t.localSeq ?? 0);
  store.seqCounter = counter;

  const byCreation = store.todos
    .filter((t) => !t.localSeq)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.uuid.localeCompare(b.uuid));
  const byDeletion = store.deletedUuids
    .filter((t) => !t.localSeq)
    .sort((a, b) => a.deletedAt.localeCompare(b.deletedAt) || a.uuid.localeCompare(b.uuid));
  for (const rec of [...byCreation, ...byDeletion]) stampSeq(store, rec);
}

/**
 * Identity of the store file as we read it — a hash of its actual bytes.
 *
 * This used to be (mtime, size), which is cheap and almost always right, and "almost" is
 * the problem: the guard exists precisely for the case where a suspended writer wakes up
 * after its lock was reaped, which is a rare path where being almost right is being wrong.
 * Two ciphertexts of the same store differ in content but very often not in LENGTH — the
 * plaintext is JSON whose size barely moves for a field edit, and AES-GCM adds a fixed
 * overhead — and mtime granularity is one second on some filesystems and coarser on others.
 * A stale writer could satisfy both and overwrite a newer store.
 *
 * Hashing the ciphertext costs one read of a file this process is about to rewrite anyway,
 * and cannot collide by accident.
 */
type StoreStamp = string | null;

async function stampOf(): Promise<StoreStamp> {
  try {
    return createHash("sha256").update(await readFile(STORE_PATH)).digest("hex");
  } catch {
    return null; // no store yet — "unchanged" then means "still absent"
  }
}

function sameStamp(a: StoreStamp, b: StoreStamp): boolean {
  return a === b;
}

async function saveStore(store: TodoStore, expected: StoreStamp, lease: Lease): Promise<void> {
  store.formatVersion = CURRENT_FORMAT_VERSION;
  const encrypted = await encryptToBuffer(JSON.stringify(store, null, 2));

  // Two independent checks, because they catch different things.
  //
  // The lease says "this process still holds the lock it took" — it catches a reap that has
  // already happened, cheaply and by identity.
  //
  // The stamp says "the bytes are the ones this operation read" — it catches a lost update
  // whatever its cause, including one that left the lock looking untouched. A process
  // suspended past the staleness threshold (laptop sleep, SIGSTOP) cannot heartbeat, gets
  // its lock reaped, and wakes still inside its own critical section; ownership checks on
  // the NEXT acquisition are too late for that one.
  //
  // Both raise the same LeaseLostError, and deliberately so: to withStore they mean one
  // thing — "the state you read is no longer the current state, run the mutation again."
  // Two exception types for one recovery would only invite a retry loop that handles one
  // and lets the other escape, which is exactly the bug that shipped when the lease check
  // was added to a loop that only knew about the stamp.
  await lease.assertOwned();
  if (!sameStamp(await stampOf(), expected)) {
    throw new LeaseLostError(LOCK_PATH);
  }
  await atomicWriteFile(STORE_PATH, encrypted);
}

let cachedEpoch: string | null = null;

/** This store's incarnation id, minted on first use. Cached — it changes only via resetStoreEpoch, which is out-of-process by nature (see backup.ts) and already requires a restart. */
export async function getStoreEpoch(): Promise<string> {
  if (cachedEpoch) return cachedEpoch;
  // Exclusive-create for the same reason as the at-rest key: two fresh processes racing here
  // would each cache a different epoch, and an epoch is what tells every paired device
  // whether its cursor into this store still means anything.
  const contents = await atomicCreateOrRead(
    STORE_EPOCH_PATH,
    () => Buffer.from(randomUUID()),
    (buf) => UUID_RE.test(buf.toString("utf8").trim()),
  );
  cachedEpoch = contents.toString("utf8").trim();
  return cachedEpoch;
}

/**
 * Puts the pre-migration (v7) store back, so a downgrade to 2.x has something to read that
 * it won't corrupt. Renames the current v8 store aside rather than deleting it, exactly as
 * `docket restore` does — a one-way restore would be its own trap.
 *
 * Returns null when there is no pre-upgrade backup: either this install was never migrated,
 * or it was migrated by a build that predates the backup.
 */
export async function restorePreUpgradeStore(): Promise<{ restoredFrom: string; movedAside: string } | null> {
  try {
    await stat(PRE_UPGRADE_STORE_PATH);
  } catch {
    return null;
  }
  const movedAside = `${STORE_PATH}.v8-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
  try {
    await rename(STORE_PATH, movedAside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await copyFile(PRE_UPGRADE_STORE_PATH, STORE_PATH);
  // The v8 side files mean nothing to 2.x and would be read back as authoritative on a
  // later re-upgrade, describing a store that no longer exists. Move them aside too.
  for (const path of [STORE_EPOCH_PATH, await dataPath("history.json.enc")]) {
    await rename(path, `${path}.v8.bak`).catch(() => {});
  }
  cachedEpoch = null;
  log(`storage: restored the pre-upgrade store from ${PRE_UPGRADE_STORE_PATH}; the v8 store is at ${movedAside}`);
  return { restoredFrom: PRE_UPGRADE_STORE_PATH, movedAside };
}

/**
 * Declares that this store is a different incarnation from the one peers last saw, so their
 * cursors into it are void. Called after any bulk replacement of the store — today only
 * `docket restore`. Peers re-download once, which is the correct outcome for what a bulk
 * replacement actually is.
 */
export async function resetStoreEpoch(): Promise<void> {
  cachedEpoch = randomUUID();
  await atomicWriteFile(STORE_EPOCH_PATH, cachedEpoch);
  log(`storage: store epoch reset to ${cachedEpoch} — paired devices will re-sync from scratch`);
}

/**
 * Runs `fn` with the on-disk store, holding a cross-process advisory lock
 * for the whole read-modify-write so concurrent MCP server instances (one
 * per Claude Code session) can't race and silently drop each other's writes.
 */
/**
 * How many times a read-modify-write is retried after losing a race. Two contenders resolve
 * in one retry; more than this means something is wrong that retrying won't fix.
 */
const MAX_WRITE_ATTEMPTS = 3;

export async function withStore<T>(fn: (store: TodoStore) => T | Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withFileLock(LOCK_PATH, async (lease) => {
        const expected = await stampOf();
        const { store, fileVersion } = await loadStoreWithVersion();
        // Before the first write that would persist a newer format — this is the only
        // moment the pre-migration bytes still exist.
        if (fileVersion !== null && fileVersion < CURRENT_FORMAT_VERSION) await backUpBeforeUpgrade(fileVersion);

        const tombstonesBefore = store.deletedUuids.length;
        const result = await fn(store);
        // Under the same lock as the store, and BEFORE it: see flushOverflowHistory for why
        // appending has to come first.
        await flushOverflowHistory(store);
        await saveStore(store, expected, lease);
        // ...and pruning has to come after, because saveStore above can still reject this
        // whole attempt and send it round the retry loop. Gated on the tombstone list having
        // actually grown — an O(1) check, so a write that deleted nothing never opens the
        // history file at all.
        if (store.deletedUuids.length !== tombstonesBefore) await pruneOrphanedHistory(store);
        return result;
      });
    } catch (err) {
      // `fn` is re-run against a freshly loaded store. Every caller in this codebase is a
      // pure mutation of the store it is handed, which is what makes that safe; a callback
      // with outside side effects would need to be idempotent.
      if (!(err instanceof LeaseLostError) || attempt >= MAX_WRITE_ATTEMPTS) {
        if (err instanceof LeaseLostError) {
          throw new Error(`docket: the store kept changing underneath this write (${MAX_WRITE_ATTEMPTS} attempts) — is another docket process stuck?`);
        }
        throw err;
      }
      log(`storage: lost a write race on attempt ${attempt}, retrying against the current store`);
    }
  }
}

/** True local-numeric-id-shaped input — anything else is tried as a short id (case-insensitive, "T-" optional). */
function isNumericId(id: number | string): id is number {
  return typeof id === "number" || /^\d+$/.test(id);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function findTodoByAnyId(store: TodoStore, id: number | string): Todo | undefined {
  if (isNumericId(id)) {
    const byNumeric = store.todos.find((t) => t.id === Number(id));
    // The short id charset includes digits, so an all-digit input (e.g. someone typed a
    // short id without its "T-" prefix) is numeric-shaped but not numeric-meant — fall
    // through to the short id match below instead of reporting "not found".
    if (byNumeric || typeof id === "number") return byNumeric;
  }
  // Full uuid, matched directly against identity — not through shortId(). Needed for the
  // remote API (RFC "Local and Self-Hosted Backend Modes" §19: uuid is the canonical remote
  // identity; the local numeric id must never be part of that protocol), and harmless to
  // accept everywhere else too since a bare uuid never collides with the short-id charset's
  // "T-XXXXXX" shape.
  if (typeof id === "string" && UUID_RE.test(id)) {
    const byUuid = store.todos.find((t) => t.uuid === id);
    if (byUuid) return byUuid;
  }
  const normalized = String(id).trim().toUpperCase();
  const withPrefix = normalized.startsWith("T-") ? normalized : `T-${normalized}`;
  return store.todos.find((t) => shortId(t.uuid) === withPrefix);
}

/**
 * `withStore` narrowed to the overwhelmingly common case: mutate the one item
 * matching this id (local numeric, or the cross-device short id — see
 * findTodoByAnyId) under the lock. Resolves to the item, or null if there is
 * no match — both entry points then turn that null into their own 404 wording.
 */
export async function withTodo(id: number | string, mutate: (item: Todo, store: TodoStore) => void): Promise<Todo | null> {
  return withStore((store) => {
    const item = findTodoByAnyId(store, id);
    if (!item) return null;
    mutate(item, store);
    return item;
  });
}

export async function readStore(): Promise<TodoStore> {
  return loadStore();
}

/**
 * loadStore()'s back-compat migration (uuid/fieldTimestamps/etc. for legacy items) only
 * fills gaps IN MEMORY — readStore() never saves. Call this once at process startup so
 * every item gets a uuid that's actually written to disk before anything can read or sync
 * it; otherwise a legacy item would get a FRESH random uuid on every lock-free read, and
 * syncing it to a peer at two different moments would look like two different items —
 * silent duplication of real data, not just a cosmetic gap.
 */
export async function migrateLegacyFields(): Promise<void> {
  await withStore(() => {});
}
