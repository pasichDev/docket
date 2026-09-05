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
  // Test-only epilogue. `activeTag` is a top-level `let`, which vm keeps in the script's
  // lexical scope and out of the sandbox object; a closure compiled with the script is the
  // only way to reach it without reshaping production code to suit the test.
  vm.runInContext(
    `${source}\nglobalThis.__setActiveTag = (v) => { activeTag = v; };\nglobalThis.__UNFILED = UNFILED;`,
    sandbox,
    { timeout: 5_000 },
  );
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

/**
 * The weaker of the two guarantees, and the right one for rendered markdown: the text is
 * allowed to SAY "javascript:", because refusing to show what someone wrote would be data
 * loss — it must simply never be wired to anything that runs.
 */
function assertNothingExecutable(html: string, where: string): void {
  assert.doesNotMatch(html, /<script/i, `${where}: raw <script> reached the page`);
  assert.doesNotMatch(html, /\son\w+\s*=/i, `${where}: an inline event handler reached the page`);
  assert.doesNotMatch(html, /(href|src)\s*=\s*"[^"]*(javascript|data|vbscript):/i, `${where}: a live non-http URL reached an attribute`);
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

/* ===========================================================================================
 * Markdown
 *
 * renderMarkdown is the one place in the app that deliberately turns stored text into markup,
 * so it is also the only place where "escape at render time" could quietly stop being true.
 * Its whole safety argument is an ordering claim — escapeHtml runs over the entire source
 * before any rule can match — and these are what hold that claim up.
 * =========================================================================================== */

const NUL = "\u0000";

test("markdown: every hostile payload survives as text and none of it as markup", () => {
  for (const [name, payload] of Object.entries(PAYLOADS)) {
    assertInert(page.renderMarkdown(payload), `renderMarkdown(${name})`);
  }
  // Escaped, not dropped: a description is content, and silently eating it is data loss.
  assert.match(page.renderMarkdown(PAYLOADS.script), /&lt;script&gt;/);
});

test("markdown: a link is only ever a link when it points at http or https", () => {
  for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "/etc/passwd"]) {
    const html = page.renderMarkdown(`[click me](${href})`);
    assertNothingExecutable(html, `renderMarkdown link ${href}`);
    assert.doesNotMatch(html, /<a\s/i, `${href} became a clickable link`);
    assert.match(html, /click me/, `${href}: the label was dropped instead of shown as text`);
  }
  const good = page.renderMarkdown("[docs](https://example.com/a?b=1&c=2)");
  assert.match(good, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2"/, "a real https link should render");
  assert.match(good, /rel="noopener noreferrer"/, "an external link must not hand over window.opener");
});

test("markdown: a quote inside a link target cannot break out of the href attribute", () => {
  // No whitespace, so the link rule matches the whole thing — and it stays harmless only
  // because escapeHtml turned that quote into &quot; before the rule ran. This is the test
  // that fails first if the escape ever moves to after the markdown pass.
  const html = page.renderMarkdown('[x](https://a"onmouseover="alert(1))');
  assertInert(html, "href breakout");
  assert.doesNotMatch(html, /href="[^"]*"\s*onmouseover/i, "the href attribute was broken out of");
});

test("markdown: a bare URL is linkified, and a bare javascript: URL is not", () => {
  assert.match(page.renderMarkdown("see https://example.com/x for more"), /<a href="https:\/\/example\.com\/x"/);
  const bare = page.renderMarkdown("see javascript:alert(1) for more");
  assertNothingExecutable(bare, "bare javascript URL");
  assert.doesNotMatch(bare, /<a\s/i, "a javascript: URL was autolinked");
});

test("markdown: a fenced code block shows markup instead of running it", () => {
  const html = page.renderMarkdown('```\n<img src=x onerror="alert(1)">\n```');
  assertInert(html, "fenced code");
  assert.match(html, /<pre><code>/, "the fence did not produce a code block");
  assert.match(html, /&lt;img/, "the code sample was dropped rather than shown");
});

test("markdown: stored text cannot address the internal placeholder table", () => {
  // mdInline parks finished HTML behind NUL-delimited markers. A description carrying one
  // could otherwise name a slot and have it substituted in.
  const html = page.renderMarkdown(`${NUL}0${NUL} and \`real code\``);
  assertInert(html, "placeholder injection");
  assert.doesNotMatch(html, new RegExp(NUL), "a NUL marker reached the page");
  assert.match(html, /<code>real code<\/code>/, "the genuine code span stopped working");
});

