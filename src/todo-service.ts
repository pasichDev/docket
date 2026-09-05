import type { HistoryEntry } from "./history.js";
import {
  LocalTodoRepository,
  TodoNotFoundError,
  type ClaimOptions,
  type ClaimResult,
  type CreateTodoInput,
  type EditTodoInput,
  type MutationContext,
  type RepositoryHealth,
  type SnapshotImportResult,
  type TodoId,
  type TodoQuery,
  type TodoRepository,
} from "./repository.js";
import type { WorkspaceSnapshot } from "./snapshot.js";
import type { Todo } from "./types.js";

/**
 * Shared seam between callers (MCP tools in index.ts, the web API in web/api.ts, and —
 * in a later phase — the HTTP server's own route handlers) and a TodoRepository, per the
 * RFC's "TodoService" layer (section 8). The mutation RULES themselves are not here —
 * they live once in mutations.ts, invoked only by LocalTodoRepository — so this class
 * never reimplements edit validation, claim leases, history, or URL sanitisation.
 *
 * What it DOES own: translating a TodoNotFoundError from the repository into a plain
 * `null` return, so every caller keeps the exact `if (!result) { ...no todo with id... }`
 * shape it already had, instead of a try/catch at every call site. This is the one
 * seam later phases (If-Match/409 handling, permission checks) can extend without
 * touching MCP tool or web API call sites.
 */
export class TodoService {
  constructor(private readonly repository: TodoRepository) {}

  list(query: TodoQuery = {}): Promise<Todo[]> {
    return this.repository.list(query);
  }

  get(id: TodoId): Promise<Todo | null> {
    return this.repository.get(id);
  }

  create(input: CreateTodoInput, context: MutationContext): Promise<Todo> {
    return this.repository.create(input, context);
  }

  /** `expectedRevision` opts into RFC §18 optimistic concurrency — see TodoConflictError in repository.ts. Rejects with TodoConflictError/TodoClaimConflictError on conflict; only TodoNotFoundError is ever turned into `null`. */
  edit(id: TodoId, input: EditTodoInput, context: MutationContext, expectedRevision?: number): Promise<Todo | null> {
    return this.notFoundToNull(this.repository.edit(id, input, context, expectedRevision));
  }

  complete(id: TodoId, context: MutationContext, expectedRevision?: number): Promise<Todo | null> {
    return this.notFoundToNull(this.repository.complete(id, context, expectedRevision));
  }

  delete(id: TodoId, context: MutationContext, expectedRevision?: number): Promise<Todo | null> {
    return this.notFoundToNull(this.repository.delete(id, context, expectedRevision));
  }

  claim(id: TodoId, context: MutationContext, options?: ClaimOptions): Promise<ClaimResult | null> {
    return this.notFoundToNull(this.repository.claim(id, context, options));
  }

  release(id: TodoId, context: MutationContext, expectedRevision?: number): Promise<Todo | null> {
    return this.notFoundToNull(this.repository.release(id, context, expectedRevision));
  }

  history(id: TodoId): Promise<HistoryEntry[] | null> {
    return this.notFoundToNull(this.repository.history(id));
  }

  health(): Promise<RepositoryHealth> {
    return this.repository.health();
  }

  exportSnapshot(migrationId?: string): Promise<WorkspaceSnapshot> {
    return this.repository.exportSnapshot(migrationId);
  }

  importSnapshot(snapshot: WorkspaceSnapshot): Promise<SnapshotImportResult> {
    return this.repository.importSnapshot(snapshot);
  }

  private async notFoundToNull<T>(promise: Promise<T>): Promise<T | null> {
    try {
      return await promise;
    } catch (err) {
      if (err instanceof TodoNotFoundError) return null;
      throw err;
    }
  }
}

/** Process-wide default: MCP tools and the web API both talk to the same on-disk store through the same instance. A future remote mode swaps this for `new TodoService(new RemoteTodoRepository(...))` without either caller changing. */
export const todoService = new TodoService(new LocalTodoRepository());
