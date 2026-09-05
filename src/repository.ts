import type { HistoryEntry } from "./history.js";
import {
  applyEdits,
  claimTodo,
  completeTodo,
  createTodo,
  isClaimActive,
  releaseTodo,
  tombstoneDelete,
  type NewTodoInput,
  type TodoPatch,
} from "./mutations.js";
import { fullHistoryFor } from "./history-store.js";
import { findTodoByAnyId, readStore, withStore, withTodo } from "./storage.js";
import type { Todo, TodoList } from "./types.js";
import { buildSnapshot, applySnapshot, assertUsableSnapshot, type WorkspaceSnapshot } from "./snapshot.js";

/** The local numeric id (only meaningful on THIS device) or the cross-device short id — see findTodoByAnyId in storage.ts. */
export type TodoId = number | string;

export interface TodoQuery {
  filter?: "open" | "done" | "all";
  list?: TodoList | "all";
  category?: string;
  agent?: string;
  session?: string;
  inProgress?: boolean;
  /**
   * Project scope:
   *  - omitted → no restriction at all (what the web UI's own unfiltered list wants);
   *  - `"*"`   → everything, said explicitly;
   *  - a slug  → that workspace PLUS unfiled items. The unfiled items ride along
   *              deliberately: they are legacy or context-free, and dropping them would make
   *              an agent's default list quietly HIDE work rather than scope it.
   *
   * There is deliberately no "only unfiled" value. The dashboard's Unfiled view filters the
   * list it already holds, so adding one would be a fourth meaning on a shared field with no
   * caller — and the first real need ("these two projects", "this one without unfiled")
   * should split this into two fields rather than invent a fifth magic string.
   */
  workspace?: string | "*";
}

/**
 * Who's making the call and from where — every mutating TodoRepository method takes one,
 * so identity/provenance stamping (agent, session, device) lives at one call boundary
 * instead of being threaded through as separate positional arguments the way the older
 * mutations.ts functions still take them.
 */
export interface MutationContext {
  agent: string | null;
  session: string | null;
  deviceId: string;
  deviceName: string;
  /**
   * The project this caller is working in, derived (never asked for) — see src/workspace.ts.
   * Optional because not every caller has a project context: the web UI is one shared
   * dashboard, not a checkout, so its items are genuinely unfiled unless a workspace is
   * chosen in the switcher.
   */
  workspace?: string | null;
}

export type CreateTodoInput = Omit<NewTodoInput, "agent" | "session">;
export type EditTodoInput = TodoPatch;

export interface ClaimResult {
  todo: Todo;
  /** Whichever agent's still-active claim this call took over, or null if the item was free. Not part of the persisted Todo — surfaced only so a caller can show a "taking over from X" warning, same as todo_claim always has. */
  previousAgent: string | null;
}

export interface RepositoryHealth {
  ok: boolean;
  formatVersion: number;
  todoCount: number;
}

/** Thrown by a TodoRepository's mutating methods (edit/complete/delete/claim/release/history) when `id` matches nothing. A RemoteTodoRepository is expected to throw this for a 404 response, so callers only need one catch shape regardless of which repository they're talking to. */
export class TodoNotFoundError extends Error {
  constructor(public readonly id: TodoId) {
    super(`No todo with id #${id}`);
    this.name = "TodoNotFoundError";
  }
}

/**
 * Thrown by edit/complete/delete/claim/release when the caller passed `expectedRevision`
 * and the item's current revision doesn't match — RFC §18's optimistic-concurrency contract.
 * Carries the CURRENT item so a caller (the remote server's If-Match handling) can hand it
 * back to the client without a second read. Only thrown when a caller opts in by passing
 * `expectedRevision`; every existing MCP/web call site omits it, so this never fires for them.
 */
export class TodoConflictError extends Error {
  constructor(public readonly current: Todo) {
    super(`revision conflict: current revision is ${current.revision}`);
    this.name = "TodoConflictError";
  }
}

