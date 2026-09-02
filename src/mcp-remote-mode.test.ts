import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * MCP-entrypoint-level coverage of RFC "Local and Self-Hosted Backend Modes" §22's central
 * invariant ("a remote connection failure never falls back to local writes") at the exact
 * seam a real MCP host hits it: `docket` started with remote mode configured but this
 * device not yet paired. See src/remote/client.test.ts and src/server/serve.e2e.test.ts
 * for the same invariant covered at the repository and HTTP layers respectively — this
 * file is the third layer, the actual stdio process a host spawns (mirrors
 * mcp-startup.test.ts's spawn pattern for the local-mode happy path).
 */
test("docket (stdio MCP): remote mode configured but device not paired fails loudly at startup — never silently starts in local mode, never creates local todo state", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "docket-mcp-remote-unpaired-test-"));
  try {
    const launcherPath = join(process.cwd(), "dist", "launcher.js");
    const child = spawn(process.execPath, [launcherPath], {
      env: {
        ...process.env,
        DOCKET_DATA_DIR: dataDirectory,
        DOCKET_WEB_PORT: "0",
        DOCKET_MODE: "remote",
        DOCKET_SERVER_URL: "https://docket.invalid.example",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`process didn't exit within 8s. stdout:\n${stdout}\nstderr:\n${stderr}`)), 8000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.notEqual(exitCode, 0, `expected a non-zero exit (startup failure), got ${exitCode}. stdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stderr, /isn't paired yet/);
    // stdout must stay clean for JSON-RPC — no MCP handshake response should ever have been sent.
    assert.doesNotMatch(stdout, /"jsonrpc"/);

    // The device identity itself (device.json) is legitimate local infra either mode needs,
    // but no TODO STATE (todos.json.enc, the encrypted store) may exist — that's the actual
    // invariant: a misconfigured remote mode must never silently create a local workspace.
    const entries = await readdir(dataDirectory).catch((): string[] => []);
    assert.ok(!entries.includes("todos.json.enc"), `expected no local todo store to be created, found: ${entries.join(", ")}`);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
