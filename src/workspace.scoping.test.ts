import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-scoping-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { filterTodos, LocalTodoRepository } = await import("./repository.js");

const repo = new LocalTodoRepository();
const inWorkspace = (workspace: string | null) => ({ agent: "codex", session: "s1", deviceId: "d1", deviceName: "Dev", workspace });

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

const backend = await repo.create({ title: "fix token refresh" }, inWorkspace("acme/backend"));
const web = await repo.create({ title: "ship the new nav" }, inWorkspace("acme/web"));
const unfiled = await repo.create({ title: "thought with no home" }, inWorkspace(null));

test("todo_add files an item under the caller's project without being asked", () => {
  assert.equal(backend.workspace, "acme/backend");
  assert.equal(web.workspace, "acme/web");
  assert.equal(unfiled.workspace, null, "a caller with no project context files an honest null, not a guess");
});

test("an explicit workspace on the input overrides the caller's own", async () => {
  const moved = await repo.create({ title: "belongs elsewhere", workspace: "acme/web" }, inWorkspace("acme/backend"));
  assert.equal(moved.workspace, "acme/web");
});

test("the default scope is this project plus unfiled — never another project's items", async () => {
  const scoped = await repo.list({ workspace: "acme/backend" });
  const titles = scoped.map((t) => t.title);
  assert.ok(titles.includes("fix token refresh"), "this project's items are in");
  assert.ok(titles.includes("thought with no home"), "unfiled items stay reachable rather than becoming invisible");
  assert.ok(!titles.includes("ship the new nav"), "another project's items are out — this is the whole feature");
});

test('workspace "*" returns everything', async () => {
  const all = await repo.list({ workspace: "*" });
  assert.ok(all.length >= 4);
  assert.ok(all.some((t) => t.workspace === "acme/web"));
  assert.ok(all.some((t) => t.workspace === "acme/backend"));
  assert.ok(all.some((t) => t.workspace === null));
});

test("an omitted workspace means no restriction at all — the web UI's unfiltered list is unchanged", async () => {
  const everything = await repo.list({});
  const explicit = await repo.list({ workspace: "*" });
  assert.equal(everything.length, explicit.length);
});

test("an id from another workspace still resolves — ids are global, scoping is a filter", async () => {
  const fetched = await repo.get(web.id);
  assert.ok(fetched, "serving a cross-project id is deliberate: an agent that has an id should get the item");
  assert.equal(fetched.workspace, "acme/web", "and the item reports where it actually lives, so the agent isn't misled");
});

test("scoping composes with the other filters instead of replacing them", () => {
  const todos = [backend, web, unfiled];
  const open = filterTodos(todos, { workspace: "acme/backend", filter: "open" });
  assert.deepEqual(open.map((t) => t.title).sort(), ["fix token refresh", "thought with no home"]);
  const done = filterTodos(todos, { workspace: "acme/backend", filter: "done" });
  assert.deepEqual(done, []);
});
