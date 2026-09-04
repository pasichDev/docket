import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Todo } from "./types.js";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-repository-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;

// storage.ts (and everything under it) resolves its on-disk paths from DOCKET_DATA_DIR at
// module-load time via a top-level await — it MUST be set before this dynamic import, not
// before a static one, or every test in this file would silently touch the real ~/.docket.
const { filterTodos, LocalTodoRepository, TodoNotFoundError, TodoConflictError, TodoClaimConflictError } = await import("./repository.js");

test.after(async () => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

function context(overrides: Partial<import("./repository.js").MutationContext> = {}) {
  return { agent: "claude-code", session: "sess-1", deviceId: "device-1", deviceName: "TestBox", ...overrides };
}

test("LocalTodoRepository.create: stamps revision=1 and is immediately visible via get/list", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "Buy milk" }, context());
  assert.equal(created.revision, 1);
  assert.equal(created.title, "Buy milk");

  const fetched = await repo.get(created.id);
  assert.equal(fetched?.uuid, created.uuid);

  const listed = await repo.list({});
  assert.ok(listed.some((t) => t.uuid === created.uuid));
});

test("LocalTodoRepository.get: resolves by numeric id or by the cross-device short id, same as findTodoByAnyId", async () => {
  const repo = new LocalTodoRepository();
  const { shortId } = await import("./mutations.js");
  const created = await repo.create({ title: "Findable" }, context());
  const byShort = await repo.get(shortId(created.uuid));
  assert.equal(byShort?.uuid, created.uuid);
  assert.equal(await repo.get(999_999), null);
});

test("LocalTodoRepository.get: also resolves by the full uuid (RFC §19 remote identity)", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "By uuid" }, context());
  const byUuid = await repo.get(created.uuid);
  assert.equal(byUuid?.id, created.id);
});

test("LocalTodoRepository.edit/complete/delete/release: expectedRevision matching the current revision succeeds", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "Versioned" }, context());
  const edited = await repo.edit(created.id, { title: "Versioned 2" }, context(), created.revision);
  assert.equal(edited.title, "Versioned 2");
  assert.equal(edited.revision, created.revision + 1);
});

test("LocalTodoRepository.edit: a stale expectedRevision throws TodoConflictError carrying the CURRENT item, without applying the edit", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "Contested edit" }, context());
  await repo.edit(created.id, { title: "First edit" }, context()); // bumps revision, so `created.revision` is now stale

  await assert.rejects(
    () => repo.edit(created.id, { title: "Stale edit" }, context(), created.revision),
    (err: unknown) => {
      assert.ok(err instanceof TodoConflictError);
      assert.equal(err.current.title, "First edit"); // the edit that actually landed
      return true;
    },
  );
  const stillCurrent = await repo.get(created.id);
  assert.equal(stillCurrent?.title, "First edit"); // rejected edit never applied
});

test("LocalTodoRepository.complete/delete/release: a stale expectedRevision throws TodoConflictError and doesn't mutate", async () => {
  const repo = new LocalTodoRepository();
  const c1 = await repo.create({ title: "A" }, context());
  await assert.rejects(() => repo.complete(c1.id, context(), 999), TodoConflictError);
  assert.equal((await repo.get(c1.id))?.done, false);

  const c2 = await repo.create({ title: "B" }, context());
  await repo.claim(c2.id, context()); // bump revision so the create-time revision is stale
  await assert.rejects(() => repo.release(c2.id, context(), c2.revision), TodoConflictError);

  const c3 = await repo.create({ title: "C" }, context());
  await repo.edit(c3.id, { title: "C2" }, context());
  await assert.rejects(() => repo.delete(c3.id, context(), c3.revision), TodoConflictError);
  assert.ok(await repo.get(c3.id)); // rejected delete never removed it
});