/**
 * Thrown by claim() when `requireFree` is set, the item is actively claimed by a DIFFERENT
 * agent, and `force` wasn't also set — RFC §21's atomic claim semantics ("409 already_claimed").
 * Only the remote server opts into `requireFree`; local/MCP callers never pass it, so
 * todo_claim's existing always-succeeds "take over" behavior is completely unchanged.
 */
export class TodoClaimConflictError extends Error {
  constructor(public readonly current: Todo) {
    super(`already claimed by ${current.workingAgent}`);
    this.name = "TodoClaimConflictError";
  }
}

export interface ClaimOptions {
  /** RFC §18 optimistic concurrency: throw TodoConflictError instead of claiming if the item's current revision doesn't match. */
  expectedRevision?: number;
  /** RFC §21: throw TodoClaimConflictError instead of silently taking over an active claim held by a different agent. Opt-in only — omitted by every local/MCP caller. */
  requireFree?: boolean;
  /** With `requireFree`, take over an active claim anyway (explicit takeover) instead of conflicting. */
  force?: boolean;
}

/**
 * Formal storage boundary (RFC "Local and Self-Hosted Backend Modes", section 7). MCP
 * tools and the web API depend on this — never on storage.ts or mutations.ts directly —
 * so that a future RemoteTodoRepository (forwarding these same calls over HTTPS to a
 * `docket serve` instance) is a drop-in replacement with no caller-side changes.
 *
 * Every implementation must apply the SAME mutation semantics (edit validation, claim
 * leases, history, URL sanitisation, timestamps) — that logic lives once, in mutations.ts,
 * and only LocalTodoRepository calls it. A remote implementation relies on the far end's
 * own LocalTodoRepository to apply it identically; it must never reimplement it locally.
 */
export interface TodoRepository {
  list(query: TodoQuery): Promise<Todo[]>;
  get(id: TodoId): Promise<Todo | null>;

  create(input: CreateTodoInput, context: MutationContext): Promise<Todo>;

  /** `expectedRevision`, when passed, throws TodoConflictError (not applying the edit) if it doesn't match the item's current revision — RFC §18. Omitted by every local/MCP call site today. */
  edit(id: TodoId, input: EditTodoInput, context: MutationContext, expectedRevision?: number): Promise<Todo>;

  complete(id: TodoId, context: MutationContext, expectedRevision?: number): Promise<Todo>;

  /** Returns the removed item (its last in-memory state, tombstoned in the store) so callers can report what disappeared without a separate lookup. */
  delete(id: TodoId, context: MutationContext, expectedRevision?: number): Promise<Todo>;

  claim(id: TodoId, context: MutationContext, options?: ClaimOptions): Promise<ClaimResult>;

  release(id: TodoId, context: MutationContext, expectedRevision?: number): Promise<Todo>;

  history(id: TodoId): Promise<HistoryEntry[]>;

  health(): Promise<RepositoryHealth>;

  /**
   * The whole workspace in its logical form — uuids, workspaces, chronology, history and
   * tombstones intact. `list()` cannot stand in for this: it returns what a user reads, not
   * what makes the workspace the same workspace on the other side.
   */
  exportSnapshot(migrationId?: string): Promise<WorkspaceSnapshot>;

  /** Applies a snapshot, idempotently by migration id and by uuid, so a failed transfer is safe to simply repeat. */
  importSnapshot(snapshot: WorkspaceSnapshot): Promise<SnapshotImportResult>;
}

export interface SnapshotImportResult {
  migrationId: string;
  imported: number;
  alreadyPresent: number;
  tombstones: number;
  /** True when this exact migration had already been applied — the retry-after-failure case. */
  alreadyApplied: boolean;
}

/**
 * Query semantics shared by every TodoRepository.list() implementation — pulled out as a
 * pure function (rather than inlined in LocalTodoRepository) so the same filtering runs
 * identically whether it's applied to this device's own store or, later, to the
 * authoritative store behind a `docket serve` instance's own LocalTodoRepository.
 * Undefined/omitted query fields mean "no restriction on this dimension", not "match
 * nothing" — an empty TodoQuery returns every item, matching the web UI's existing
 * unfiltered GET /api/todos.
 */
