import assert from "node:assert/strict";
import { test } from "node:test";
import { computeAgentPresence } from "./presence.js";
import type { Todo, TodoStore } from "./types.js";

function storeWithHistory(entries: Array<Pick<Todo["history"][number], "at" | "agent" | "deviceName" | "action">>): TodoStore {
  return {
    formatVersion: 8,
    nextId: 2,
    deletedUuids: [],
    seqCounter: 1,
    todos: [
      {
        id: 1,
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
        localSeq: 1,
        workspace: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        revision: 1,
        fieldTimestamps: {},
        completedAt: null,
        deviceId: null,
        deviceName: null,
        history: entries.map((e) => ({ ...e, detail: "detail" })),
      },
    ],
  };
}

test("computeAgentPresence: picks the most recent entry per agent@device pair", () => {
  const store = storeWithHistory([
    { at: "2026-01-01T00:00:00.000Z", agent: "codex", deviceName: "ryzen", action: "edited" },
    { at: "2026-01-01T00:05:00.000Z", agent: "codex", deviceName: "ryzen", action: "claimed" },
    { at: "2026-01-01T00:01:00.000Z", agent: "claude-code", deviceName: "macbook", action: "created" },
  ]);
  const presence = computeAgentPresence(store);
  assert.equal(presence.length, 2);
  const codex = presence.find((p) => p.identity === "codex@ryzen");
  assert.equal(codex?.lastActiveAt, "2026-01-01T00:05:00.000Z");
});

test("computeAgentPresence: 'synced' entries (automatic merge records) never count as presence", () => {
  const store = storeWithHistory([
    { at: "2026-01-01T00:00:00.000Z", agent: "codex", deviceName: "ryzen", action: "edited" },
    { at: new Date().toISOString(), agent: "codex", deviceName: "ryzen", action: "synced" },
  ]);
  const presence = computeAgentPresence(store);
  assert.equal(presence.length, 1);
  assert.equal(presence[0].lastActiveAt, "2026-01-01T00:00:00.000Z");
  assert.equal(presence[0].active, false);
});

test("computeAgentPresence: an entry within the active window is active, an old one is not", () => {
  const store = storeWithHistory([
    { at: new Date().toISOString(), agent: "codex", deviceName: "ryzen", action: "edited" },
    { at: "2020-01-01T00:00:00.000Z", agent: "claude-code", deviceName: "macbook", action: "edited" },
  ]);
  const presence = computeAgentPresence(store);
  assert.equal(presence.find((p) => p.identity === "codex@ryzen")?.active, true);
  assert.equal(presence.find((p) => p.identity === "claude-code@macbook")?.active, false);
});

test("computeAgentPresence: sorted most-recent-first", () => {
  const store = storeWithHistory([
    { at: "2026-01-01T00:00:00.000Z", agent: "a", deviceName: "d1", action: "edited" },
    { at: "2026-02-01T00:00:00.000Z", agent: "b", deviceName: "d2", action: "edited" },
  ]);
  const presence = computeAgentPresence(store);
  assert.deepEqual(presence.map((p) => p.identity), ["b@d2", "a@d1"]);
});
