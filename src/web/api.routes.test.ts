import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-api-routes-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { createWebServer } = await import("./server.js");
const { LocalTodoRepository } = await import("../repository.js");

let server: Server;
let base: string;
const repo = new LocalTodoRepository();
const context = { agent: "test", session: "s", deviceId: "d", deviceName: "D", workspace: "acme/backend" };

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

const api = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
const post = (path: string, body: unknown) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// --- Happy paths -----------------------------------------------------------------------

test("routes: creating, listing, editing and completing an item all round-trip", async () => {
  const created = await post("/api/todos", { title: "route test", workspace: "acme/backend", priority: "high" });
  assert.equal(created.status, 201);
  const { todo } = (await created.json()) as { todo: { id: number; uuid: string; workspace: string } };
  assert.equal(todo.workspace, "acme/backend", "the dashboard's chosen project must reach the store");

  const listed = (await (await api("/api/todos")).json()) as { todos: Array<{ id: number; shortId: string }> };
  assert.ok(listed.todos.some((t) => t.id === todo.id));
  assert.ok(listed.todos.every((t) => typeof t.shortId === "string"), "shortId is derived server-side so both surfaces agree");

  const edited = await api(`/api/todos/${todo.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "renamed" }),
  });
  assert.equal(edited.status, 200);

  const done = await post(`/api/todos/${todo.id}/complete`, {});
  assert.equal(done.status, 200);
});

test("routes: the history endpoint returns the item's full log", async () => {
  const { todo } = (await (await post("/api/todos", { title: "with history" })).json()) as { todo: { id: number; uuid: string } };
  await api(`/api/todos/${todo.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "changed" }) });

  const res = await api(`/api/todos/${todo.uuid}/history`);
  assert.equal(res.status, 200);
  const { history } = (await res.json()) as { history: Array<{ action: string }> };
  assert.deepEqual(history.map((h) => h.action), ["created", "edited"]);
});

// --- Unknown ids and bad input -----------------------------------------------------------

test("routes: an unknown id is a 404 with a JSON body, never a crash or an empty 200", async () => {
  for (const path of ["/api/todos/424242", "/api/todos/T-ZZZZZZ/history"]) {
    const res = await api(path, { method: "GET" });
    assert.equal(res.status, 404, `${path} responded ${res.status}`);
    await assert.doesNotReject(() => res.json());
  }
  const patched = await api("/api/todos/424242", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "x" }),
  });
  assert.equal(patched.status, 404);
});

test("routes: a malformed body is rejected with a clear status, and changes nothing", async () => {
  const before = ((await (await api("/api/todos")).json()) as { todos: unknown[] }).todos.length;

  const notJson = await api("/api/todos", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  assert.ok(notJson.status >= 400 && notJson.status < 500, `expected a 4xx, got ${notJson.status}`);

  const noTitle = await post("/api/todos", { description: "no title here" });
  assert.equal(noTitle.status, 400);

  const blankTitle = await post("/api/todos", { title: "   " });
  assert.equal(blankTitle.status, 400, "whitespace is not a title");

  const after = ((await (await api("/api/todos")).json()) as { todos: unknown[] }).todos.length;
  assert.equal(after, before, "a rejected request still created something");
});

test("routes: an unsafe sourceUrl is dropped rather than stored", async () => {
  const { todo } = (await (await post("/api/todos", { title: "link", sourceUrl: "javascript:alert(1)" })).json()) as {
    todo: { sourceUrl: string | null };
  };
  assert.equal(todo.sourceUrl, null);
});

// --- Cross-workspace behaviour ------------------------------------------------------------

test("routes: /api/todos is unscoped, and each item reports the project it belongs to", async () => {
  await repo.create({ title: "in web" }, { ...context, workspace: "acme/web" });
  const { todos } = (await (await api("/api/todos")).json()) as { todos: Array<{ workspace: string | null }> };
  const workspaces = new Set(todos.map((t) => t.workspace));
  assert.ok(workspaces.size > 1, "the dashboard filters client-side, so the API must hand it every project");
  assert.ok(workspaces.has("acme/web"));
});

test("routes: the SessionStart payload is scoped, and unfiled items ride along", async () => {
  await repo.create({ title: "unfiled thought" }, { ...context, workspace: null });
  const { text } = (await (await api("/api/hook/session-start?workspace=acme/web")).json()) as { text: string };
  assert.match(text, /in web/, "the requested project's items must be there");
  assert.match(text, /unfiled thought/, "unfiled items stay reachable rather than becoming invisible");
  assert.doesNotMatch(text, /route test/, "another project's items must not be");
});

test("routes: an unknown workspace yields only unfiled items, never every project", async () => {
  const { text } = (await (await api("/api/hook/session-start?workspace=nope/nope")).json()) as { text: string };
  // Unfiled items ride along with every scope by design — they are legacy or context-free,
  // and hiding them would make a scoped list quietly lose work. What must NOT happen is
  // falling back to unscoped, which would put every project in every session.
  assert.match(text, /unfiled thought/);
  assert.doesNotMatch(text, /route test/, "another project's items leaked into an unknown scope");
  assert.doesNotMatch(text, /in web/);
});

// --- Guards ------------------------------------------------------------------------------

test("routes: an unrecognised Host header is refused before any route runs (DNS rebinding)", async () => {
  // `fetch` refuses to set Host — it is a forbidden header — so this has to go out over a
  // raw request, which is also exactly how the attack would arrive.
  const { request } = await import("node:http");
  const port = Number(new URL(base).port);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/todos", method: "GET", headers: { Host: "evil.example.com" } }, (res) =>
      resolve(res.statusCode ?? 0),
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403, "a malicious site can point its own DNS at loopback; only the Host header distinguishes it");
});

test("routes: a cross-origin mutating request is refused (CSRF)", async () => {
  const res = await api("/api/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.example.com" },
    body: JSON.stringify({ title: "forged" }),
  });
  assert.equal(res.status, 403);
});

test("routes: an unknown path is a JSON 404, not an HTML error page", async () => {
  const res = await api("/api/nope");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
});

test("routes: every response carries the security headers", async () => {
  for (const path of ["/", "/api/todos", "/api/version"]) {
    const res = await api(path);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${path} is missing nosniff`);
    assert.equal(res.headers.get("x-frame-options"), "DENY", `${path} can be framed`);
  }
});

test("routes: deleting is reflected immediately in the list", async () => {
  const { todo } = (await (await post("/api/todos", { title: "to delete" })).json()) as { todo: { id: number } };
  const removed = await api(`/api/todos/${todo.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const { todos } = (await (await api("/api/todos")).json()) as { todos: Array<{ id: number }> };
  assert.ok(!todos.some((t) => t.id === todo.id));
});
