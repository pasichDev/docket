import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { once } from "node:events";

const TIMEOUT_MS = 5_000;

function after<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), TIMEOUT_MS);
    }),
  ]);
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await after(once(server, "listening"), "timed out starting the test web endpoint");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  try {
    await after(exited, "timed out stopping the MCP server");
  } catch (error) {
    child.kill("SIGKILL");
    await once(child, "exit");
    throw error;
  }
}

async function initialize(child: ChildProcessWithoutNullStreams): Promise<unknown> {
  const response = new Promise<unknown>((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      const lines = output.split("\n");
      output = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        try {
          const message = JSON.parse(line) as { id?: number };
          if (message.id === 1) resolve(message);
        } catch (error) {
          reject(error);
        }
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`MCP server exited before initialize response (code ${code})`)));
  });

  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "data-dir-integration-test", version: "1.0.0" },
    },
  })}\n`);
  return after(response, "timed out waiting for MCP initialize response");
}

test("built MCP server falls back to XDG state when HOME is not writable", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-data-dir-e2e-"));
  const blockedHome = join(root, "home");
  const stateHome = join(root, "state");
  let versionRequests = 0;
  let resolveVersionRequest: (() => void) | undefined;
  const versionRequest = new Promise<void>((resolve) => { resolveVersionRequest = resolve; });
  const versionEndpoint = createServer((req, res) => {
    if (req.url === "/api/version") {
      versionRequests += 1;
      resolveVersionRequest?.();
      resolveVersionRequest = undefined;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  let child: ChildProcessWithoutNullStreams | undefined;
  let endpointListening = false;
  let standardError = "";
  let resolveFallbackWarning: (() => void) | undefined;
  const fallbackWarning = new Promise<void>((resolve) => { resolveFallbackWarning = resolve; });

  try {
    await Promise.all([mkdir(blockedHome), mkdir(stateHome)]);
    await chmod(blockedHome, 0o500);
    const port = await listen(versionEndpoint);
    endpointListening = true;
    const { DOCKET_DATA_DIR: _dataDirectory, XDG_STATE_HOME: _stateDirectory, ...environment } = process.env;
    child = spawn(process.execPath, [join(process.cwd(), "dist", "index.js")], {
      env: {
        ...environment,
        HOME: blockedHome,
        XDG_STATE_HOME: stateHome,
        DOCKET_WEB_PORT: String(port),
      },
      stdio: "pipe",
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      standardError += chunk;
      if (/docket: cannot use .*; using operator-configured XDG_STATE_HOME at .* for local state/.test(standardError)) {
        resolveFallbackWarning?.();
        resolveFallbackWarning = undefined;
      }
    });

    const response = await initialize(child);
    // The SDK adds capability details, so check only the protocol-level shape.
    assert.equal((response as { jsonrpc?: string }).jsonrpc, "2.0");
    assert.equal((response as { id?: number }).id, 1);
    assert.ok((response as { result?: unknown }).result);
    await after(versionRequest, "MCP server did not probe the configured web endpoint");
    await after(fallbackWarning, "MCP server did not emit the fallback warning on stderr");
    assert.equal(
      standardError.match(/docket: cannot use .*; using operator-configured XDG_STATE_HOME at .* for local state/g)?.length,
      1,
      "fallback warning is emitted exactly once on stderr",
    );

    const dataDirectory = join(stateHome, "docket");
    await access(join(dataDirectory, "device.json"));
    await access(join(dataDirectory, "todos.json.enc"));
    assert.equal((await stat(join(dataDirectory, "device.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dataDirectory, "todos.json.enc"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dataDirectory, "server.log"))).mode & 0o777, 0o600);
    await assert.rejects(access(join(blockedHome, ".docket")));
    assert.equal(versionRequests, 1, "the healthy endpoint prevents auto-starting a detached web server");
  } finally {
    const cleanup = await Promise.allSettled([
      child ? stop(child) : Promise.resolve(),
      endpointListening
        ? new Promise<void>((resolve, reject) => versionEndpoint.close((error) => error ? reject(error) : resolve()))
        : Promise.resolve(),
    ]);
    try {
      await chmod(blockedHome, 0o700).catch(() => {});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const failedCleanup = cleanup.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failedCleanup) throw failedCleanup.reason;
  }
});
