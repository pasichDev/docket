import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// viewers.ts resolves its on-disk path from homedir() once at module load, so each
// test needs a process-fresh module instance pointed at its own temp HOME — otherwise
// tests would read/write the real ~/.todo-mcp/viewers.json.enc.
async function freshViewersModule() {
  process.env.HOME = await mkdtemp(join(tmpdir(), "todo-mcp-viewers-test-"));
  return import(`./viewers.js?t=${Date.now()}-${Math.random()}`);
}

const originalHome = process.env.HOME;
test.after(() => {
  if (originalHome) process.env.HOME = originalHome;
});

test("loadViewers: empty on a fresh install", async () => {
  const mod = await freshViewersModule();
  assert.deepEqual(await mod.loadViewers(), []);
});

test("addViewer/loadViewers: persists and round-trips", async () => {
  const mod = await freshViewersModule();
  await mod.addViewer({ id: "v1", tokenHash: "abc123", label: "Browser (test)", approvedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: null });
  const viewers = await mod.loadViewers();
  assert.equal(viewers.length, 1);
  assert.equal(viewers[0].id, "v1");
  assert.equal(viewers[0].tokenHash, "abc123");
});

test("removeViewer: removes an existing entry, reports false for an unknown id", async () => {
  const mod = await freshViewersModule();
  await mod.addViewer({ id: "v1", tokenHash: "abc123", label: "Browser (test)", approvedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: null });
  assert.equal(await mod.removeViewer("does-not-exist"), false);
  assert.equal(await mod.removeViewer("v1"), true);
  assert.deepEqual(await mod.loadViewers(), []);
});

test("touchViewer: updates lastSeenAt on the matching entry only", async () => {
  const mod = await freshViewersModule();
  await mod.addViewer({ id: "v1", tokenHash: "abc123", label: "A", approvedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: null });
  await mod.addViewer({ id: "v2", tokenHash: "def456", label: "B", approvedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: null });
  await mod.touchViewer("v1");
  const viewers: Array<{ id: string; lastSeenAt: string | null }> = await mod.loadViewers();
  assert.ok(viewers.find((v) => v.id === "v1")!.lastSeenAt !== null);
  assert.equal(viewers.find((v) => v.id === "v2")!.lastSeenAt, null);
});
