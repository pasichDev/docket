import { createHash } from "node:crypto";
import { diffDetail, pushHistory } from "./history.js";
import type { Todo, TodoList, TodoPriority, TodoStore, Tombstone } from "./types.js";
import { uuidv7 } from "./uuid7.js";

// No 0/O, 1/I/L — same unambiguous charset as the pairing short codes.
const SHORT_ID_CHARSET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const SHORT_ID_LENGTH = 6;

/**
 * A short, human-typeable id derived from `uuid` — identical for the same item on every
 * device, unlike the numeric `id`, which is assigned locally by whichever device's store
 * first held the item and can differ across devices for the exact same synced todo. Never
 * stored: it's a pure function of `uuid`, so there's nothing to migrate or keep in sync.
 * Hashed rather than sliced directly from the uuid's own hex, because UUIDv7's first bits
 * are a timestamp — items created close together would otherwise share a long common
 * prefix instead of spreading evenly across the short id space.
 */
export function shortId(uuid: string): string {
  const digest = createHash("sha256").update(uuid).digest();
  let out = "";
  for (let i = 0; i < SHORT_ID_LENGTH; i++) out += SHORT_ID_CHARSET[digest[i] % SHORT_ID_CHARSET.length];
  return `T-${out}`;
}

/** Compact "agent@device" identity, e.g. "codex@ryzen" — one normalized form for CLI/MCP text output and presence, instead of each call site inventing its own "via X on Y" phrasing. */
export function formatAgentIdentity(agent: string | null, deviceName: string | null): string {
  const a = agent?.trim() || null;
  const d = deviceName?.trim() || null;
  if (a && d) return `${a}@${d}`;
  return a ?? d ?? "unknown";
}

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
  /** Resolved from the caller's project context, never typed by an agent — see src/workspace.ts. */
  workspace?: string | null;
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
  "workingDeviceId",
  // Merges per-field like any other content field: moving an item between workspaces on
  // one device must survive a concurrent unrelated edit on another.
  "workspace",
] as const satisfies readonly (keyof Todo)[];
export type FieldKey = (typeof FIELD_KEYS)[number];

/** The five fields that describe one claim — always stamped together, so claim/release/complete can't drift apart. */
const CLAIM_FIELDS: readonly FieldKey[] = ["workingAgent", "workingSince", "workingSession", "workingLeaseExpiresAt", "workingDeviceId"];

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
    workspace: input.workspace ?? null,
    workingAgent: null,
    workingSince: null,
    workingSession: null,
    workingLeaseExpiresAt: null,
    workingDeviceId: null,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    fieldTimestamps: {},
    completedAt: null,
    deviceId,
    deviceName,
    history: [],
    localSeq: 0, // replaced immediately by stampSeq below; never left at 0 in a saved store
  };
  stampSeq(store, todo);
  pushHistory(todo, input.agent, "created", `title: "${input.title}"`, deviceName);
  store.nextId += 1;
  store.todos.push(todo);
  return todo;
}

/**
 * Assigns this store's next delivery sequence number to a record. Called on every local
 * write — including accepting a peer's change during merge, which IS a local write even
 * though the content came from elsewhere. `store` is threaded through every mutation
 * helper rather than kept in a module-level counter precisely so this can't be forgotten:
 * a mutation path that doesn't have the store won't compile, instead of silently
 * producing a record no peer will ever be told about.
 */
export function stampSeq(store: TodoStore, rec: { localSeq: number }): void {
  store.seqCounter = (store.seqCounter ?? 0) + 1;
  rec.localSeq = store.seqCounter;
}

/**
 * Bump on every mutation to an existing item. `changedFields` stamps the
 * fine-grained per-field clock sync's merge compares — always pass the
 * fields you actually changed, not the whole FIELD_KEYS list, or two
 * independent edits to different fields will falsely look like a conflict.
 */
export function touch(store: TodoStore, item: Todo, deviceId: string, deviceName: string, changedFields: readonly FieldKey[] = []): void {
  // A write is BY DEFINITION later than the version it overwrites, and taking the wall clock
  // literally breaks that on a device whose clock lags. Such a device stamps its edit EARLIER
  // than the record it just changed; every peer then compares the two, judges its own copy
  // newer, and discards the edit — so the editing device is the only one in the mesh that
  // ever sees its own change, silently. If it then deletes the item, that is ignored too, and
  // the item is gone locally but alive everywhere else, permanently.
  //
  // Clamping forward costs nothing when the clock is fine. It is NOT a general answer to
  // clock skew — two devices editing different records still race on wall-clock order, which
  // is what remoteWinsTie makes at least deterministic. It enforces the narrower thing that
  // must hold regardless: one record's own history moves in one direction.
  const floor = changedFields.reduce((max, field) => {
    const at = item.fieldTimestamps?.[field];
    return at && at > max ? at : max;
  }, item.updatedAt ?? "");
  const wallClock = new Date().toISOString();
  const now = wallClock > floor ? wallClock : new Date(Date.parse(floor) + 1).toISOString();
  item.updatedAt = now;
  item.revision = (item.revision ?? 1) + 1;
  item.deviceId = deviceId;
  item.deviceName = deviceName;
  item.fieldTimestamps = item.fieldTimestamps ?? {};
  for (const field of changedFields) item.fieldTimestamps[field] = now;
  stampSeq(store, item);
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
  store: TodoStore,
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
  touch(store, item, deviceId, deviceName, changed as FieldKey[]);
  return true;
}

