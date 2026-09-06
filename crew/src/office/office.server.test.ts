import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * The Office mounted on the real Crew server — the same createCrewServer() the daemon uses,
 * bound to an ephemeral port, against a scratch DOCKET_CREW_HOME.
 *
 * Nothing here may touch ~/.docket: every path comes from mkdtemp, and the state store and
 * event log are created under it. That is checked explicitly at the bottom of the file,
 * because a test that silently wrote to the user's real crew tree would be worse than no
 * test at all.
 */

const { createCrewServer } = await import("../server.js");
const { defaultConfig } = await import("../config.js");
const { EventBus } = await import("../events.js");
const { StateStore, freshState } = await import("../state.js");
const { crewPaths } = await import("../paths.js");
const { registerOfficeRoutes } = await import("./routes.js");
const { OFFICE_MARKUP } = await import("./markup.js");
const { OFFICE_STYLES } = await import("./styles.js");

const SCRATCH = await mkdtemp(join(tmpdir(), "crew-office-test-"));
after(() => rm(SCRATCH, { recursive: true, force: true }));

const paths = crewPaths(SCRATCH);

async function boot() {
  const store = new StateStore(paths.stateFile, () => freshState("office-test", 0));
  const bus = new EventBus(paths.eventsFile);
  const server = createCrewServer({
    store,
    bus,
    config: defaultConfig(),
    paths,
    runtimes: {
      claude: { id: "claude", installed: false },
      codex: { id: "codex", installed: false },
      opencode: { id: "opencode", installed: false },
    },
    workspace: { workspace: "office-test", source: "env", root: SCRATCH },
  });
  registerOfficeRoutes(server.router);
  const port = await server.start(0);
  return { server, bus, store, base: `http://127.0.0.1:${port}` };
}

