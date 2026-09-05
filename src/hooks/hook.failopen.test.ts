import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** The built entry point a host actually invokes — not the module, so process exit code and stdout are what's under test. */
const LAUNCHER = fileURLToPath(new URL("../launcher.js", import.meta.url));

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the real hook exactly as Claude Code does: piped stdin carrying the event JSON, and
 * a port to talk to. What matters is only ever the exit code and the bytes on stdout — that
 * is the entire contract with the host.
 */
async function runHook(port: number, env: Record<string, string> = {}): Promise<HookRun> {
  const child = spawn(process.execPath, [LAUNCHER, "hook", "claude", "session-start"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DOCKET_WEB_PORT: String(port), ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  child.stdin.end(JSON.stringify({ cwd: process.cwd(), session_id: "test", hook_event_name: "SessionStart" }));
  const [code] = (await once(child, "exit")) as [number | null];
  return { code, stdout, stderr };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

/**
 * Fail-open is a trust argument, not an implementation detail: a coordination tool that
 * degrades your session when the tool itself is broken gets uninstalled, at which point it
 * protects nobody. Every one of these must be indistinguishable from "docket isn't here".
 */
test("hook: server not running — exits 0, says nothing", async () => {
  // Port 1 on loopback: nothing can be listening, and the connection is refused immediately.
  const result = await runHook(1);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("hook: server accepts the connection and never answers — exits 0 within its timeout", async () => {
  const server = createServer(() => {
    // Deliberately no response, ever: the hard timeout is what has to save the session.
  });
  const port = await listen(server);
  try {
    const started = Date.now();
    const result = await runHook(port);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.ok(Date.now() - started < 5_000, "a hung server must not hold up the session");
  } finally {
    server.close();
  }
});

test("hook: server returns garbage — exits 0, says nothing", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("<html>not json at all</html>");
  });
  const port = await listen(server);
  try {
    const result = await runHook(port);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  } finally {
    server.close();
  }
});

test("hook: server returns a 500 — exits 0, says nothing", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "boom" }));
  });
  const port = await listen(server);
  try {
    const result = await runHook(port);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  } finally {
    server.close();
  }
});

test("hook: DOCKET_HOOKS=off disables it without touching any config", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "Docket — open in acme/backend:\nT-AAAAAA  something" }));
  });
  const port = await listen(server);
  try {
    const result = await runHook(port, { DOCKET_HOOKS: "off" });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "", "the escape hatch has to work without editing settings.json");
  } finally {
    server.close();
  }
});

test("hook: a healthy server's text is what reaches the session, and nothing else", async () => {
  const injected = "Docket — open in acme/backend:\nT-AAAAAA  fix the thing  [high]";
  const server = createServer((req, res) => {
    assert.ok(req.url?.startsWith("/api/hook/session-start"), `unexpected request path: ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: injected }));
  });
  const port = await listen(server);
  try {
    const result = await runHook(port);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${injected}\n`);
    assert.equal(result.stderr, "");
  } finally {
    server.close();
  }
});

test("hook: an empty list injects nothing at all", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "" }));
  });
  const port = await listen(server);
  try {
    const result = await runHook(port);
    assert.equal(result.stdout, "", "\"nothing open\" is not worth a line at the top of every session");
  } finally {
    server.close();
  }
});

test("hook: DOCKET_HOOKS=off makes no request at all, not just a silent one", async () => {
  // The difference matters: "off" has to mean the hook costs nothing, not that it still
  // wakes the server and throws the answer away on every session start.
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "should never be asked for" }));
  });
  const port = await listen(server);
  try {
    const result = await runHook(port, { DOCKET_HOOKS: "off" });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(requests, 0, "the hook contacted the server despite being turned off");
  } finally {
    server.close();
  }
});

test("hook: a warm round trip against a live server stays well inside the session-start budget", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "Docket — open in acme/backend:\nT-AAAAAA  something" }));
  });
  const port = await listen(server);
  try {
    await runHook(port); // warm the process cache so this measures the hook, not the first import
    const started = Date.now();
    const result = await runHook(port);
    const elapsed = Date.now() - started;
    assert.equal(result.code, 0);
    // Generous on purpose: most of this is Node's own startup, which no command hook can
    // avoid, and a CI box is slower than a laptop. It fails only if something genuinely
    // pathological creeps onto the path — a store decrypt, an MCP import, a retry loop.
    assert.ok(elapsed < 1_500, `a session start would wait ${elapsed}ms for the hook`);
  } finally {
    server.close();
  }
});

test("hook: a server that answers with the wrong JSON shape is treated as no answer", async () => {
  for (const body of ['{"text":123}', '{"text":null}', '{"nope":"x"}', "[]", "null"]) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
    const port = await listen(server);
    try {
      const result = await runHook(port);
      assert.equal(result.code, 0, `body ${body} produced exit ${result.code}`);
      assert.equal(result.stdout, "", `body ${body} put something in the session`);
    } finally {
      server.close();
    }
  }
});