test("LocalTodoRepository.claim: requireFree without force throws TodoClaimConflictError when actively held by a DIFFERENT device (RFC §21)", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "Contested claim" }, context());
  await repo.claim(created.id, context({ agent: "codex", deviceId: "device-a" }));

  await assert.rejects(
    () => repo.claim(created.id, context({ agent: "claude-code", deviceId: "device-b" }), { requireFree: true }),
    (err: unknown) => {
      assert.ok(err instanceof TodoClaimConflictError);
      assert.equal(err.current.workingAgent, "codex");
      return true;
    },
  );
  assert.equal((await repo.get(created.id))?.workingAgent, "codex"); // rejected claim never took over
});

test("LocalTodoRepository.claim: requireFree conflicts on DEVICE identity, not the self-reported agent name (regression: two different devices reporting the same agent name — e.g. every \"claude-code\" client — must still conflict, since `agent` is an unauthenticated header on a remote server)", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "Same agent name, different device" }, context());
  await repo.claim(created.id, context({ agent: "claude-code", deviceId: "device-a" }));

  await assert.rejects(
    () => repo.claim(created.id, context({ agent: "claude-code", deviceId: "device-b" }), { requireFree: true }),
    TodoClaimConflictError,
  );
  assert.equal((await repo.get(created.id))?.workingDeviceId, "device-a"); // rejected claim never took over
});

test("LocalTodoRepository.claim: requireFree is a no-op renewal (not a conflict) when the SAME device re-claims its own active claim", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "Heartbeat" }, context());
  await repo.claim(created.id, context({ agent: "codex", deviceId: "device-a" }));

  const renewed = await repo.claim(created.id, context({ agent: "codex", deviceId: "device-a" }), { requireFree: true });
  assert.equal(renewed.todo.workingDeviceId, "device-a");
});

test("LocalTodoRepository.claim: requireFree + force still takes over an actively-held claim", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "Forceable" }, context());
  await repo.claim(created.id, context({ agent: "codex" }));

  const claimed = await repo.claim(created.id, context({ agent: "claude-code" }), { requireFree: true, force: true });
  assert.equal(claimed.previousAgent, "codex");
  assert.equal(claimed.todo.workingAgent, "claude-code");
});

test("LocalTodoRepository.claim: requireFree does NOT conflict on the same agent renewing its own claim", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "Renewable" }, context());
  await repo.claim(created.id, context({ agent: "codex", session: "s1" }));
  const renewed = await repo.claim(created.id, context({ agent: "codex", session: "s1" }), { requireFree: true });
  assert.equal(renewed.todo.workingAgent, "codex");
});

test("LocalTodoRepository.claim: without requireFree (the local/MCP default), always succeeds by taking over — unchanged behavior", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "Advisory" }, context());
  await repo.claim(created.id, context({ agent: "codex" }));
  const takeover = await repo.claim(created.id, context({ agent: "claude-code" }));
  assert.equal(takeover.previousAgent, "codex");
  assert.equal(takeover.todo.workingAgent, "claude-code");
});

test("LocalTodoRepository.edit: applies the patch and bumps revision", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "Original" }, context());
  const edited = await repo.edit(created.id, { title: "Updated" }, context());
  assert.equal(edited.title, "Updated");
  assert.equal(edited.revision, created.revision + 1);
});

test("LocalTodoRepository.complete/release/claim: bump revision on every mutation, same as touch(store, ) always has", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "Task" }, context());

  const claimed = await repo.claim(created.id, context());
  assert.equal(claimed.previousAgent, null);
  assert.equal(claimed.todo.revision, created.revision + 1);

  const released = await repo.release(created.id, context());
  assert.equal(released.revision, claimed.todo.revision + 1);

  const completed = await repo.complete(created.id, context());
  assert.equal(completed.done, true);
  assert.equal(completed.revision, released.revision + 1);
});

test("LocalTodoRepository.claim: reports the previous claimant it took over, same as claimTodo(store, )", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "Contested" }, context());
  await repo.claim(created.id, context({ agent: "codex" }));
  const takeover = await repo.claim(created.id, context({ agent: "claude-code" }));
  assert.equal(takeover.previousAgent, "codex");
});