test("GET /office serves the page and hands the browser a UI session cookie", async () => {
  const { server, base } = await boot();
  try {
    const res = await fetch(`${base}/office`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");

    // The cookie is what earns a mutating control endpoint's ctx.hasUiSession() check. It
    // must be HttpOnly (no script can read it) and SameSite=Strict (no cross-site POST).
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /docket_crew_ui=[0-9a-f]{64}/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const html = await res.text();
    assert.match(html, /<title>Docket Crew — Office<\/title>/);
    assert.match(html, /id="board"/);
    assert.match(html, /id="feed"/);
    assert.match(html, /Tell the team what to do/);
    assert.match(html, /<script type="module" src="\/office\/app\.js">/);
  } finally {
    await server.stop();
  }
});

test('the Office also claims "/" and "/office/", so every printed URL works', async () => {
  const { server, base } = await boot();
  try {
    for (const path of ["/", "/office/"]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      const html = await res.text();
      assert.match(html, /Docket Crew/, path);
      assert.doesNotMatch(html, /The Office UI is not wired yet/, `${path} still served the placeholder`);
    }
  } finally {
    await server.stop();
  }
});

test("the client modules are served as real JavaScript, and nothing else is", async () => {
  const { server, base } = await boot();
  try {
    for (const name of ["app.js", "render.js"]) {
      const res = await fetch(`${base}/office/${name}`);
      assert.equal(res.status, 200, name);
      assert.match(res.headers.get("content-type") ?? "", /javascript/, name);
      const source = await res.text();
      assert.ok(source.length > 200, `${name} came back empty`);
      assert.doesNotMatch(source, /require\(/, `${name} was emitted as CommonJS — the browser cannot load it`);
    }
    // app.js must import render.js by a path the browser can actually resolve.
    const app = await (await fetch(`${base}/office/app.js`)).text();
    assert.match(app, /from ["']\.\/render\.js["']/);
    // ...and must not have kept a Node-only import from the type-only line.
    assert.doesNotMatch(app, /from ["'][^"']*types\.js["']/, "a type-only import survived into the browser bundle");
  } finally {
    await server.stop();
  }
});

test("the asset route refuses anything that is not a plain module name", async () => {
  const { server, base } = await boot();
  try {
    for (const bad of [
      "/office/../../package.json",
      "/office/..%2f..%2fpackage.json",
      "/office/App.js",
      "/office/app.ts",
      "/office/sub/app.js",
      "/office/.env",
    ]) {
      const res = await fetch(base + bad, { redirect: "manual" });
      assert.ok(res.status === 404 || res.status === 400, `${bad} answered ${res.status}`);
      const body = await res.text();
      assert.doesNotMatch(body, /"name": "@pasichdev\/docket-crew"/, `${bad} leaked a file outside the client dir`);
    }
  } finally {
    await server.stop();
  }
});

test("the page still serves when the daemon has no orchestration layer at all", async () => {
  // No control endpoints are registered by this server — /api/profiles, /api/ask and the
  // rest all 404. The page must still be a page.
  const { server, base } = await boot();
  try {
    assert.equal((await fetch(`${base}/api/profiles`)).status, 404);
    const res = await fetch(`${base}/office`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.length > 4000, "the page degraded to something empty");
    assert.match(html, /id="notice"/, "there is no place to show the user what is missing");
  } finally {
    await server.stop();
  }
});

test("a live event reaches the SSE stream the Office listens on", async () => {
  const { server, bus, base } = await boot();
  try {
    const res = await fetch(`${base}/api/events?backlog=0`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain until the stream is established, then emit and read the event back.
    await reader.read();
    await bus.publish("assignment.created", {
      agentId: "codex-1",
      summary: "Review sync and persistence.",
      data: { from: "manager-1", to: "codex-1" },
    });

    let buffer = "";
    for (let i = 0; i < 10 && !buffer.includes("assignment.created"); i++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(buffer, /event: crew/);
    assert.match(buffer, /"type":"assignment\.created"/);
    assert.match(buffer, /Review sync and persistence\./);

    // And that same payload, run through the renderer, is the feed line the page shows.
    const { feedLine } = await import("./client/render.js");
    const payload = JSON.parse(/data: (\{.*\})/.exec(buffer)![1]);
    const line = feedLine(payload, {
      "manager-1": { id: "manager-1", name: "Manager", origin: "managed", status: "idle" },
      "codex-1": { id: "codex-1", name: "Codex #1", origin: "managed", status: "working" },
    } as never);
    assert.equal(line.actor, "Manager → Codex #1");
    assert.equal(line.text, "Review sync and persistence.");

    await reader.cancel();
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// The two hazards of a template literal that no compiler can see into.
// ---------------------------------------------------------------------------

test("the markup and stylesheet strings contain no stray backtick or interpolation", () => {
  for (const [name, text] of [
    ["OFFICE_MARKUP", OFFICE_MARKUP],
    ["OFFICE_STYLES", OFFICE_STYLES],
  ] as const) {
    assert.ok(!text.includes("`"), `${name}: a literal backtick would have closed the template`);
    assert.doesNotMatch(text, /\$\{/, `${name}: an un-escaped dollar-brace interpolated at build time`);
    assert.doesNotMatch(text, /undefined|\[object Object\]/, `${name}: something interpolated badly`);
  }
});

// ---------------------------------------------------------------------------
// The composer, as it is actually served
// ---------------------------------------------------------------------------

test("the composer is one shell, and its hint states the send key it really uses", () => {
  // The hint is the only place the keybinding is written down for the user. It said
  // "Cmd/Ctrl+Enter to send" while the code sent on plain Enter for exactly as long as it took
  // to notice, which is the kind of drift a string assertion is cheap insurance against.
  assert.match(OFFICE_MARKUP, /Enter to send · Shift\+Enter for a new line/);
  assert.doesNotMatch(OFFICE_MARKUP, /Cmd\/Ctrl\+Enter to send/, "the old binding is gone from every hint");
  // The recipient strip lives INSIDE the shell — that is what makes the composer one object
  // rather than a label row floating above a field.
  const shell = OFFICE_MARKUP.slice(OFFICE_MARKUP.indexOf('class="ask-shell"'), OFFICE_MARKUP.indexOf('class="ask-hint"'));
  assert.ok(shell.includes('class="ask-to"'), "the To strip must be inside the shell");
  assert.ok(shell.includes('id="ask"'), "so must the box itself");
  assert.match(OFFICE_MARKUP, /id="ask-wrap" data-direct="false"/, "the direct state has somewhere to land");
  // A resting height and a ceiling, and the ceiling is where it starts scrolling instead.
  assert.match(OFFICE_STYLES, /height: 60px; min-height: 60px; max-height: 190px/);
  assert.match(OFFICE_STYLES, /resize: none; overflow-y: hidden/);
  assert.match(OFFICE_STYLES, /\.ask textarea\[data-full="true"\] \{ overflow-y: auto; \}/);
});

test("the live turn indicator has a place in the conversation and a live region of its own", () => {
  const scroll = OFFICE_MARKUP.slice(OFFICE_MARKUP.indexOf('id="chat-scroll"'), OFFICE_MARKUP.indexOf('id="jump"'));
  assert.ok(scroll.includes('id="turns"'), "the indicator belongs under the last thing said, inside the scroller");
  assert.match(scroll, /id="turns"[^>]*aria-hidden="true"/, "the row itself must not flood a live region");
  assert.match(scroll, /id="turns-live" role="status" aria-live="polite"/, "the announcement is the sr-only line");
  assert.ok(scroll.indexOf('id="turns"') > scroll.indexOf('id="chat"'), "it follows the conversation, not precedes it");
});

test("the test never wrote outside its scratch directory", async () => {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(SCRATCH);
  assert.ok(entries.length > 0, "the scratch tree was never used — is this test actually exercising the store?");
  assert.ok(paths.stateFile.startsWith(SCRATCH));
  assert.ok(paths.eventsFile.startsWith(SCRATCH));
  assert.ok(!SCRATCH.includes(".docket"), "the scratch root must not be inside a real docket tree");
});
