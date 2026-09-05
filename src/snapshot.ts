import { createHash, randomUUID } from "node:crypto";
import { dedupeHistory, type HistoryEntry } from "./history.js";
import type { Todo, TodoStore, Tombstone } from "./types.js";

/**
 * The logical form of a workspace, versioned, for moving one between local and self-hosted
 * without losing what makes it that workspace.
 *
 * The thing this replaces re-created every item through the ordinary create()/complete()
 * calls, and called the result a migration. What actually arrived on the other side was a
 * set of NEW items: new uuids, so every paired device saw the whole workspace deleted and a
 * different one appear; today's timestamps, so the chronology was gone; no history, so the
 * audit log was gone; and — after v3 made project structure the centre of the product — no
 * workspace, so everything collapsed into Unfiled. Each of those is silent. The user asked
 * to move their data to a new home and got a plausible-looking copy of the titles.
 *
 * What is deliberately NOT carried, and why:
 *
 *  - `id` and `localSeq` are per-store coordinates, not identity. The destination assigns
 *    its own; copying them would hand a store sequence numbers from a different sequence
 *    space, which is exactly the "peer cursor above the rebuilt counter" failure that makes
 *    a paired device go deaf.
 *  - The claim fields (workingAgent, workingSince, workingSession, workingLeaseExpiresAt,
 *    workingDeviceId) are cleared, as an explicit policy rather than an oversight. A claim
 *    says "an agent is working on this right now, on that device"; it is a statement about
 *    a running process, and moving the store to a new home does not move the process. A
 *    stale claim would block work until its lease expired, on a workspace that has just
 *    been migrated precisely so someone can start working on it.
 *
 * Everything else — uuid, workspace, content, chronology, completion, revision,
 * provenance, per-field timestamps, full history, tombstones — is carried verbatim.
 */
export const SNAPSHOT_FORMAT = 1;

/** A todo as it travels: everything except the destination's own coordinates. */
export type SnapshotItem = Omit<
  Todo,
  "id" | "localSeq" | "history" | "workingAgent" | "workingSince" | "workingSession" | "workingLeaseExpiresAt" | "workingDeviceId"
>;

export type SnapshotTombstone = Omit<Tombstone, "localSeq">;

export interface WorkspaceSnapshot {
  snapshotFormat: number;
  /**
   * Stable across every retry of ONE migration, and the reason an interrupted transfer can
   * simply be run again. The destination records the ids it has applied, so a retry after a
   * connection died halfway is a no-op rather than a second copy of everything that did
   * arrive — which was the old behaviour's other half: a failed migration left both sides
   * populated, and the retry then refused to continue and told the user to sort it out
   * themselves.
   */
  migrationId: string;
  createdAt: string;
  sourceDeviceId: string | null;
  items: SnapshotItem[];
  tombstones: SnapshotTombstone[];
  /** uuid → complete audit log, sidecar and inline merged. */
  history: Record<string, HistoryEntry[]>;
  /** SHA-256 over the canonical form of everything above. Detects a truncated or reordered transfer. */
  contentHash?: string;
}

const CLAIM_FIELDS = ["workingAgent", "workingSince", "workingSession", "workingLeaseExpiresAt", "workingDeviceId"] as const;

/**
 * A stable serialisation for hashing: object keys sorted at every level, so two snapshots
 * with the same content hash the same however their JSON happened to be built. Without
 * that the hash would depend on V8's property order and would be a coin toss across
 * versions rather than an integrity check.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function snapshotContentHash(snapshot: WorkspaceSnapshot): string {
  const { contentHash: _ignored, ...rest } = snapshot;
  return createHash("sha256").update(canonical(rest)).digest("hex");
}

function toSnapshotItem(todo: Todo): SnapshotItem {
  const { id: _id, localSeq: _localSeq, history: _history, ...rest } = todo;
  for (const field of CLAIM_FIELDS) delete (rest as Record<string, unknown>)[field];
  return rest as SnapshotItem;
}

/**
 * Builds a snapshot from a store plus the sidecar history log.
 *
 * `sidecar` is passed in rather than read here so this stays a pure function of its inputs
 * — the server builds one from its own store, the CLI from a repository's, and neither has
 * to agree with the other about where history lives.
 */
export function buildSnapshot(
  store: TodoStore,
  sidecar: Record<string, HistoryEntry[]>,
  sourceDeviceId: string | null,
  migrationId: string = randomUUID(),
): WorkspaceSnapshot {
  const history: Record<string, HistoryEntry[]> = {};
  for (const todo of store.todos) {
    const merged = dedupeHistory([...(sidecar[todo.uuid] ?? []), ...(todo.history ?? [])]);
    if (merged.length > 0) history[todo.uuid] = merged;
  }
  const snapshot: WorkspaceSnapshot = {
    snapshotFormat: SNAPSHOT_FORMAT,
    migrationId,
    createdAt: new Date().toISOString(),
    sourceDeviceId,
    items: store.todos.map(toSnapshotItem),
    tombstones: store.deletedUuids.map(({ uuid, deletedAt, deviceId }) => ({ uuid, deletedAt, deviceId })),
    history,
  };
  snapshot.contentHash = snapshotContentHash(snapshot);
  return snapshot;
}

