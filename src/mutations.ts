import { diffDetail, pushHistory } from "./history.js";
import type { Todo, TodoList, TodoPriority, TodoStore } from "./types.js";
import { uuidv7 } from "./uuid7.js";

export interface NewTodoInput {
  title: string;
  description?: string | null;
  list?: TodoList;
  category?: string | null;
  priority?: TodoPriority | null;
  dueDate?: string | null;
  sourceUrl?: string | null;
  agent: string | null;
  session: string | null;
}

/**
 * `sourceUrl` is rendered as a clickable `href` in the web UI — escaping HTML
 * entities isn't enough, since `javascript:...` contains none and would still
 * execute on click. Only allow schemes that are inert to click (never `javascript:`,
 * `data:`, `vbscript:`, etc.).
 */
export function isSafeUrl(url: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Content/state fields eligible for per-field last-write-wins merging (see sync.ts). Identity/provenance fields (id, uuid, agent, session, createdAt, deviceId, deviceName, history) are never merged this way. */
export const FIELD_KEYS = [
  "title",
  "description",
  "category",
  "priority",
  "dueDate",
  "sourceUrl",
  "list",
  "done",
  "completedAt",
  "workingAgent",
  "workingSince",
  "workingSession",
  "workingLeaseExpiresAt",
] as const satisfies readonly (keyof Todo)[];
export type FieldKey = (typeof FIELD_KEYS)[number];

/** The four fields that describe one claim — always stamped together, so claim/release/complete can't drift apart. */
const CLAIM_FIELDS: readonly FieldKey[] = ["workingAgent", "workingSince", "workingSession", "workingLeaseExpiresAt"];

/** How long a claim survives without being renewed (a fresh todo_claim call) before it's treated as abandoned. */
export const CLAIM_LEASE_MS = 15 * 60_000;

/**
 * Single place that knows how to build a brand-new Todo — used by both the
 * MCP tools and the web API, so `uuid`/`updatedAt`/device stamping can never
 * drift between the two entry points (both matter for cross-device sync).
 */
export function createTodo(store: TodoStore, input: NewTodoInput, deviceId: string, deviceName: string): Todo {
  const now = new Date().toISOString();
  const todo: Todo = {
    id: store.nextId,
    uuid: uuidv7(),
    title: input.title,
    description: input.description ?? null,
    done: false,
    list: input.list ?? "todo",
    category: input.category ?? null,
    priority: input.priority ?? null,
    dueDate: input.dueDate ?? null,
    sourceUrl: input.sourceUrl && isSafeUrl(input.sourceUrl) ? input.sourceUrl : null,
    agent: input.agent,
    session: input.session,
    workingAgent: null,
    workingSince: null,
    workingSession: null,
    workingLeaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    fieldTimestamps: {},
    completedAt: null,
    deviceId,
    deviceName,
    history: [],
  };
  pushHistory(todo, input.agent, "created", `title: "${input.title}"`, deviceName);
  store.nextId += 1;
  store.todos.push(todo);
  return todo;
}

/**
 * Bump on every mutation to an existing item. `changedFields` stamps the
 * fine-grained per-field clock sync's merge compares — always pass the
 * fields you actually changed, not the whole FIELD_KEYS list, or two
 * independent edits to different fields will falsely look like a conflict.
 */
export function touch(item: Todo, deviceId: string, deviceName: string, changedFields: readonly FieldKey[] = []): void {
  const now = new Date().toISOString();
  item.updatedAt = now;
  item.deviceId = deviceId;
  item.deviceName = deviceName;
  item.fieldTimestamps = item.fieldTimestamps ?? {};
  for (const field of changedFields) item.fieldTimestamps[field] = now;
}

/**
 * One partial edit. A key left `undefined` is untouched; `null` clears the
 * field. Each entry point normalizes its own input convention first (the MCP
 * tools treat `""` as "clear", the web API treats an empty/invalid string the
 * same way) so this stays a plain "here are the new values" shape.
 */
export interface TodoPatch {
  title?: string;
  description?: string | null;
  category?: string | null;
  priority?: TodoPriority | null;
  dueDate?: string | null;
  sourceUrl?: string | null;
  list?: TodoList;
}

/** Patch order also fixes the order fields appear in the history diff line. */
const PATCH_FIELDS = ["title", "description", "category", "priority", "dueDate", "sourceUrl", "list"] as const;

/**
 * Applies only the fields the patch actually changes, records one "edited"
 * history entry describing the diff, and stamps the per-field clocks. Shared by
 * the MCP tool and the web API so an edit made from either side carries
 * identical history and merge metadata. Returns whether anything changed.
 */
export function applyEdits(
  item: Todo,
  patch: TodoPatch,
  agent: string | null,
  deviceId: string,
  deviceName: string,
): boolean {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of PATCH_FIELDS) {
    let next = patch[field];
    if (next === undefined) continue;
    if (field === "sourceUrl" && typeof next === "string" && !isSafeUrl(next)) next = null;
    if (next === item[field]) continue;
    changes[field] = { from: item[field], to: next };
    (item as unknown as Record<string, unknown>)[field] = next;
  }
  const changed = Object.keys(changes);
  if (changed.length === 0) return false;
  pushHistory(item, agent, "edited", diffDetail(changes), deviceName);
  touch(item, deviceId, deviceName, changed as FieldKey[]);
  return true;
}