test("markdown: the ordinary syntax people actually type renders", () => {
  const html = page.renderMarkdown(
    "# Heading\n\nSome **bold** and *italic* and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n---\n",
  );
  assert.match(html, /<h3>Heading<\/h3>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote>quoted<\/blockquote>/);
  assert.match(html, /<hr>/);
});

test("markdown: a held span nested inside another one is still expanded", () => {
  // mdInline parks finished HTML behind markers, and a marker can land INSIDE the next
  // thing it parks. "[`config.ts`](url)" — an everyday shape in a dev note — expanded only
  // the outer link, leaving the inner marker in the output as a raw NUL and the filename
  // gone entirely. The expansion has to repeat until nothing is left to expand.
  const html = page.renderMarkdown("[`config.ts`](https://example.com/a)");
  assert.match(html, /<a href="https:\/\/example\.com\/a"[^>]*><code>config\.ts<\/code><\/a>/);
  assert.doesNotMatch(html, new RegExp(NUL), "a placeholder marker reached the page");

  // Same cause, other direction: emphasis inside a link label.
  assert.match(page.renderMarkdown("[**x**](https://example.com)"), /<strong>x<\/strong>/);
});

test("markdown: a bare URL beside a code span cannot swallow the marker into its href", () => {
  const html = page.renderMarkdown("see https://example.com/x `p` end");
  assert.doesNotMatch(html, new RegExp(NUL), "a marker was absorbed into the URL");
  assert.match(html, /href="https:\/\/example\.com\/x"/, "the href picked up more than the URL");
  assert.match(html, /<code>p<\/code>/, "the code span was destroyed");
});

test("markdown: prose that merely contains * or _ is left alone", () => {
  // Descriptions are mostly not markup. Emphasis follows CommonMark's flanking rule, so a
  // marker with whitespace just inside it is text — otherwise these two, both ordinary
  // things for an agent to write, came out italicised with the middle eaten.
  assert.equal(page.renderMarkdown("rename *.js to *.ts in src/"), "<p>rename *.js to *.ts in src/</p>");
  assert.equal(page.renderMarkdown("the _id and _rev fields"), "<p>the _id and _rev fields</p>");
  // ...while real emphasis still works.
  assert.match(page.renderMarkdown("a *real* one"), /<em>real<\/em>/);
  assert.match(page.renderMarkdown("a **strong** one"), /<strong>strong<\/strong>/);
});

test("markdown: a four-space indented block keeps its shape", () => {
  // .card-desc used to be white-space: pre-wrap, so a pasted stack trace survived. Block
  // rendering had to drop that, and this rule is what replaces it.
  const html = page.renderMarkdown("Crash:\n\n    at foo (bar.ts:12)\n    at baz (qux.ts:7)");
  assert.match(html, /<pre><code>at foo \(bar\.ts:12\)\nat baz \(qux\.ts:7\)<\/code><\/pre>/);
});

test("markdown: a URL on its own continuation line is still linkified", () => {
  // Paragraph lines are joined with <br> before the inline pass, so the character before
  // such a URL is ">" rather than a space or the start of the string.
  assert.match(page.renderMarkdown("Ref:\nhttps://example.com/issue/1"), /<br><a href="https:\/\/example\.com\/issue\/1"/);
});

test("markdown: no rendering of any shape leaks a placeholder marker", () => {
  const shapes = [
    "[`a`](https://x.com) `b` **c**",
    "`a` https://x.com/`b`",
    "[**[`x`](https://y.com)**](https://z.com)",
    "```\n`inner`\n```",
    "- [`f`](https://x.com)\n- *g*",
    "> quoted [`h`](https://x.com)",
  ];
  for (const shape of shapes) {
    assert.doesNotMatch(page.renderMarkdown(shape), new RegExp(NUL), `marker leaked from: ${shape}`);
  }
});

test("markdown: an empty or absent description renders nothing at all", () => {
  for (const empty of [null, undefined, ""]) {
    assert.equal(page.renderMarkdown(empty), "", `${String(empty)} should render as nothing`);
  }
});

/* ---- preview clamping ------------------------------------------------------------------ */

interface Clamped { text: string; truncated: boolean }
const clamp = (src: string, max: number) => page.clampMarkdown(src, max) as unknown as Clamped;

test("clampMarkdown: short text is returned untouched and unflagged", () => {
  // Field by field, not deepEqual: the object comes back from the vm realm, so it does not
  // share this realm's Object.prototype and strict deep equality would fail on that alone.
  const { text, truncated } = clamp("just a line", 300);
  assert.equal(text, "just a line");
  assert.equal(truncated, false);
});