export class SnapshotFormatError extends Error {}

/**
 * Rejects anything this build cannot faithfully apply, BEFORE a store is touched.
 *
 * A newer snapshotFormat is refused rather than best-effort imported: the whole point of
 * this type is that a migration does not quietly drop fields, and importing a format with
 * fields this build has never heard of would do exactly that.
 */
export function assertUsableSnapshot(snapshot: unknown): asserts snapshot is WorkspaceSnapshot {
  if (!snapshot || typeof snapshot !== "object") throw new SnapshotFormatError("not a workspace snapshot");
  const s = snapshot as Partial<WorkspaceSnapshot>;
  if (typeof s.snapshotFormat !== "number") throw new SnapshotFormatError("not a workspace snapshot");
  if (s.snapshotFormat > SNAPSHOT_FORMAT) {
    throw new SnapshotFormatError(
      `this snapshot was written by a newer docket (format ${s.snapshotFormat}, this build understands ${SNAPSHOT_FORMAT}) — ` +
        `upgrade docket on this side before migrating, rather than importing a workspace with fields this version would drop`,
    );
  }
  if (typeof s.migrationId !== "string" || !s.migrationId) throw new SnapshotFormatError("snapshot has no migration id");
  if (!Array.isArray(s.items) || !Array.isArray(s.tombstones)) throw new SnapshotFormatError("snapshot is missing its items");
  if (s.contentHash !== undefined && s.contentHash !== snapshotContentHash(s as WorkspaceSnapshot)) {
    throw new SnapshotFormatError("snapshot does not match its own content hash — the transfer was truncated or altered");
  }
}

export interface SnapshotApplyResult {
  imported: number;
  /** Items whose uuid was already present, and were therefore left alone. */
  alreadyPresent: number;
  tombstones: number;
  /** uuid → full history, for the caller to write into its own sidecar. */
  history: Record<string, HistoryEntry[]>;
}

/**
 * Merges a snapshot into a store, idempotently.
 *
 * Idempotence is by uuid, which is what makes an interrupted transfer safe to simply repeat:
 * an item that already arrived is counted and skipped, never duplicated. The destination
 * assigns its own `id` and `localSeq` — `stampSeq` is the caller's job, via the store's own
 * counter, because those coordinates only mean anything inside one store.
 */
export function applySnapshot(store: TodoStore, snapshot: WorkspaceSnapshot): SnapshotApplyResult {
  assertUsableSnapshot(snapshot);

  const byUuid = new Map(store.todos.map((t) => [t.uuid, t]));
  const tombstoned = new Set(store.deletedUuids.map((t) => t.uuid));
  let nextId = store.todos.reduce((max, t) => Math.max(max, t.id), 0) + 1;
  let counter = store.seqCounter ?? 0;
  const nextSeq = (): number => ++counter;

  let imported = 0;
  let alreadyPresent = 0;
  for (const item of snapshot.items) {
    if (byUuid.has(item.uuid)) {
      alreadyPresent += 1;
      continue;
    }
    // A uuid that is tombstoned here was deleted on this side after the snapshot was taken.
    // Re-adding it would resurrect a deletion, which is the one thing tombstones exist to
    // prevent — and a migration is not a merge, so it does not get to overrule that.
    if (tombstoned.has(item.uuid)) continue;

    const todo: Todo = {
      ...(item as Omit<Todo, "id" | "localSeq" | "history" | (typeof CLAIM_FIELDS)[number]>),
      id: nextId++,
      localSeq: nextSeq(),
      history: snapshot.history?.[item.uuid] ?? [],
      workingAgent: null,
      workingSince: null,
      workingSession: null,
      workingLeaseExpiresAt: null,
      workingDeviceId: null,
    };
    store.todos.push(todo);
    byUuid.set(todo.uuid, todo);
    imported += 1;
  }

  let tombstones = 0;
  for (const stone of snapshot.tombstones) {
    if (tombstoned.has(stone.uuid)) continue;
    store.deletedUuids.push({ ...stone, localSeq: nextSeq() });
    tombstoned.add(stone.uuid);
    tombstones += 1;
    // A tombstone that arrives for an item this side still holds removes it, exactly as it
    // would in a sync merge — otherwise a migration silently resurrects deleted work.
    const index = store.todos.findIndex((t) => t.uuid === stone.uuid);
    if (index !== -1) store.todos.splice(index, 1);
  }

  store.seqCounter = counter;
  store.nextId = nextId;
  return { imported, alreadyPresent, tombstones, history: snapshot.history ?? {} };
}
