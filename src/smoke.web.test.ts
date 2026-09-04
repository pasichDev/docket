import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-smoke-web-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { createWebServer } = await import("./web/server.js");
const { LocalTodoRepository } = await import("./repository.js");

/**
 * The dashboard is one large inline `<script>` inside a TypeScript template literal, and the
 * CLI entry points are separate processes — so `tsc` and the unit suite between them execute
 * none of it. A stray backtick in a comment once terminated that literal, and the only thing
 * that noticed was a human loading the page.
 *
 * This starts the real server and asks it for the real page. Anything that stops the server
 * booting, or the page rendering, fails here instead of in someone's browser.
 */
let server: Server;
let base: string;

test.before(async () => {
  server = await createWebServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  server?.close();
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  await rm(dataDirectory, { recursive: true, force: true });
});

test("smoke: GET / serves the dashboard, with the workspace switcher in it", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const body = await res.text();

  // Anchors that only exist if the page rendered as intended — a truncated template literal
  // yields a shorter body that still returns 200.
  assert.match(body, /class="workspaces"/, "the workspace switcher container is missing from the page");
  assert.match(body, /class="open-list"/);
  assert.match(body, /renderWorkspaceSwitcher/, "the switcher's script never made it into the page");
  assert.ok(body.length > 20_000, `page looks truncated (${body.length} bytes)`);
});

test("smoke: the endpoints the hook and the dashboard poll all return valid JSON", async () => {
  await new LocalTodoRepository().create({ title: "smoke item" }, { agent: "test", session: "s", deviceId: "d", deviceName: "D", workspace: "acme/backend" });

  for (const path of ["/api/todos", "/api/version", "/api/sessions", "/api/hook/session-start?workspace=acme/backend"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${path} responded ${res.status}`);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/, `${path} is not JSON`);
    await assert.doesNotReject(() => res.json(), `${path} returned malformed JSON`);
  }
});

test("smoke: the SessionStart endpoint returns text the hook can print", async () => {
  const res = await fetch(`${base}/api/hook/session-start?workspace=acme/backend`);
  const body = (await res.json()) as { text?: unknown };
  assert.equal(typeof body.text, "string");
  assert.match(body.text as string, /smoke item/, "the item created above should be open in that workspace");
});

test("smoke: an unknown route 404s as JSON rather than crashing the server", async () => {
  const res = await fetch(`${base}/api/definitely-not-a-route`);
  assert.equal(res.status, 404);
  await assert.doesNotReject(() => res.json());
});
