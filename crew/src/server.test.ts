import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { defaultConfig } from "./config.js";
import { EventBus } from "./events.js";
import { crewPaths, ensureCrewTree } from "./paths.js";
import { createCrewServer, type CrewServer } from "./server.js";
import { freshState, StateStore } from "./state.js";
import type { RuntimeId } from "./types.js";

/**
 * Defect A, the daemon-killing half: `/api/events` wrote its 200 SSE header and only THEN
 * awaited the backlog read. When that read failed — `RangeError: Invalid string length` past
 * ~512 MB of events.jsonl, reproduced against a real daemon with a 566 MB log — the catch
 * called json(res, 500, …) on a response whose head was already sent, ERR_HTTP_HEADERS_SENT
 * escaped an async request listener as an unhandled rejection, and the daemon exited code 1.
 *
 * The consequence was the worst part: dying that way skips supervisor.stopAll(), so every
 * runtime child was orphaned and kept editing worktrees, with a stale daemon.json left behind.
 */

const running: CrewServer[] = [];
after(async () => {
  await Promise.all(running.map((s) => s.stop().catch(() => {})));
});

async function fixture(opts: { readRecent?: () => Promise<never> } = {}): Promise<{ server: CrewServer; port: number }> {
  const root = await mkdtemp(join(tmpdir(), "crew-server-test-"));
  const paths = await ensureCrewTree(crewPaths(root));
  const store = new StateStore(paths.stateFile, () => freshState("test-ws", 0));
  const bus = new EventBus(paths.eventsFile);
  if (opts.readRecent) Object.defineProperty(bus, "readRecent", { value: opts.readRecent });
  const server = createCrewServer({
    store,
    bus,
    config: defaultConfig(),
    paths,
    supervisor: null,
    runtimes: {} as Record<RuntimeId, never>,
    workspace: { workspace: "test-ws", source: "explicit" as never, root },
  });
  running.push(server);
  const port = await server.start(0);
  return { server, port };
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        body += c;
        // SSE never ends on its own; one payload is enough to judge the response.
        if (body.length > 0 && res.headers["content-type"]?.includes("event-stream")) {
          res.destroy();
          resolve({ status: res.statusCode ?? 0, body });
        }
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a failing event-log read answers 500 and leaves the daemon alive", async () => {
  const crashes: unknown[] = [];
  const onCrash = (err: unknown) => crashes.push(err);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  try {
    const { port } = await fixture({
      readRecent: async () => {
        throw new RangeError("Invalid string length");
      },
    });

    const res = await get(port, "/api/events");
    assert.equal(res.status, 500, "the SSE header went out before the backlog was even read");
    assert.match(res.body, /Invalid string length/);

    // Still serving: the daemon did not die, so nothing was orphaned.
    const health = await get(port, "/api/health");
    assert.equal(health.status, 200);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(crashes, [], "the failure escaped as an uncaught exception — that is what kills the daemon");
  } finally {
    process.off("uncaughtException", onCrash);
    process.off("unhandledRejection", onCrash);
  }
});

test("/api/events still streams the backlog it can read", async () => {
  const { port } = await fixture();
  const res = await get(port, "/api/events?backlog=5");
  assert.equal(res.status, 200);
  assert.match(res.body, /retry: 3000/);
});

test("a held daemon answers 503 rather than serving half-initialized state", async () => {
  const { server, port } = await fixture();
  server.hold();
  const held = await get(port, "/api/health");
  assert.equal(held.status, 503, "a daemon that has bound the port but not finished booting must not look healthy");
  server.markReady();
  assert.equal((await get(port, "/api/health")).status, 200);
});