test("LocalTodoRepository.delete: returns the removed item and it disappears from list()", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "Doomed" }, context());
  const removed = await repo.delete(created.id, context());
  assert.equal(removed.uuid, created.uuid);
  const listed = await repo.list({});
  assert.ok(!listed.some((t) => t.uuid === created.uuid));
});

test("LocalTodoRepository.history: returns the create entry, and grows with each mutation", async () => {
  const repo = new LocalTodoRepository();
  const created = await repo.create({ title: "Tracked" }, context());
  assert.equal((await repo.history(created.id)).length, 1);
  await repo.edit(created.id, { title: "Tracked 2" }, context());
  assert.equal((await repo.history(created.id)).length, 2);
});

test("LocalTodoRepository.health: reports the current format version and item count", async () => {
  const repo = new LocalTodoRepository();
  const before = await repo.health();
  await repo.create({ title: "Counted" }, context());
  const after = await repo.health();
  assert.equal(after.ok, true);
  assert.equal(after.todoCount, before.todoCount + 1);
});

test("LocalTodoRepository: every mutating method throws TodoNotFoundError for an id that matches nothing", async () => {
  const repo = new LocalTodoRepository();
  const isNotFound = (err: unknown) => err instanceof TodoNotFoundError && err.id === 424_242;
  await assert.rejects(() => repo.edit(424_242, { title: "x" }, context()), isNotFound);
  await assert.rejects(() => repo.complete(424_242, context()), isNotFound);
  await assert.rejects(() => repo.delete(424_242, context()), isNotFound);
  await assert.rejects(() => repo.claim(424_242, context()), isNotFound);
  await assert.rejects(() => repo.release(424_242, context()), isNotFound);
  await assert.rejects(() => repo.history(424_242), isNotFound);
});

function todo(overrides: Partial<Todo>): Todo {
  return {
    id: 1,
    localSeq: 1,
    workspace: null,
    uuid: "u1",
    title: "x",
    description: null,
    done: false,
    list: "todo",
    category: null,
    priority: null,
    dueDate: null,
    sourceUrl: null,
    agent: null,
    session: null,
    workingAgent: null,
    workingSince: null,
    workingSession: null,
    workingLeaseExpiresAt: null,
    workingDeviceId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
    fieldTimestamps: {},
    completedAt: null,
    deviceId: null,
    deviceName: null,
    history: [],
    ...overrides,
  };
}

test("filterTodos: an empty query returns everything (matches the web UI's unfiltered GET /api/todos)", () => {
  const todos = [todo({ id: 1, done: false }), todo({ id: 2, done: true })];
  assert.equal(filterTodos(todos, {}).length, 2);
});

test("filterTodos: filter open/done restrict by done, list restricts by list, both combine", () => {
  const todos = [
    todo({ id: 1, done: false, list: "todo" }),
    todo({ id: 2, done: true, list: "todo" }),
    todo({ id: 3, done: false, list: "backlog" }),
  ];
  assert.deepEqual(filterTodos(todos, { filter: "open" }).map((t) => t.id), [1, 3]);
  assert.deepEqual(filterTodos(todos, { filter: "done" }).map((t) => t.id), [2]);
  assert.deepEqual(filterTodos(todos, { list: "backlog" }).map((t) => t.id), [3]);
  assert.deepEqual(filterTodos(todos, { filter: "open", list: "todo" }).map((t) => t.id), [1]);
});

test("filterTodos: category/agent/session/inProgress each restrict independently", () => {
  const active = todo({ id: 1, category: "VPQ", agent: "codex", session: "s1", workingAgent: "codex", workingLeaseExpiresAt: null });
  const other = todo({ id: 2, category: "other", agent: "claude-code", session: "s2" });
  const todos = [active, other];
  assert.deepEqual(filterTodos(todos, { category: "VPQ" }).map((t) => t.id), [1]);
  assert.deepEqual(filterTodos(todos, { agent: "codex" }).map((t) => t.id), [1]);
  assert.deepEqual(filterTodos(todos, { session: "s2" }).map((t) => t.id), [2]);
  assert.deepEqual(filterTodos(todos, { inProgress: true }).map((t) => t.id), [1]);
});
