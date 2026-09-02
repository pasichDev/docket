import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-todo-service-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;

// Same reason as repository.test.ts: storage.ts resolves its paths from DOCKET_DATA_DIR at
// module-load time, so it must be set before this dynamic import.
const { LocalTodoRepository } = await import("./repository.js");
const { TodoService } = await import("./todo-service.js");

test.after(async () => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

function context(overrides: Partial<import("./repository.js").MutationContext> = {}) {
  return { agent: "claude-code", session: "sess-1", deviceId: "device-1", deviceName: "TestBox", ...overrides };
}

test("TodoService: create/get/list pass straight through to the repository", async () => {
  const service = new TodoService(new LocalTodoRepository());
  const created = await service.create({ title: "Buy milk" }, context());
  assert.equal((await service.get(created.id))?.uuid, created.uuid);
  assert.ok((await service.list({})).some((t) => t.uuid === created.uuid));
});

test("TodoService: edit/complete/delete/claim/release/history return null for an unknown id instead of throwing", async () => {
  const service = new TodoService(new LocalTodoRepository());
  assert.equal(await service.edit(999_999, { title: "x" }, context()), null);
  assert.equal(await service.complete(999_999, context()), null);
  assert.equal(await service.delete(999_999, context()), null);
  assert.equal(await service.claim(999_999, context()), null);
  assert.equal(await service.release(999_999, context()), null);
  assert.equal(await service.history(999_999), null);
});

test("TodoService: a found id round-trips through edit/complete/delete/claim/release/history normally", async () => {
  const service = new TodoService(new LocalTodoRepository());
  const created = await service.create({ title: "Task" }, context());

  const edited = await service.edit(created.id, { title: "Task 2" }, context());
  assert.equal(edited?.title, "Task 2");

  const claimed = await service.claim(created.id, context());
  assert.equal(claimed?.todo.id, created.id);
  assert.equal(claimed?.previousAgent, null);

  const released = await service.release(created.id, context());
  assert.equal(released?.workingAgent, null);

  const history = await service.history(created.id);
  assert.ok(history && history.length > 0);

  const completed = await service.complete(created.id, context());
  assert.equal(completed?.done, true);

  const removed = await service.delete(created.id, context());
  assert.equal(removed?.uuid, created.uuid);
  assert.equal(await service.get(created.id), null);
});

test("TodoService.health: reports repository health", async () => {
  const service = new TodoService(new LocalTodoRepository());
  const health = await service.health();
  assert.equal(health.ok, true);
  assert.equal(typeof health.formatVersion, "number");
});
