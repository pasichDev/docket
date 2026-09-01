import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { decryptFromBuffer, encryptToBuffer } from "./crypto.js";
import { log } from "./log.js";
import type { Todo, TodoStore } from "./types.js";

const STORE_PATH = join(homedir(), ".todo-mcp", "todos.json.enc");
/** Pre-encryption path. Only read once, to migrate; never written again after that. */
const LEGACY_PLAINTEXT_PATH = join(homedir(), ".todo-mcp", "todos.json");
const LOCK_PATH = `${STORE_PATH}.lock`;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 30;
const LOCK_TIMEOUT_MS = 5_000;

/** Bump this whenever the Todo/TodoStore shape changes in a way old code would misread. */
export const CURRENT_FORMAT_VERSION = 3; // v3: added workingSession (which host session holds a claim)

const EMPTY_STORE: TodoStore = { formatVersion: CURRENT_FORMAT_VERSION, nextId: 1, todos: [] };

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
  await mkdir(dirname(STORE_PATH), { recursive: true });
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
  // neither, before the title/description split have `text` instead of `title`.
  parsed.todos = parsed.todos.map((raw: Todo & { text?: string }) => {
    const { text, ...todo } = raw;
    return {
      ...todo,
      title: todo.title ?? text ?? "",
      description: todo.description ?? null,
      list: todo.list ?? "todo",
      category: todo.category ?? null,
      priority: todo.priority ?? null,
      dueDate: todo.dueDate ?? null,
      agent: todo.agent ?? null,
      session: todo.session ?? null,
      workingAgent: todo.workingAgent ?? null,
      workingSince: todo.workingSince ?? null,
      workingSession: todo.workingSession ?? null,
      history: todo.history ?? [],
    };
  });
  parsed.formatVersion = CURRENT_FORMAT_VERSION;
  return parsed;
}

async function saveStore(store: TodoStore): Promise<void> {
  store.formatVersion = CURRENT_FORMAT_VERSION;
  await mkdir(dirname(STORE_PATH), { recursive: true });
  const tmpPath = `${STORE_PATH}.${randomUUID()}.tmp`;
  const encrypted = await encryptToBuffer(JSON.stringify(store, null, 2));
  await writeFile(tmpPath, encrypted, { mode: 0o600 });
  await rename(tmpPath, STORE_PATH);
}

async function acquireLock(): Promise<void> {
  await mkdir(dirname(LOCK_PATH), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(LOCK_PATH, "wx");
      await handle.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Another process's lock — reap it if it's stale (crashed holder).
      try {
        const info = await stat(LOCK_PATH);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(LOCK_PATH, { force: true });
          continue;
        }
      } catch {
        continue; // lock disappeared between EEXIST and stat — retry immediately
      }
      if (Date.now() > deadline) {
        throw new Error(`todo-mcp: timed out waiting for lock at ${LOCK_PATH}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function releaseLock(): Promise<void> {
  await rm(LOCK_PATH, { force: true });
}

/**
 * Runs `fn` with the on-disk store, holding a cross-process advisory lock
 * for the whole read-modify-write so concurrent MCP server instances (one
 * per Claude Code session) can't race and silently drop each other's writes.
 */
export async function withStore<T>(fn: (store: TodoStore) => T | Promise<T>): Promise<T> {
  await acquireLock();
  try {
    const store = await loadStore();
    const result = await fn(store);
    await saveStore(store);
    return result;
  } finally {
    await releaseLock();
  }
}

export async function readStore(): Promise<TodoStore> {
  return loadStore();
}
