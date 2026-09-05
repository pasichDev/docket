import test from "node:test";
import assert from "node:assert/strict";
import { exportToJson, exportToMarkdown, importFromJson, importFromMarkdown } from "./export.js";
import { createTodo } from "./mutations.js";
import type { TodoStore } from "./types.js";

function makeStore(): TodoStore {
  return {
    formatVersion: 8,
    nextId: 1,
    todos: [],
    deletedUuids: [],
    seqCounter: 0,
  };
}

test("exportToJson / importFromJson round-trip", () => {
  const store = makeStore();
  createTodo(
    store,
    {
      title: "Write documentation",
      description: "Comprehensive docs for docket",
      list: "todo",
      category: "DOCS",
      priority: "high",
      dueDate: "2026-09-10",
      sourceUrl: "https://github.com/pasichDev/docket",
      agent: "test",
      session: null,
    },
    "dev-1",
    "MacBook",
  );

  createTodo(
    store,
    {
      title: "Backlog item",
      list: "backlog",
      agent: "test",
      session: null,
    },
    "dev-1",
    "MacBook",
  );

  const jsonStr = exportToJson(store);
  assert.ok(jsonStr.includes("Write documentation"));
  assert.ok(jsonStr.includes("Backlog item"));

  const targetStore = makeStore();
  const res = importFromJson(targetStore, jsonStr, "dev-2", "Desktop");
  assert.equal(res.added, 2);
  assert.equal(targetStore.todos.length, 2);
  assert.equal(targetStore.todos[0].title, "Write documentation");
  assert.equal(targetStore.todos[0].category, "DOCS");
  assert.equal(targetStore.todos[0].priority, "high");
  assert.equal(targetStore.todos[0].dueDate, "2026-09-10");
  assert.equal(targetStore.todos[0].sourceUrl, "https://github.com/pasichDev/docket");
  assert.equal(targetStore.todos[1].list, "backlog");
});

test("exportToMarkdown / importFromMarkdown round-trip", () => {
  const store = makeStore();
  const t1 = createTodo(
    store,
    {
      title: "Fix bug in sync",
      description: "Details line 1\nDetails line 2",
      list: "todo",
      category: "BUG",
      priority: "high",
      dueDate: "2026-09-15",
      sourceUrl: "https://github.com/pasichDev/docket/issues/1",
      agent: "test",
      session: null,
    },
    "dev-1",
    "MacBook",
  );
  t1.done = true;
  t1.completedAt = "2026-09-02T00:00:00.000Z";

  createTodo(
    store,
    {
      title: "Future research",
      list: "backlog",
      priority: "low",
      agent: "test",
      session: null,
    },
    "dev-1",
    "MacBook",
  );

  const mdStr = exportToMarkdown(store);
  assert.ok(mdStr.includes("## Todo"));
  assert.ok(mdStr.includes("## Backlog"));
  assert.ok(mdStr.includes("- [x] Fix bug in sync [BUG] !high due:2026-09-15"));
  assert.ok(mdStr.includes("🔗 https://github.com/pasichDev/docket/issues/1"));
  assert.ok(mdStr.includes("- [ ] Future research !low"));

  const targetStore = makeStore();
  const res = importFromMarkdown(targetStore, mdStr, "dev-2", "Desktop");
  assert.equal(res.added, 2);
  assert.equal(targetStore.todos.length, 2);
  assert.equal(targetStore.todos[0].title, "Fix bug in sync");
  assert.equal(targetStore.todos[0].done, true);
  assert.equal(targetStore.todos[0].category, "BUG");
  assert.equal(targetStore.todos[0].priority, "high");
  assert.equal(targetStore.todos[0].dueDate, "2026-09-15");
  assert.equal(targetStore.todos[0].sourceUrl, "https://github.com/pasichDev/docket/issues/1");
  assert.equal(targetStore.todos[0].description, "Details line 1\nDetails line 2");
  assert.equal(targetStore.todos[1].list, "backlog");
  assert.equal(targetStore.todos[1].title, "Future research");
  assert.equal(targetStore.todos[1].priority, "low");
});
