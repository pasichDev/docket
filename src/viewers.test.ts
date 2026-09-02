import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const viewersModule = pathToFileURL(join(process.cwd(), "dist", "viewers.js")).href;

async function runViewers<T>(directory: string, action: string): Promise<T> {
  const script = `
    const viewers = await import(${JSON.stringify(viewersModule)});
    const first = { id: "v1", tokenHash: "abc123", label: "A", approvedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: null };
    const second = { id: "v2", tokenHash: "def456", label: "B", approvedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: null };
    const action = ${JSON.stringify(action)};
    let result;
    if (action === "load") result = await viewers.loadViewers();
    else if (action === "add") { await viewers.addViewer(first); result = await viewers.loadViewers(); }
    else if (action === "seed") { await viewers.addViewer(first); await viewers.addViewer(second); result = true; }
    else if (action === "remove-unknown") result = await viewers.removeViewer("does-not-exist");
    else if (action === "remove") result = await viewers.removeViewer("v1");
    else if (action === "touch") { await viewers.touchViewer("v1"); result = await viewers.loadViewers(); }
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, DOCKET_DATA_DIR: directory },
  });
  return JSON.parse(stdout) as T;
}

async function withViewerDirectory<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "docket-viewers-test-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("loadViewers: empty on a fresh install", () => withViewerDirectory(async (directory) => {
  assert.deepEqual(await runViewers(directory, "load"), []);
}));

test("addViewer/loadViewers: encrypted data is readable in a fresh runtime", () => withViewerDirectory(async (directory) => {
  await runViewers(directory, "add");
  const viewers = await runViewers<Array<{ id: string; tokenHash: string }>>(directory, "load");
  assert.deepEqual(viewers, [{
    id: "v1",
    tokenHash: "abc123",
    label: "A",
    approvedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: null,
  }]);
}));

test("removeViewer: removes an existing entry and reports false for an unknown id", () => withViewerDirectory(async (directory) => {
  await runViewers(directory, "add");
  assert.equal(await runViewers(directory, "remove-unknown"), false);
  assert.equal(await runViewers(directory, "remove"), true);
  assert.deepEqual(await runViewers(directory, "load"), []);
}));

test("touchViewer: updates the matching entry only across fresh runtimes", () => withViewerDirectory(async (directory) => {
  await runViewers(directory, "seed");
  const viewers = await runViewers<Array<{ id: string; lastSeenAt: string | null }>>(directory, "touch");
  assert.ok(viewers.find((viewer) => viewer.id === "v1")!.lastSeenAt !== null);
  assert.equal(viewers.find((viewer) => viewer.id === "v2")!.lastSeenAt, null);
}));