function clearClaim(item: Todo): void {
  item.workingAgent = null;
  item.workingSince = null;
  item.workingSession = null;
  item.workingLeaseExpiresAt = null;
}

/** Marks the item as actively worked on by `agent`, returning whichever agent's still-active claim it took over (null if it was free). */
export function claimTodo(
  item: Todo,
  agent: string | null,
  session: string | null,
  deviceId: string,
  deviceName: string,
): string | null {
  const previousAgent = isClaimActive(item) ? item.workingAgent : null;
  item.workingAgent = agent;
  item.workingSince = new Date().toISOString();
  item.workingSession = session;
  item.workingLeaseExpiresAt = leaseExpiry();
  const detail = previousAgent && previousAgent !== agent ? `took over from ${previousAgent}` : "claimed";
  pushHistory(item, agent, "claimed", detail, deviceName);
  touch(item, deviceId, deviceName, CLAIM_FIELDS);
  return previousAgent;
}

/** Drops the claim without completing the item. */
export function releaseTodo(item: Todo, agent: string | null, deviceId: string, deviceName: string): void {
  clearClaim(item);
  pushHistory(item, agent, "released", "released", deviceName);
  touch(item, deviceId, deviceName, CLAIM_FIELDS);
}

/** Marks done and drops any claim — shared by the MCP tool and the web API so both stamp the same fields. */
export function completeTodo(item: Todo, agent: string | null, deviceId: string, deviceName: string): void {
  item.done = true;
  item.completedAt = new Date().toISOString();
  clearClaim(item);
  pushHistory(item, agent, "completed", "marked done", deviceName);
  touch(item, deviceId, deviceName, ["done", "completedAt", ...CLAIM_FIELDS]);
}

/** Removes the item and records why it disappeared, so a paired device doesn't resurrect it on next sync. */
export function tombstoneDelete(store: TodoStore, item: Todo, deviceId: string | null): void {
  store.deletedUuids = store.deletedUuids ?? [];
  store.deletedUuids.push({ uuid: item.uuid, deletedAt: new Date().toISOString(), deviceId });
  store.todos = store.todos.filter((t) => t.uuid !== item.uuid);
}

/** A claim is only meaningful while its lease hasn't expired — a device that vanished doesn't hold the item forever. */
export function isClaimActive(item: Pick<Todo, "workingAgent" | "workingLeaseExpiresAt">): boolean {
  if (!item.workingAgent) return false;
  if (!item.workingLeaseExpiresAt) return true; // back-compat: claims from before leases existed don't expire retroactively
  return item.workingLeaseExpiresAt > new Date().toISOString();
}

export function leaseExpiry(): string {
  return new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
}
