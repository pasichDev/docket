import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HistoryEntry } from "./history.js";
import type {
  ClaimOptions,
  ClaimResult,
  CreateTodoInput,
  EditTodoInput,
  MutationContext,
  RepositoryHealth,
  TodoId,
  TodoQuery,
  TodoRepository,
} from "./repository.js";
import type { Todo } from "./types.js";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-backend-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;

// Same reason repository.test.ts does this: storage.ts resolves its on-disk paths from
// DOCKET_DATA_DIR at module-load time via a top-level await, so DOCKET_DATA_DIR must be
// set before this dynamic import, not before a static one.
const { copyTodos } = await import("./backend.js");
const { LocalTodoRepository } = await import("./repository.js");

test.after(async () => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

function context(): MutationContext {
  return { agent: "docket-migration", session: null, deviceId: "device-1", deviceName: "TestBox" };
}

/** Records every create()/complete() call it receives, without needing a second real storage backend — copyTodos()'s contract (what it sends, in what order, whether done items get completed) is what's under test, not either side's own storage behaviour (already covered by repository.test.ts / client.test.ts). */
class FakeTargetRepository implements TodoRepository {
  created: CreateTodoInput[] = [];
  completed: TodoId[] = [];
  private nextId = 1;
  private items = new Map<number, Todo>();

  async list(_query: TodoQuery): Promise<Todo[]> {
    return [...this.items.values()];
  }
  async get(id: TodoId): Promise<Todo | null> {
    return this.items.get(Number(id)) ?? null;
  }
  async create(input: CreateTodoInput, _context: MutationContext): Promise<Todo> {
    this.created.push(input);
    const todo = {
      id: this.nextId++,
      uuid: `fake-uuid-${this.nextId}`,
      done: false,
      title: input.title,
      description: input.description ?? null,
      list: input.list ?? "todo",
      category: input.category ?? null,
      priority: input.priority ?? null,
      dueDate: input.dueDate ?? null,
      sourceUrl: input.sourceUrl ?? null,
    } as unknown as Todo;
    this.items.set(todo.id, todo);
    return todo;
  }
  async edit(_id: TodoId, _input: EditTodoInput, _context: MutationContext, _expectedRevision?: number): Promise<Todo> {
    throw new Error("not exercised by copyTodos");
  }
  async complete(id: TodoId, _context: MutationContext, _expectedRevision?: number): Promise<Todo> {
    this.completed.push(id);
    const todo = this.items.get(Number(id));
    if (!todo) throw new Error(`FakeTargetRepository.complete: no item #${id}`);
    todo.done = true;
    return todo;
  }
  async delete(_id: TodoId, _context: MutationContext, _expectedRevision?: number): Promise<Todo> {
    throw new Error("not exercised by copyTodos");
  }
  async claim(_id: TodoId, _context: MutationContext, _options?: ClaimOptions): Promise<ClaimResult> {
    throw new Error("not exercised by copyTodos");
  }
  async release(_id: TodoId, _context: MutationContext, _expectedRevision?: number): Promise<Todo> {
    throw new Error("not exercised by copyTodos");
  }
  async history(_id: TodoId): Promise<HistoryEntry[]> {
    return [];
  }
  async health(): Promise<RepositoryHealth> {
    return { ok: true, formatVersion: 1, todoCount: this.items.size };
  }
}

test("copyTodos: an empty source copies nothing (checked first — LocalTodoRepository's on-disk store is shared across this file's tests)", async () => {
  const target = new FakeTargetRepository();
  const count = await copyTodos(new LocalTodoRepository(), target, context());
  assert.equal(count, 0);
  assert.equal(target.created.length, 0);
});

test("copyTodos: re-creates every source item's content on the target, and completes items that were done", async () => {
  const source = new LocalTodoRepository();
  const ctx = context();
  await source.create({ title: "Open item", category: "work", priority: "high" }, ctx);
  const doneItem = await source.create({ title: "Done item", description: "desc", list: "backlog", sourceUrl: "https://example.com/x" }, ctx);
  await source.complete(doneItem.id, ctx);

  const target = new FakeTargetRepository();
  const count = await copyTodos(source, target, ctx);

  assert.equal(count, 2);
  assert.equal(target.created.length, 2);
  assert.deepEqual(target.created.map((c) => c.title).sort(), ["Done item", "Open item"]);
  // Exactly the done item's create() result got complete()'d — never the open one.
  assert.equal(target.completed.length, 1);

  const openCreated = target.created.find((c) => c.title === "Open item");
  assert.equal(openCreated?.category, "work");
  assert.equal(openCreated?.priority, "high");

  const doneCreated = target.created.find((c) => c.title === "Done item");
  assert.equal(doneCreated?.description, "desc");
  assert.equal(doneCreated?.list, "backlog");
  assert.equal(doneCreated?.sourceUrl, "https://example.com/x");
});
