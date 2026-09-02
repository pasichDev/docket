import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Spawns the real published entrypoint (dist/launcher.js, what `todo-mcp` resolves to)
 * over stdio — the exact path any MCP host (Claude Code, Codex, Claude Desktop, ...) uses
 * — and drives a real initialize -> initialized -> tools/list -> tools/call handshake.
 * A silent hang here (never resolving, never printing anything actionable to stderr) is
 * exactly the "MCP startup failure" class of bug this guards against: without this test,
 * that failure mode is invisible to `npm test` and only shows up as a hung/broken host.
 */
async function runMcpHandshake(env: NodeJS.ProcessEnv): Promise<{ tools: string[]; listResult: unknown; stderr: string }> {
  const launcherPath = join(process.cwd(), "dist", "launcher.js");
  const child = spawn(process.execPath, [launcherPath], { env, stdio: ["pipe", "pipe", "pipe"] });

  let stdoutLineBuffer = "";
  let stderrBuffer = "";
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  // Parse directly off each `data` event rather than polling a byte offset: a JSON-RPC
  // message can arrive split across two `data` events (real OS pipe chunking), and a
  // poller that advances its "consumed" offset to the end of the buffer on every tick
  // — even when the tail is a not-yet-newline-terminated partial line — corrupts that
  // split message and drops it, silently, until the 8s response timeout fires instead.
  child.stdout.on("data", (chunk) => {
    stdoutLineBuffer += String(chunk);
    let newlineIndex: number;
    while ((newlineIndex = stdoutLineBuffer.indexOf("\n")) !== -1) {
      const line = stdoutLineBuffer.slice(0, newlineIndex);
      stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // stray non-JSON-RPC output on stdout would itself be a real bug, but don't crash the parser on it
      }
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });
  child.stderr.on("data", (chunk) => (stderrBuffer += String(chunk)));

  function send(id: number | null, method: string, params: unknown): Promise<unknown> {
    const message = { jsonrpc: "2.0", ...(id !== null ? { id } : {}), method, params };
    child.stdin.write(`${JSON.stringify(message)}\n`);
    if (id === null) return Promise.resolve(undefined); // a notification — no response expected
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timed out waiting for a response to ${method} (id ${id}). stderr so far:\n${stderrBuffer}`));
        }
      }, 8000);
    });
  }

  try {
    await send(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "todo-mcp-startup-test", version: "1.0" },
    });
    await send(null, "notifications/initialized", {});
    const listResult = (await send(2, "tools/list", {})) as { tools: Array<{ name: string }> };
    const tools = listResult.tools.map((t) => t.name);
    await send(3, "tools/call", { name: "todo_list", arguments: {} });
    return { tools, listResult, stderr: stderrBuffer };
  } finally {
    child.kill();
  }
}

test("MCP startup: initialize -> initialized -> tools/list -> todo_list succeeds over stdio with a scratch data directory", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "todo-mcp-mcp-startup-test-"));
  try {
    const { tools } = await runMcpHandshake({ ...process.env, TODO_MCP_DATA_DIR: dataDirectory, TODO_MCP_WEB_PORT: "0" });
    for (const expected of ["todo_add", "todo_edit", "todo_list", "todo_claim", "todo_complete", "todo_check_update"]) {
      assert.ok(tools.includes(expected), `expected tools/list to include ${expected}, got: ${tools.join(", ")}`);
    }
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
