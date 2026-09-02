import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dataPath } from "./data-dir.js";
import { decryptFromBuffer, encryptToBuffer } from "./crypto.js";
import { withFileLock } from "./filelock.js";
import { log } from "./log.js";
import type { Todo, TodoStore } from "./types.js";
import { uuidv7 } from "./uuid7.js";

const STORE_PATH = await dataPath("todos.json.enc");
/** Pre-encryption path. Only read once, to migrate; never written again after that. */
const LEGACY_PLAINTEXT_PATH = await dataPath("todos.json");
const LOCK_PATH = `${STORE_PATH}.lock`;

/** Bump this whenever the Todo/TodoStore shape changes in a way old code would misread. */
export const CURRENT_FORMAT_VERSION = 5; // v5: added fieldTimestamps + workingLeaseExpiresAt, for field-level merge and self-expiring claims

const EMPTY_STORE: TodoStore = { formatVersion: CURRENT_FORMAT_VERSION, nextId: 1, todos: [], deletedUuids: [] };

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
  const tmpPath = `${STORE_PATH}.${randomUUID()}.tmp`;
  const encrypted = await encryptToBuffer(plaintext);
  await writeFile(tmpPath, encrypted, { mode: 0o600 });
  await rename(tmpPath, STORE_PATH);
  try {
    await rename(LEGACY_PLAINTEXT_PATH, `${LEGACY_PLAINTEXT_PATH}.bak`);
  } catch (err) {
    // Another process already migrated and renamed it away concurrently — fine.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return plaintext;
}

async function loadStore(): Promise<TodoStore> {
  const raw = await readRawStoreJson();
  if (raw === null) return { ...EMPTY_STORE };
  const parsed = JSON.parse(raw) as TodoStore;
  const fileVersion = parsed.formatVersion ?? 0;

  if (fileVersion > CURRENT_FORMAT_VERSION) {
    const msg =
      `todo-mcp: todos.json.enc is format v${fileVersion}, this process only understands up to ` +
      `v${CURRENT_FORMAT_VERSION} — it's running stale code. Rebuild (npm run build in ` +
      `~/repo/todo-mcp) and reconnect this MCP client / restart the web server before ` +
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
      updatedAt: todo.updatedAt ?? todo.createdAt ?? new Date().toISOString(),
      fieldTimestamps: todo.fieldTimestamps ?? {},
      deviceId: todo.deviceId ?? null,
      deviceName: todo.deviceName ?? null,
      history: (todo.history ?? []).map((h) => ({ ...h, deviceName: h.deviceName ?? null })),
    };
  });
  parsed.deletedUuids = parsed.deletedUuids ?? [];
  parsed.formatVersion = CURRENT_FORMAT_VERSION;
  return parsed;
}

async function saveStore(store: TodoStore): Promise<void> {
  store.formatVersion = CURRENT_FORMAT_VERSION;
  const tmpPath = `${STORE_PATH}.${randomUUID()}.tmp`;
  const encrypted = await encryptToBuffer(JSON.stringify(store, null, 2));
  await writeFile(tmpPath, encrypted, { mode: 0o600 });
  await rename(tmpPath, STORE_PATH);
}

/**
 * Runs `fn` with the on-disk store, holding a cross-process advisory lock
 * for the whole read-modify-write so concurrent MCP server instances (one
 * per Claude Code session) can't race and silently drop each other's writes.
 */
export async function withStore<T>(fn: (store: TodoStore) => T | Promise<T>): Promise<T> {
  return withFileLock(LOCK_PATH, async () => {
    const store = await loadStore();
    const result = await fn(store);
    await saveStore(store);
    return result;
  });
}

/**
 * `withStore` narrowed to the overwhelmingly common case: mutate the one item
 * with this id under the lock. Resolves to the item, or null if there is no
 * such id — both entry points then turn that null into their own 404 wording.
 */
export async function withTodo(id: number, mutate: (item: Todo, store: TodoStore) => void): Promise<Todo | null> {
  return withStore((store) => {
    const item = store.todos.find((t) => t.id === id);
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
