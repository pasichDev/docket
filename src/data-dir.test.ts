import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveDataDirectory } from "./data-dir.js";

function accessError(code: "EACCES" | "EPERM" | "EROFS" | "ENOENT") {
  return Object.assign(new Error(code), { code });
}

const missing = async () => { throw accessError("ENOENT"); };
const writableProbe = async () => {};

test("resolveDataDirectory: uses a writable legacy directory as its primary location", async () => {
  const directory = await mkdtemp(join(tmpdir(), "todo-mcp-data-dir-home-"));
  const homeDirectory = join(directory, "home");
  try {
    assert.equal(await resolveDataDirectory({ homeDirectory, environment: {} }), join(homeDirectory, ".todo-mcp"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolveDataDirectory: validates the explicitly configured location with a write probe", async () => {
  const explicit = "/configured/data";
  const expected = accessError("EROFS");
  await assert.rejects(
    resolveDataDirectory({
      environment: { TODO_MCP_DATA_DIR: explicit },
      mkdir: async () => undefined,
      probe: async () => { throw expected; },
    }),
    (error: unknown) => error === expected,
  );
});

test("resolveDataDirectory: uses explicitly configured XDG state after a missing legacy directory is blocked", async () => {
  const homeDirectory = "/legacy-home";
  const legacyDirectory = join(homeDirectory, ".todo-mcp");
  const stateDirectory = "/operator-state/todo-mcp";
  const calls: string[] = [];
  const warnings: string[] = [];

  const resolved = await resolveDataDirectory({
    homeDirectory,
    environment: { XDG_STATE_HOME: "/operator-state" },
    inspect: missing,
    mkdir: async (path) => {
      calls.push(path);
      if (path === legacyDirectory) throw accessError("EACCES");
      return undefined;
    },
    probe: writableProbe,
    warn: (message) => warnings.push(message),
  });

  assert.equal(resolved, stateDirectory);
  assert.deepEqual(calls, [legacyDirectory, stateDirectory]);
  assert.deepEqual(warnings, [
    `todo-mcp: cannot use ${legacyDirectory}; using operator-configured XDG_STATE_HOME at ${stateDirectory} for local state\n`,
  ]);
});

test("resolveDataDirectory: never splits existing inaccessible legacy state into XDG state", async () => {
  const legacyDirectory = "/legacy-home/.todo-mcp";
  const stateDirectory = "/operator-state/todo-mcp";
  const calls: string[] = [];

  await assert.rejects(
    resolveDataDirectory({
      homeDirectory: "/legacy-home",
      environment: { XDG_STATE_HOME: "/operator-state" },
      inspect: async () => ({}),
      mkdir: async (path) => { calls.push(path); return undefined; },
      probe: async (path) => {
        if (path === legacyDirectory) throw accessError("EPERM");
      },
    }),
    /existing legacy state.*TODO_MCP_DATA_DIR/,
  );
  assert.deepEqual(calls, [legacyDirectory]);
  assert.ok(!calls.includes(stateDirectory));
});

test("resolveDataDirectory: continues to XDG state when the legacy write probe fails", async () => {
  const legacyDirectory = "/legacy-home/.todo-mcp";
  const stateDirectory = "/operator-state/todo-mcp";
  const probes: string[] = [];

  const resolved = await resolveDataDirectory({
    homeDirectory: "/legacy-home",
    environment: { XDG_STATE_HOME: "/operator-state" },
    inspect: missing,
    mkdir: async () => undefined,
    probe: async (path) => {
      probes.push(path);
      if (path === legacyDirectory) throw accessError("EACCES");
    },
  });

  assert.equal(resolved, stateDirectory);
  assert.deepEqual(probes, [legacyDirectory, stateDirectory]);
});

test("resolveDataDirectory: reports an actionable error when all durable candidates fail", async () => {
  const legacyDirectory = "/legacy-home/.todo-mcp";
  const stateDirectory = "/operator-state/todo-mcp";
  const calls: string[] = [];

  await assert.rejects(
    resolveDataDirectory({
      homeDirectory: "/legacy-home",
      environment: { XDG_STATE_HOME: "/operator-state" },
      inspect: missing,
      mkdir: async (path) => {
        calls.push(path);
        throw accessError("EROFS");
      },
      probe: writableProbe,
    }),
    /no writable durable data directory.*TODO_MCP_DATA_DIR/,
  );
  assert.deepEqual(calls, [legacyDirectory, stateDirectory]);
});

test("resolveDataDirectory: requires an explicit location when no operator-controlled state fallback exists", async () => {
  await assert.rejects(
    resolveDataDirectory({
      homeDirectory: "/legacy-home",
      environment: {},
      inspect: missing,
      mkdir: async () => { throw accessError("EACCES"); },
      probe: writableProbe,
    }),
    /TODO_MCP_DATA_DIR/,
  );
});