export function filterTodos(todos: Todo[], query: TodoQuery): Todo[] {
  return todos.filter((todo) => {
    if (query.filter === "open" && todo.done) return false;
    if (query.filter === "done" && !todo.done) return false;
    if (query.list && query.list !== "all" && todo.list !== query.list) return false;
    if (query.category && todo.category !== query.category) return false;
    if (query.agent && todo.agent !== query.agent) return false;
    if (query.session && todo.session !== query.session) return false;
    if (query.inProgress && !isClaimActive(todo)) return false;
    if (query.workspace && query.workspace !== "*" && todo.workspace !== query.workspace && todo.workspace !== null) return false;
    return true;
  });
}

/**
 * Throws TodoConflictError (WITHOUT mutating anything) if `expected` is given and doesn't
 * match `item`'s current revision. Always called from inside a withStore/withTodo callback,
 * i.e. while still holding the cross-process file lock — so the check and the mutation that
 * follows it are atomic: no other request's write can land in between, and a matching
 * revision here really does mean the client last saw this exact state. Throwing here means
 * withStore's save (see storage.ts) never runs, so a rejected request leaves the store
 * untouched.
 */
function checkRevision(item: Todo, expected: number | undefined): void {
  if (expected !== undefined && item.revision !== expected) {
    throw new TodoConflictError(structuredClone(item));
  }
}

/**
 * TodoRepository backed by the existing encrypted-JSON + cross-process file-lock storage
 * (storage.ts). A genuine adapter, not a reimplementation: every read goes through
 * readStore(), every mutation through withStore()/withTodo(), exactly as the MCP tools and
 * web API called them directly before this class existed — so wrapping it here changes
 * nothing about on-disk format, locking, or migration behaviour.
 */
export class LocalTodoRepository implements TodoRepository {
  async list(query: TodoQuery): Promise<Todo[]> {
    const store = await readStore();
    return filterTodos(store.todos, query);
  }

  async get(id: TodoId): Promise<Todo | null> {
    const store = await readStore();
    return findTodoByAnyId(store, id) ?? null;
  }

  create(input: CreateTodoInput, context: MutationContext): Promise<Todo> {
    return withStore((store) =>
      createTodo(
        store,
        {
          ...input,
          agent: context.agent,
          session: context.session,
          // An explicit workspace on the input wins; otherwise the caller's own project is
          // stamped automatically. Nothing an agent has to remember to type, which is the
          // only way this field gets filled in reliably.
          workspace: input.workspace !== undefined ? input.workspace : (context.workspace ?? null),
        },
        context.deviceId,
        context.deviceName,
      ),
    );
  }

  async edit(id: TodoId, input: EditTodoInput, context: MutationContext, expectedRevision?: number): Promise<Todo> {
    const todo = await withTodo(id, (item, store) => {
      checkRevision(item, expectedRevision);
      applyEdits(store, item, input, context.agent, context.deviceId, context.deviceName);
    });
    if (!todo) throw new TodoNotFoundError(id);
    return todo;
  }

  async complete(id: TodoId, context: MutationContext, expectedRevision?: number): Promise<Todo> {
    const todo = await withTodo(id, (item, store) => {
      checkRevision(item, expectedRevision);
      completeTodo(store, item, context.agent, context.deviceId, context.deviceName);
    });
    if (!todo) throw new TodoNotFoundError(id);
    return todo;
  }

  async delete(id: TodoId, context: MutationContext, expectedRevision?: number): Promise<Todo> {
    const removed = await withTodo(id, (item, store) => {
      checkRevision(item, expectedRevision);
      tombstoneDelete(store, item, context.deviceId);
    });
    if (!removed) throw new TodoNotFoundError(id);
    return removed;
  }

