import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { PAGE } from "./views.js";

/**
 * The dashboard's entire client is one inline `<script>` inside a template literal, so it is
 * never type-checked and never executed by anything else in the suite. This runs it for
 * real, in a sandbox, and calls its own render functions.
 *
 * That matters because the store deliberately does NOT strip markup from free text —
 * `title` and `description` are legitimate user content and mangling them would be data
 * loss (see sync.hostile.test.ts). The whole safety argument therefore rests on this layer
 * escaping at render time, and until now nothing checked it.
 */
function loadPageScript(): Record<string, (...args: unknown[]) => string> {
  const source = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  const noop = () => {};
  // A permissive stand-in for anything the script touches at load time. It is not a DOM
  // implementation and does not need to be: the functions under test build strings.
  const element: any = new Proxy(function () {}, {
    get(_target, key) {
      if (key === "dataset" || key === "style") return {};
      if (key === "classList") return { add: noop, remove: noop, toggle: noop, contains: () => false };
      if (key === "children") return [];
      if (key === "value" || key === "textContent" || key === "innerHTML") return "";
      if (key === Symbol.toPrimitive) return () => "";
      return element;
    },
    set: () => true,
    apply: () => element,
    construct: () => element,
  }) as any;
  const sandbox: Record<string, unknown> = {
    document: new Proxy({}, { get: (_t, k) => (k === "documentElement" ? { dataset: {} } : element) }),
    window: element,
    location: { reload: noop, href: "" },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    fetch: () => new Promise(() => {}),
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: noop,
    console,
    EventSource: function () { return element; },
    HTMLDetailsElement: function () {},
    navigator: { clipboard: { writeText: noop } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { timeout: 5_000 });
  return sandbox as Record<string, (...args: unknown[]) => string>;
}

const page = loadPageScript();

/** Every one of these is something a peer can put in the store and the store will keep. */
const PAYLOADS = {
  script: "</script><script>alert(1)</script>",
  img: '<img src=x onerror="alert(1)">',
  attrBreak: '" onmouseover="alert(1)" x="',
  quote: "it's a \"quoted\" thing",
  amp: "a & b",
  template: "${constructor.constructor('alert(1)')()}",
};

function hostileTodo(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: "11111111-1111-7111-8111-111111111111",
    shortId: "T-AAAAAA",
    title: PAYLOADS.script,
    description: PAYLOADS.img,
    done: false,
    list: "todo",
    category: PAYLOADS.attrBreak,
    priority: null,
    dueDate: null,
    sourceUrl: null,
    agent: PAYLOADS.img,
    session: PAYLOADS.quote,
    workspace: PAYLOADS.script,
    workingAgent: null,
    workingSince: null,
    workingSession: null,
    workingLeaseExpiresAt: null,
    workingDeviceId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    revision: 1,
    localSeq: 1,
    deviceId: "device-a",
    deviceName: PAYLOADS.img,
    history: [],
    ...overrides,
  };
}

/** What must never appear in served markup, however the payload was shaped. */
function assertInert(html: string, where: string): void {
  assert.doesNotMatch(html, /<script/i, `${where}: raw <script> reached the page`);
  assert.doesNotMatch(html, /<img[^>]*onerror/i, `${where}: an executable onerror handler reached the page`);
  assert.doesNotMatch(html, /\son\w+\s*=\s*"[^"]*alert/i, `${where}: an inline event handler reached the page`);
  assert.doesNotMatch(html, /javascript:/i, `${where}: a javascript: URL reached the page`);
}

test("escapeHtml neutralises every character that can break out of text or an attribute", () => {
  for (const [name, payload] of Object.entries(PAYLOADS)) {
    const escaped = page.escapeHtml(payload);
    assert.doesNotMatch(escaped, /[<>]/, `${name}: angle brackets survived`);
    assert.doesNotMatch(escaped, /"/, `${name}: a double quote survived and can close an attribute`);
    assert.doesNotMatch(escaped, /'/, `${name}: a single quote survived`);
  }
  assert.equal(page.escapeHtml("a & b"), "a &amp; b", "ampersands must be escaped first, or every other entity is forgeable");
});

test("a card built from a hostile item is inert in every field it renders", () => {
  const html = page.itemHtml(hostileTodo());
  assertInert(html, "itemHtml");
  // ...and the content is still THERE, escaped — dropping it would be data loss, not safety.
  assert.match(html, /&lt;\/script&gt;/, "the title was dropped rather than escaped");
});

test("a category renders safely even though it lands inside an HTML attribute", () => {
  // `category` goes into title=, data-category= AND inline CSS — the attribute case is the
  // one where a bare double quote is enough, without any angle brackets at all.
  const html = page.itemHtml(hostileTodo({ category: PAYLOADS.attrBreak }));
  assertInert(html, "category attribute");
  assert.doesNotMatch(html, /data-category="[^"]*"[^>]*onmouseover/i, "the attribute was broken out of");
});

test("the edit form is inert too — it renders the same values into input attributes", () => {
  const todo = hostileTodo();
  const html = page.editFormHtml(todo);
  assertInert(html, "editFormHtml");
});

test("history rows escape the action and detail a peer supplied", () => {
  const html = page.historyRowsHtml([
    { at: "2026-01-01T00:00:00.000Z", agent: PAYLOADS.img, deviceName: "D", action: "edited", detail: PAYLOADS.script },
  ]);
  assertInert(html, "historyRowsHtml");
  assert.match(html, /&lt;/, "the payload was dropped rather than escaped");
});

test("a source link cannot become a clickable javascript: URL", () => {
  // mutations.ts already refuses to store these, so this is defence in depth: the render
  // layer must not be the only thing standing between a stored value and a click target,
  // nor the only thing that fails if the store layer ever regresses.
  for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
    assertInert(page.sourceLinkHtml(url), `sourceLinkHtml(${url})`);
  }
});

test("a well-formed item still renders its real content", () => {
  const html = page.itemHtml(hostileTodo({ title: "fix token refresh race", category: "VPQ-834", description: null, agent: "codex", deviceName: "Laptop" }));
  assert.match(html, /fix token refresh race/);
  assert.match(html, /VPQ-834/);
});