test("clampMarkdown: long text is cut to the limit, on a word boundary, and flagged", () => {
  const long = "word ".repeat(200);
  const { text, truncated } = clamp(long, 300);
  assert.equal(truncated, true);
  assert.ok(text.length <= 300, `preview was ${text.length} characters`);
  assert.doesNotMatch(text, /\s$/, "the cut left trailing whitespace");
  assert.ok(long.startsWith(text), "the preview is not a prefix of the real description");
});

test("clampMarkdown: a cut landing inside a code fence drops back to before it", () => {
  // Otherwise the preview renders an unterminated fence, which swallows the rest of the card.
  const src = `${"a".repeat(250)}\n\`\`\`\n${"code line\n".repeat(10)}\`\`\``;
  const { text } = clamp(src, 300);
  assert.equal((text.match(/```/g) ?? []).length % 2, 0, "the preview ends inside an open code fence");
  assertInert(page.renderMarkdown(text), "clamped preview");
});

/* ---- the two de-duplication rules the redesign rests on --------------------------------- */

const setActiveTag = (value: string) => (page as unknown as { __setActiveTag: (v: string) => void }).__setActiveTag(value);
const plainTodo = (extra: Record<string, unknown>) => hostileTodo({ description: null, category: null, agent: null, ...extra });

test('card: "via web" is suppressed, because web is the surface you are already looking at', () => {
  assert.doesNotMatch(page.itemHtml(plainTodo({ agent: "web", session: null })), /via web/,
    "every card repeated the one agent value that says nothing");
  // The agent worth naming — the whole reason Docket exists — still shows.
  assert.match(page.itemHtml(plainTodo({ agent: "claude-code", session: null })), /via claude-code/,
    "the agent worth naming was suppressed too");
});

test("card: the Todo/Backlog badge disappears once the tag row has already said it", () => {
  const item = plainTodo({ list: "todo" });
  setActiveTag("all");
  assert.match(page.itemHtml(item), /list-badge/, "unfiltered, a card should still say which list it is in");
  setActiveTag("todo");
  assert.doesNotMatch(page.itemHtml(item), /list-badge/, "filtered to Todo, every card still repeated 'Todo'");
  setActiveTag("all");
});

test("card: a long description is previewed rather than printed whole", () => {
  const long = "sentence about the work. ".repeat(60);
  const html = page.itemHtml(hostileTodo({ description: long }));
  assert.match(html, /class="read-more"/, "no way to reach the rest of the description");
  assert.ok(!html.includes(long), "the whole description was rendered onto the card");
  assert.doesNotMatch(page.itemHtml(hostileTodo({ description: "one short note" })), /class="read-more"/,
    "a short description does not need a Read more");
});

test('"no project" cannot be impersonated by anything a peer is able to store', () => {
  const unfiled = (page as unknown as { __UNFILED: symbol }).__UNFILED;

  // Two earlier sentinels were strings, and both were wrong. A NUL prefix is rewritten to
  // U+FFFD by the HTML parser, so the control held a value no item could match. "~unfiled"
  // was unreachable only through slugifyWorkspace — which the CLI applies but the web API
  // (textOrNull) and sync (nullableString) do not, so a crafted POST or a peer record could
  // carry it verbatim and fold a real project into the Unfiled bucket.
  assert.equal(typeof unfiled, "symbol", "a string sentinel is forgeable by anything that can set a workspace");

  for (const forged of ["~unfiled", `${String.fromCharCode(0)}unfiled`, "unfiled", "Unfiled"]) {
    assert.notEqual(
      page.workspaceOf({ workspace: forged }),
      unfiled,
      `a project literally named ${JSON.stringify(forged)} was treated as "no project"`,
    );
  }
  assert.equal(page.workspaceOf({ workspace: null }), unfiled, "a genuinely unfiled item lost its bucket");
});

test("card: the id is a button carrying the value it copies", () => {
  assert.match(page.itemHtml(plainTodo({})), /<button class="id"[^>]*data-copy="T-AAAAAA"/, "the id is not copyable");
});

test("the edit form ships a markdown editor wired to the description", () => {
  // Default hostile description, so this also covers the textarea: markdown lives in an
  // editor now, and the raw source going back into that box must still be escaped.
  const html = page.editFormHtml(hostileTodo());
  assert.match(html, /class="md-editor"/);
  assert.match(html, /data-md="bold"/, "no formatting controls");
  assert.match(html, /data-mode="preview"/, "no way to see what the markdown will look like");
  assert.match(html, /&lt;img src=x/, "the description was not escaped into the textarea");
});