  async claim(id: TodoId, context: MutationContext, options?: ClaimOptions): Promise<ClaimResult> {
    const claimed = await withStore((store) => {
      const item = findTodoByAnyId(store, id);
      if (!item) return null;
      checkRevision(item, options?.expectedRevision);
      // Opt-in only (RFC §21) — every local/MCP caller omits `requireFree`, so todo_claim's
      // existing "always succeeds, taking over" advisory behavior is completely unchanged.
      //
      // Keyed on workingDeviceId (stamped from context.deviceId, the HMAC-authenticated caller
      // identity — see server/auth.ts), NOT workingAgent/context.agent: `agent` is a self-reported
      // X-Docket-Agent header, so two different DEVICES that both happen to report the same agent
      // name (e.g. every "claude-code" client) would otherwise silently compare equal and bypass
      // this whole conflict check — defeating RFC §21's atomic-claim guarantee entirely.
      const activeHolderDeviceId = isClaimActive(item) ? item.workingDeviceId : null;
      if (options?.requireFree && activeHolderDeviceId && activeHolderDeviceId !== context.deviceId && !options.force) {
        throw new TodoClaimConflictError(structuredClone(item));
      }
      const previousAgent = claimTodo(store, item, context.agent, context.session, context.deviceId, context.deviceName);
      return { item, previousAgent };
    });
    if (!claimed) throw new TodoNotFoundError(id);
    return { todo: claimed.item, previousAgent: claimed.previousAgent };
  }

  async release(id: TodoId, context: MutationContext, expectedRevision?: number): Promise<Todo> {
    const todo = await withTodo(id, (item, store) => {
      checkRevision(item, expectedRevision);
      releaseTodo(store, item, context.agent, context.deviceId, context.deviceName);
    });
    if (!todo) throw new TodoNotFoundError(id);
    return todo;
  }

  async history(id: TodoId): Promise<HistoryEntry[]> {
    const store = await readStore();
    const item = findTodoByAnyId(store, id);
    if (!item) throw new TodoNotFoundError(id);
    // The item itself carries only the inline preview; the rest is in history.json.enc.
    // This is the one read path that pays for opening it, which is the point of the split.
    return fullHistoryFor(item.uuid, item.history);
  }

  async health(): Promise<RepositoryHealth> {
    const store = await readStore();
    return { ok: true, formatVersion: store.formatVersion, todoCount: store.todos.length };
  }

  async exportSnapshot(migrationId?: string): Promise<WorkspaceSnapshot> {
    const [store, { entries }, deviceId] = await Promise.all([
      readStore(),
      import("./history-store.js").then((m) => m.readHistoryLog()),
      import("./device.js").then((m) => m.getDeviceId()),
    ]);
    return buildSnapshot(store, entries, deviceId, migrationId);
  }

  async importSnapshot(snapshot: WorkspaceSnapshot): Promise<SnapshotImportResult> {
    assertUsableSnapshot(snapshot);
    const { findAppliedMigration, recordAppliedMigration } = await import("./server/migrations.js");
    const already = await findAppliedMigration(snapshot.migrationId);
    if (already) {
      // The retry-after-a-dead-connection case, and the reason it is safe to just run the
      // migration again: this reports what landed the first time instead of a second copy.
      return { ...already, alreadyApplied: true };
    }

    const result = await withStore((store) => applySnapshot(store, snapshot));
    await import("./history-store.js").then((m) => m.mergeHistoryLog(result.history));
    const entry = {
      migrationId: snapshot.migrationId,
      appliedAt: new Date().toISOString(),
      imported: result.imported,
      alreadyPresent: result.alreadyPresent,
      tombstones: result.tombstones,
    };
    // Recorded AFTER the store commit, never before: an id recorded for a migration that
    // then failed would make the retry a no-op and lose the whole workspace silently.
    await recordAppliedMigration(entry);
    return { ...entry, alreadyApplied: false };
  }
}