function clearClaim(item: Todo): void {
  item.workingAgent = null;
  item.workingSince = null;
  item.workingSession = null;
  item.workingLeaseExpiresAt = null;
  item.workingDeviceId = null;
}

/** Marks the item as actively worked on by `agent`, returning whichever agent's still-active claim it took over (null if it was free). */
/**
 * Doubles as the claim's heartbeat: the SAME claimant (agent + session) calling this
 * again on their own still-active claim just renews the lease — CLAIM_LEASE_MS is only
 * 15 minutes, too short for a long-running agent task to survive on a single claim.
 * `workingSince` is preserved across a renewal (only a genuinely NEW claim resets it),
 * so "claimed since" still reflects when the work actually started, not the last heartbeat.
 */
export function claimTodo(
  store: TodoStore,
  item: Todo,
  agent: string | null,
  session: string | null,
  deviceId: string,
  deviceName: string,
): string | null {
  const previousAgent = isClaimActive(item) ? item.workingAgent : null;
  const isRenewal = previousAgent !== null && previousAgent === agent && item.workingSession === session;
  if (!isRenewal) item.workingSince = new Date().toISOString();
  item.workingAgent = agent;
  item.workingSession = session;
  item.workingLeaseExpiresAt = leaseExpiry();
  item.workingDeviceId = deviceId;
  // A renewal writes no history on purpose. It is the ABSENCE of an event — the same agent,
  // in the same session, still on the same item — and at one heartbeat every few minutes per
  // active item it was the single biggest source of history growth, which the write path
  // pays for on every unrelated mutation. The claim's own fields still record who holds it
  // and until when, so nothing observable is lost.
  if (!isRenewal) {
    pushHistory(item, agent, "claimed", previousAgent && previousAgent !== agent ? `took over from ${previousAgent}` : "claimed", deviceName);
  }
  touch(store, item, deviceId, deviceName, CLAIM_FIELDS);
  return previousAgent;
}

/** Drops the claim without completing the item. */
export function releaseTodo(store: TodoStore, item: Todo, agent: string | null, deviceId: string, deviceName: string): void {
  clearClaim(item);
  pushHistory(item, agent, "released", "released", deviceName);
  touch(store, item, deviceId, deviceName, CLAIM_FIELDS);
}

/** Marks done and drops any claim — shared by the MCP tool and the web API so both stamp the same fields. */
export function completeTodo(store: TodoStore, item: Todo, agent: string | null, deviceId: string, deviceName: string): void {
  item.done = true;
  item.completedAt = new Date().toISOString();
  clearClaim(item);
  pushHistory(item, agent, "completed", "marked done", deviceName);
  touch(store, item, deviceId, deviceName, ["done", "completedAt", ...CLAIM_FIELDS]);
}

/** Removes the item and records why it disappeared, so a paired device doesn't resurrect it on next sync. */
export function tombstoneDelete(store: TodoStore, item: Todo, deviceId: string | null): void {
  store.deletedUuids = store.deletedUuids ?? [];
  // A deletion is BY DEFINITION later than the version it deletes, and taking the wall
  // clock literally breaks that on a device whose clock lags. Such a device writes a
  // tombstone stamped before the item's own `updatedAt`; every other device then compares
  // the two, judges the item newer than the deletion, and keeps it — so the delete is
  // silently ignored across the whole mesh while the deleting device, which removed it
  // locally, is the only one that loses it. It never gets it back either, because the
  // peers' copies sit below its delivery cursor by then.
  //
  // Ordering the tombstone after the record it supersedes costs nothing when the clock is
  // fine and is the entire fix when it isn't. It does not affect edit-after-delete: an edit
  // genuinely later than the deletion still wins and resurrects the item.
  const now = new Date().toISOString();
  const deletedAt = now > item.updatedAt ? now : new Date(Date.parse(item.updatedAt) + 1).toISOString();
  const tombstone: Tombstone = { uuid: item.uuid, deletedAt, deviceId, localSeq: 0 };
  stampSeq(store, tombstone);
  store.deletedUuids.push(tombstone);
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
