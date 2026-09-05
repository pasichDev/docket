import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * B26: after an upgrade, the OLD detached dashboard is still on the port.
 *
 * `ensureWebUiRunning` accepted any 200 from /api/version as "already running", so every new
 * MCP session adopted it — a build with different store-format handling and different merge
 * behaviour, reading and writing the same data directory, chosen silently because a status
 * code was 200.
 *
 * The version endpoint now carries an identity (product, packageVersion, pid) and the
 * auto-start compares it. These tests drive the two halves: what the endpoint reports, and
 * what a new process does with a mismatch.
 */

const launcherPath = join(process.cwd(), "dist", "launcher.js");
const { version: OUR_VERSION } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

/**
 * A stand-in for a dashboard from another build — as a real child process, because the
 * behaviour under test is "stop it and take the port", and that needs something with its own
 * pid that actually holds the socket. An in-process server would report THIS process's pid,
 * and the first thing the code under test does with a stale daemon is SIGTERM it.
 */
const FAKE_DASHBOARD = `
import { createServer } from "node:http";
const body = JSON.parse(process.argv[2]);
const server = createServer((req, res) => {
  if (req.url && req.url.startsWith("/api/version")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pid: process.pid, ...body }));
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
`;

interface FakeDashboard {
  port: number;
  stop(): Promise<void>;
  exited(): boolean;
}

async function fakeDashboard(dir: string, body: Record<string, unknown>): Promise<FakeDashboard> {
  const scriptPath = join(dir, `fake-dashboard-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(scriptPath, FAKE_DASHBOARD, "utf8");
  const child = spawn(process.execPath, [scriptPath, JSON.stringify(body)], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the fake dashboard never reported a port")), 8000);
    child.stdout.on("data", (c) => {
      out += String(c);
      const match = /^(\d+)/.exec(out.trim());
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  return {
    port,
    exited: () => child.exitCode !== null || child.signalCode !== null,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await once(child, "exit");
    },
  };
}

/** Runs `docket web` and reads back what the real endpoint reports. */
test("the version endpoint identifies the build, not just that something is listening", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "docket-daemon-version-"));
  const port = 21000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [join(process.cwd(), "dist", "web.js")], {
    env: { ...process.env, DOCKET_DATA_DIR: dataDirectory, DOCKET_WEB_PORT: String(port) },
    stdio: "ignore",
  });
  try {
    let body: Record<string, unknown> | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && body === null) {
      body = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(500) })
        .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null))
        .catch(() => null);
      if (body === null) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(body, "the dashboard never came up");
    assert.equal(body.product, "docket-web", "without a product field, anything answering on this port is mistaken for docket");
    assert.equal(body.packageVersion, OUR_VERSION, "without a version, a dashboard from another build is indistinguishable from this one");
    assert.equal(typeof body.pid, "number", "without a pid there is nothing to stop");
  } finally {
    child.kill();
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/**
 * The decision itself, driven through the real `docket web` command — which calls the same
 * ensureWebUiRunning as an MCP session start, and prints the port it settled on.
 */
async function runWebCommand(dataDirectory: string, port: number): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [launcherPath, "web"], {
    env: { ...process.env, DOCKET_DATA_DIR: dataDirectory, DOCKET_WEB_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (c) => (out += String(c)));
  child.stderr?.on("data", (c) => (err += String(c)));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, out, err: `${err}\n(timed out)` });
    }, 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

test("a dashboard from a different version is stopped and replaced, not adopted", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "docket-daemon-stale-"));
  const stale = await fakeDashboard(dataDirectory, { product: "docket-web", packageVersion: "0.0.1-ancient" });
  try {
    const result = await runWebCommand(dataDirectory, stale.port);
    assert.ok(stale.exited(), `the old dashboard is still running — every new session adopts it.\nstdout:\n${result.out}\nstderr:\n${result.err}`);

    // And this build's dashboard took the port it vacated.
    const body = await waitForVersion(stale.port);
    assert.equal(body?.packageVersion, OUR_VERSION, `the port was left empty rather than served by this build: ${JSON.stringify(body)}`);
    await stopWhateverIsOn(stale.port);
  } finally {
    await stale.stop();
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function waitForVersion(port: number, timeoutMs = 10_000): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(500) })
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null))
      .catch(() => null);
    if (body) return body;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/** The replacement dashboard is detached and unref'd, so the test has to clean it up itself. */
async function stopWhateverIsOn(port: number): Promise<void> {
  const body = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(500) })
    .then((r) => (r.ok ? (r.json() as Promise<{ pid?: number }>) : null))
    .catch(() => null);
  if (typeof body?.pid === "number") {
    try {
      process.kill(body.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

test("something that is not docket on the port is left alone rather than killed", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "docket-daemon-foreign-"));
  const foreign = await fakeDashboard(dataDirectory, { some: "other service" });
  try {
    const result = await runWebCommand(dataDirectory, foreign.port);
    assert.doesNotMatch(result.err, /different version/, "docket treated an unrelated service as its own stale daemon");
    // Still listening: nothing tried to stop it.
    const res = await fetch(`http://127.0.0.1:${foreign.port}/api/version`, { signal: AbortSignal.timeout(1000) });
    assert.equal(res.ok, true, "docket stopped a process that was not its own");
  } finally {
    await foreign.stop();
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a dashboard of the same version is adopted, as it always was", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "docket-daemon-same-"));
  const current = await fakeDashboard(dataDirectory, { product: "docket-web", packageVersion: OUR_VERSION });
  try {
    const result = await runWebCommand(dataDirectory, current.port);
    assert.doesNotMatch(result.err, /different version/);
    assert.match(result.out, new RegExp(`http://localhost:${current.port}`), `expected the existing dashboard to be reported:\n${result.out}`);
  } finally {
    await current.stop();
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
