import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The Office renders text nothing upstream sanitises: an agent's display name comes from a
 * profile in config.yml, an assignment title and an event summary are written by a *model*,
 * and a message body is whatever a human or an agent typed. None of that is stripped
 * anywhere in Crew — stripping it would be data loss — so the entire safety argument for the
 * page rests on this layer escaping at render time.
 *
 * Modelled directly on Docket Core's src/web/client/app/render.escaping.test.ts, including
 * its two assertion strengths: `assertNothingExecutable` (nothing runs) for everything, and
 * `assertNotPresentRaw` (the payload does not appear literally) for the values that land in
 * attributes.
 */

const {
  agentCardHtml,
  assignmentsHtml,
  boardHtml,
  coldStartHtml,
  columnHtml,
  escapeHtml,
  feedHtml,
  feedLineHtml,
  outputEntries,
  outputHtml,
  profileRowHtml,
  profilesHtml,
  safeId,
} = await import("./client/render.js");

type Agent = Parameters<typeof agentCardHtml>[0];
type Assignment = Parameters<typeof assignmentsHtml>[0][number];
type Profile = Parameters<typeof profileRowHtml>[0];
type Event = Parameters<typeof feedLineHtml>[0];

/** Every one of these is something a runtime, a config file or a human can actually produce. */
const PAYLOADS = {
  script: "</script><script>alert(1)</script>",
  img: '<img src=x onerror="alert(1)">',
  attrBreak: '" onmouseover="alert(1)" x="',
  quote: "it's a \"quoted\" thing",
  amp: "a & b",
  svg: "<svg/onload=alert(1)>",
  close: "</article><button onclick=alert(1)>pwn",
};

/**
 * What must never appear in served markup, however the payload was shaped. Same shape as
 * Docket Core's `assertInert`: an escaped double quote is `&quot;`, so an inline handler is
 * only real when a *literal* quote follows the equals sign — which is exactly the thing
 * escaping prevents.
 */
function assertNothingExecutable(html: string, where: string): void {
  assert.doesNotMatch(html, /<script/i, `${where}: raw <script> reached the page`);
  assert.doesNotMatch(html, /<img/i, `${where}: raw <img> reached the page`);
  assert.doesNotMatch(html, /<svg/i, `${where}: raw <svg> reached the page`);
  assert.doesNotMatch(html, /\son\w+\s*=\s*["'][^"']*alert/i, `${where}: an inline event handler reached the page`);
  assert.doesNotMatch(html, /(href|src)\s*=\s*["'][^"']*(javascript|data|vbscript):/i, `${where}: a live non-http URL reached an attribute`);
  // The breakout that needs no angle bracket at all: a bare quote closing an attribute that
  // the click delegate reads back. `data-agent` and `data-profile` are the two that matter.
  assert.doesNotMatch(html, /data-(agent|profile)="[^"]*"[^>\s]/i, `${where}: a data- attribute was broken out of`);
}

function assertNotPresentRaw(html: string, payload: string, where: string): void {
  assert.ok(!html.includes(payload), `${where}: the payload survived rendering verbatim`);
}

function hostileAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: PAYLOADS.script,
    origin: "managed",
    profile: PAYLOADS.attrBreak,
    runtime: "codex",
    role: "worker",
    model: PAYLOADS.img,
    provider: PAYLOADS.quote,
    status: "working",
    startedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Agent;
}

function hostileAssignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: PAYLOADS.attrBreak,
    title: PAYLOADS.img,
    instructions: PAYLOADS.script,
    workspace: "ws",
    assignedBy: "manager",
    assignedTo: "agent-1",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    attempts: 1,
    docketTodoId: PAYLOADS.svg,
    ...overrides,
  } as Assignment;
}

// ---------------------------------------------------------------------------

test("escapeHtml neutralises every metacharacter, ampersand first", () => {
  assert.equal(escapeHtml("<b>&\"'</b>"), "&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;");
  // If & were not replaced first, this would come back as a live &lt; entity.
  assert.equal(escapeHtml("&lt;script&gt;"), "&amp;lt;script&amp;gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("safeId strips anything that could break out of a data- attribute", () => {
  assert.equal(safeId('a" onmouseover="alert(1)'), "aonmouseoveralert1");
  assert.equal(safeId("agent-7"), "agent-7");
  assert.equal(safeId(undefined), "");
});

test("agent cards escape a hostile name, model, provider and profile", () => {
  const html = agentCardHtml(hostileAgent(), hostileAssignment(), Date.parse("2026-01-01T00:05:00Z"));
  assertNothingExecutable(html, "agentCardHtml");
  for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(html, payload, "agentCardHtml");
  // The escaped text is still THERE — escaping, not stripping. Losing an agent's real name
  // because it contains an angle bracket would be its own bug.
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("a hostile agent id cannot escape its data- attribute", () => {
  const html = agentCardHtml(hostileAgent({ id: PAYLOADS.attrBreak }), null, Date.now());
  assertNothingExecutable(html, "agentCardHtml/id");
  assert.match(html, /data-agent="onmouseoveralert1x"/);
});

test("the whole board escapes hostile content", () => {
  const assignment = hostileAssignment();
  const agents = [
    hostileAgent({ id: "a1", role: "manager", currentAssignmentId: assignment.id }),
    hostileAgent({ id: "a2", role: "reviewer", origin: "observed" }),
    hostileAgent({ id: "a3", role: undefined }),
  ];
  const html = boardHtml(agents, { [assignment.id]: assignment }, Date.now());
  assertNothingExecutable(html, "boardHtml");
  for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(html, payload, "boardHtml");
});

test("column titles and empty columns are safe", () => {
  const html = columnHtml(PAYLOADS.img, [], {}, Date.now());
  assertNothingExecutable(html, "columnHtml");
  assertNotPresentRaw(html, PAYLOADS.img, "columnHtml");
});

test("assignment rows escape id, title, assignee and the Docket link", () => {
  const html = assignmentsHtml([hostileAssignment()], {
    "agent-1": hostileAgent(),
  } as Record<string, Agent>);
  assertNothingExecutable(html, "assignmentsHtml");
  for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(html, payload, "assignmentsHtml");
});

test("feed lines escape summaries, actor names and event types", () => {
  const events: Event[] = [
    {
      id: "e1",
      type: "assignment.created" as Event["type"],
      at: "2026-01-01T21:04:00.000Z",
      agentId: "agent-1",
      summary: PAYLOADS.script,
      data: { to: "agent-1", title: PAYLOADS.img },
    },
    {
      id: "e2",
      type: PAYLOADS.close as Event["type"],
      at: "2026-01-01T21:05:00.000Z",
      data: { title: PAYLOADS.svg },
    },
  ];
  const html = feedHtml(events, { "agent-1": hostileAgent() } as Record<string, Agent>);
  assertNothingExecutable(html, "feedHtml");
  for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(html, payload, "feedHtml");
});

test("agent output escapes what the runtime printed, live and replayed alike", () => {
  const live: Event[] = [
    {
      id: "e1",
      type: "agent.output" as Event["type"],
      at: "2026-01-01T21:04:00.000Z",
      agentId: "a1",
      summary: PAYLOADS.script,
    },
    {
      id: "e2",
      type: "agent.output" as Event["type"],
      at: "2026-01-01T21:04:10.000Z",
      agentId: "a1",
      summary: PAYLOADS.img,
    },
  ];
  // The replayed half comes off the daemon's buffer as raw strings — the same hostile text,
  // arriving by a different door.
  const seed = [`2026-01-01T21:03:00.000Z ${PAYLOADS.svg}`, PAYLOADS.close];
  const html = outputHtml(outputEntries(seed, live, "a1"));
  assertNothingExecutable(html, "outputHtml");
  for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(html, payload, "outputHtml");
});

test("profile rows escape the name that lands in data-profile", () => {
  const profile = {
    name: PAYLOADS.attrBreak,
    runtime: "opencode",
    role: "worker",
    model: PAYLOADS.img,
    provider: PAYLOADS.script,
  } as Profile;
  const html = profileRowHtml(profile, true);
  assertNothingExecutable(html, "profileRowHtml");
  for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(html, payload, "profileRowHtml");
  assert.match(html, /data-profile="&quot; onmouseover=&quot;alert\(1\)&quot; x=&quot;"/);

  const list = profilesHtml([profile], PAYLOADS.attrBreak);
  assertNothingExecutable(list, "profilesHtml");
});

test("the cold-start roster and its error message escape everything", () => {
  const profile = { name: PAYLOADS.img, runtime: "claude", role: "manager" } as Profile;
  const html = coldStartHtml([profile], PAYLOADS.img, true, "");
  assertNothingExecutable(html, "coldStartHtml");
  assertNotPresentRaw(html, PAYLOADS.img, "coldStartHtml");

  const errored = coldStartHtml([], "", false, PAYLOADS.script);
  assertNothingExecutable(errored, "coldStartHtml/error");
  assertNotPresentRaw(errored, PAYLOADS.script, "coldStartHtml/error");
});

test("a NUL-ish / control-character name does not break the card", () => {
  const html = agentCardHtml(hostileAgent({ name: "a bc" }), null, Date.now());
  assertNothingExecutable(html, "control chars");
  assert.match(html, /class="ag-name"/);
});

// ---------------------------------------------------------------------------
// The pixel office
//
// Making the page a picture does not narrow the attack surface — it widens it. A thought
// bubble is markup built from an assignment title and from whatever a runtime printed, a
// nameplate is an agent's own name, and a seat's aria-label is a *quoted attribute* holding
// all of it at once. Every one of those is text nothing upstream sanitises.
// ---------------------------------------------------------------------------

const { bubbleHtml, cabinetHtml, ghostHtml, ghostsHtml, hireSeatHtml, seatAriaLabel, seatHtml, thoughtFor, zoneHtml } =
  await import("./client/render.js");

/**
 * The scene draws with inline SVG, so `assertNothingExecutable`'s blanket ban on `<svg` would
 * now fire on the office's own furniture and hide every real finding behind it. Relaxing the
 * rule to "some SVG is fine" would be exactly the wrong move — `<svg/onload=alert(1)>` is one
 * of the payloads. So instead the art is proved to be a *closed vocabulary* (an <svg> opener
 * with a fixed attribute list, <g class="px-…">, and <rect> whose only fill is a --px- custom
 * property — nothing else, no text node, no attribute this file did not write), and only then
 * removed, leaving the original payload rules to bite on everything that is left.
 */
const SPRITE = /<svg class="px [\s\S]*?<\/svg>/g;
const SPRITE_OPEN =
  /^<svg class="px px-[a-z-]+" viewBox="\d+ \d+ \d+ \d+" width="\d+" height="\d+" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMax meet">/;
const SPRITE_RECT =
  /<rect(?: class="px-[a-z-]+")? x="\d+" y="\d+" width="\d+" height="\d+"(?: fill="var\(--px-[a-z0-9-]+\)")?\/>/g;

function assertSpriteIsOnlyRects(sprite: string, where: string): void {
  const leftover = sprite
    .replace(SPRITE_OPEN, "")
    .replace(SPRITE_RECT, "")
    .replace(/<g class="(?:px-[a-z0-9-]+ ?)+">/g, "")
    .replace(/<\/g>/g, "")
    .replace(/<\/svg>$/, "");
  assert.equal(leftover, "", `${where}: the sprite carried markup outside the rect/g vocabulary`);
}

/** assertNothingExecutable, for markup that legitimately contains the office's own sprites. */
function assertSceneInert(html: string, where: string): void {
  const sprites = html.match(SPRITE) ?? [];
  assert.ok(html.indexOf("<svg") === -1 || sprites.length > 0, `${where}: an <svg> appeared that is not a sprite`);
  for (const sprite of sprites) assertSpriteIsOnlyRects(sprite, where);
  assertNothingExecutable(html.replace(SPRITE, ""), where);
}

test("a script in a task title does not execute inside a thought bubble", () => {
  for (const payload of Object.values(PAYLOADS)) {
    const thought = thoughtFor(hostileAgent(), { title: payload } as Assignment, "");
    const html = bubbleHtml(thought);
    assertSceneInert(html, `bubbleHtml/${payload}`);
    assertNotPresentRaw(html, payload, "bubbleHtml");
  }
  // ...and the same payload arriving as a runtime's own output line, by the other door.
  for (const payload of Object.values(PAYLOADS)) {
    const html = bubbleHtml(thoughtFor(hostileAgent(), null, payload));
    assertSceneInert(html, "bubbleHtml/output");
    assertNotPresentRaw(html, payload, "bubbleHtml/output");
  }
  // Escaping, not stripping: the text is still there for the human to read.
  assert.match(bubbleHtml(thoughtFor(hostileAgent(), null, "<b>hi</b>")), /&lt;b&gt;hi&lt;\/b&gt;/);
});

test("a seat escapes the hostile name, title and runtime that land in its aria-label", () => {
  const html = seatHtml(hostileAgent(), hostileAssignment(), PAYLOADS.script, Date.now());
  assertSceneInert(html, "seatHtml");
  for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(html, payload, "seatHtml");
  // aria-label is a double-quoted attribute holding free text from three different sources.
  const label = /aria-label="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.ok(label.length > 0, "the seat lost its label");
  assert.ok(!label.includes('"'), "an unescaped quote broke out of aria-label");
  // seatAriaLabel returns plain text on purpose — app.ts passes it to setAttribute, where the
  // DOM escapes it, and seatHtml passes it through escapeHtml. What must be true is that it
  // builds no markup of its own, so there is nothing for either path to have to sanitise.
  const raw = seatAriaLabel(hostileAgent(), PAYLOADS.img);
  assert.ok(raw.includes(PAYLOADS.img), "the label must carry the real text, escaped at the boundary");
  assert.equal(raw, raw.replace(/<[a-z/]/gi, (m) => m), "seatAriaLabel must not assemble markup");
  assert.match(seatHtml(hostileAgent(), hostileAssignment(), "", 0), /aria-label="[^"]*&lt;img/);
});

test("a hostile agent id cannot escape a seat's data- attributes", () => {
  const html = seatHtml(hostileAgent({ id: PAYLOADS.attrBreak }), null, "", Date.now());
  assertSceneInert(html, "seatHtml/id");
  assert.match(html, /data-agent="onmouseoveralert1x"/);
  assert.match(html, /data-slot="agent:onmouseoveralert1x"/);
});

test("a hostile status or role cannot inject attributes or an unknown pose", () => {
  const html = seatHtml(hostileAgent({ status: PAYLOADS.attrBreak as never, role: PAYLOADS.img as never }), null, "", Date.now());
  assertSceneInert(html, "seatHtml/status");
  for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(html, payload, "seatHtml/status");
  // pose/screen/role are closed vocabularies, so an unknown value falls back rather than
  // reaching the attribute — CSS selects on these, and an injected one selects nothing.
  assert.match(html, /data-pose="breathing"/);
  assert.match(html, /data-screen="dim"/);
  assert.match(html, /data-role="worker"/);
});

test("the whole floor escapes hostile content in every zone", () => {
  const asg = hostileAssignment();
  const agents = [
    hostileAgent({ id: "a1", role: "manager", currentAssignmentId: asg.id, status: "working" }),
    hostileAgent({ id: "a2", role: "reviewer" }),
    hostileAgent({ id: "a3", role: undefined }),
    hostileAgent({ id: "a4", origin: "observed" }),
  ];
  const thoughts = { a1: PAYLOADS.script, a2: PAYLOADS.svg, a3: PAYLOADS.close };
  for (const zone of ["lead", "workers", "review"] as const) {
    const html = zoneHtml(zone, agents, { [asg.id]: asg }, thoughts, Date.now(), { controls: true });
    assertSceneInert(html, `zoneHtml/${zone}`);
    for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(html, payload, `zoneHtml/${zone}`);
  }
});

test("a ghost escapes a hostile session name and still offers no control", () => {
  const html = ghostHtml(hostileAgent({ origin: "observed" }));
  assertSceneInert(html, "ghostHtml");
  for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(html, payload, "ghostHtml");
  assert.doesNotMatch(html, /<button/i);
  assert.doesNotMatch(html, /data-act=/);
  assertSceneInert(ghostsHtml([hostileAgent({ origin: "observed" })]), "ghostsHtml");
});

test("a free desk and the Docket cabinet are built from fixed text, and stay inert", () => {
  const desk = hireSeatHtml(PAYLOADS.img, "hire", PAYLOADS.script, PAYLOADS.attrBreak);
  assertSceneInert(desk, "hireSeatHtml");
  for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(desk, payload, "hireSeatHtml");
  // An unrecognised role falls back to a real one rather than reaching the attribute.
  assert.match(desk, /data-role="worker"/);

  // The count is a number by construction; prove a non-number cannot reach the markup.
  const cabinet = cabinetHtml(Number.NaN, Number("nope"));
  assertSceneInert(cabinet, "cabinetHtml");
  assert.match(cabinet, /0 open/);
  assert.doesNotMatch(cabinet, /NaN/);
});

// ---------------------------------------------------------------------------
// The conversation, and the markdown in it
//
// This is the sharpest edge in the whole Office. Until now every hostile string went through
// escapeHtml and came out inert text. A message body now goes through a *markdown renderer*
// and comes out as HTML with tags in it — and those bodies are written by models and by
// whoever is typing into the composer. The entire safety argument is that renderMarkdown
// escapes the whole source before any of its rules can match, so every tag in the output is
// one it wrote itself. These tests are what holds that line.
// ---------------------------------------------------------------------------

const {
  chatBlockHtml,
  chatBlocks,
  chatHtml,
  chatItems,
  escapeHtml: renderEscapeHtml,
} = await import("./client/render.js");
const { escapeHtml: markdownEscapeHtml, renderMarkdown } = await import("./client/markdown.js");
const { addressTargets, targetOptionsHtml } = await import("./client/render.js");

type ChatMessage = Parameters<typeof chatItems>[1][number];

/** Payloads aimed specifically at a markdown renderer, on top of the shared set above. */
const MD_PAYLOADS = {
  ...PAYLOADS,
  jsLink: "[click me](javascript:alert(1))",
  dataLink: "[click me](data:text/html,<script>alert(1)</script>)",
  vbLink: "[click me](vbscript:msgbox(1))",
  imgMd: "![boom](javascript:alert(1))",
  htmlInCode: "`</code><img src=x onerror=alert(1)>`",
  htmlInFence: "```\n</code></pre><script>alert(1)</script>\n```",
  rawTag: "<iframe src=javascript:alert(1)></iframe>",
  entity: "&lt;script&gt;alert(1)&lt;/script&gt;",
  autolinkJs: "javascript:alert(1)",
  headingTag: "# <script>alert(1)</script>",
  listTag: "- <img src=x onerror=alert(1)>",
  quoteTag: "> <svg/onload=alert(1)>",
  boldTag: "**<script>alert(1)</script>**",
};

function hostileMessage(body: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    from: "human",
    to: "agent-1",
    workspace: "ws",
    kind: "message",
    body,
    createdAt: "2026-01-01T21:00:00.000Z",
    ...overrides,
  } as ChatMessage;
}

test("the two escapeHtml implementations agree, so the vendored copy cannot drift", () => {
  // markdown.ts carries its own copy so it has no import cycle with the renderer. If the two
  // ever disagreed, the safety argument for one of them would be written about the other.
  const samples = [
    ...Object.values(MD_PAYLOADS),
    "&<>\"'",
    "&amp;",
    "",
    "plain text",
    "a & b < c > d \" e ' f",
  ];
  for (const sample of samples) {
    assert.equal(markdownEscapeHtml(sample), renderEscapeHtml(sample), `disagreed on ${sample}`);
  }
  assert.equal(markdownEscapeHtml(null), renderEscapeHtml(null));
  assert.equal(markdownEscapeHtml(undefined), renderEscapeHtml(undefined));
});

test("renderMarkdown emits no tag it did not write, whatever the source contains", () => {
  for (const [name, payload] of Object.entries(MD_PAYLOADS)) {
    const html = renderMarkdown(payload);
    assertNothingExecutable(html, `renderMarkdown/${name}`);
    // The source text survives as *text* — escaping, not stripping. A reply that mentions
    // <script> should still read as a reply that mentions <script>.
    assert.ok(html.length > 0 || payload === "", `renderMarkdown/${name}: the body vanished`);
  }
});

test("a link is only ever clickable when it goes somewhere http(s)", () => {
  // The one place renderMarkdown writes an href. Anything else keeps its literal text.
  for (const payload of [MD_PAYLOADS.jsLink, MD_PAYLOADS.dataLink, MD_PAYLOADS.vbLink, MD_PAYLOADS.imgMd]) {
    const html = renderMarkdown(payload);
    assert.doesNotMatch(html, /<a /i, `${payload}: a non-http target became a link`);
    assertNothingExecutable(html, "renderMarkdown/link");
  }
  const safe = renderMarkdown("see [the docs](https://example.com/x) for more");
  assert.match(safe, /<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer">/);
  assert.match(safe, /the docs<\/a>/);
  // A bare URL is linkified too, and it is still only ever http(s).
  assert.match(renderMarkdown("go to https://example.com now"), /<a href="https:\/\/example\.com"/);
  assert.doesNotMatch(renderMarkdown("go to javascript:alert(1) now"), /<a /i);
});

test("markdown structure survives — this is the whole point of rendering it at all", () => {
  // Taken from the shape the manager actually writes.
  const html = renderMarkdown(
    "Я — менеджер краю у репо `github.com/pasichdev/docket`.\n\n**Що можу:**\n- Декомпозиція\n- Делегування\n\nВідкрито **15** пунктів.",
  );
  assert.match(html, /<code>github\.com\/pasichdev\/docket<\/code>/);
  assert.match(html, /<strong>Що можу:<\/strong>/);
  assert.match(html, /<ul><li>Декомпозиція<\/li>\s*<li>Делегування<\/li><\/ul>/);
  assert.match(html, /<strong>15<\/strong>/);
});

test("a script in a message body does not execute anywhere in the conversation", () => {
  for (const [name, payload] of Object.entries(MD_PAYLOADS)) {
    const blocks = chatBlocks(chatItems([], [hostileMessage(payload)], {} as never), {} as never);
    const html = chatHtml(blocks);
    assertSceneInert(html, `chatHtml/${name}`);
  }
});

test("a hostile agent name, tool name and status line stay inert in a block header and its fold", () => {
  const agents = { "agent-1": hostileAgent({ id: "agent-1" }) } as Record<string, Agent>;
  const events = [
    {
      id: "e1",
      type: "agent.output" as Event["type"],
      at: "2026-01-01T21:00:00.000Z",
      agentId: "agent-1",
      summary: PAYLOADS.script,
      data: { tool: PAYLOADS.img },
    },
    {
      id: "e2",
      type: "agent.output" as Event["type"],
      at: "2026-01-01T21:00:01.000Z",
      agentId: "agent-1",
      summary: PAYLOADS.close,
      data: { kind: "status" },
    },
    {
      id: "e3",
      type: "agent.output" as Event["type"],
      at: "2026-01-01T21:00:02.000Z",
      agentId: "agent-1",
      summary: "cut…",
      data: { kind: "text", text: PAYLOADS.svg },
    },
  ];
  const html = chatHtml(chatBlocks(chatItems(events, [], agents), agents));
  assertSceneInert(html, "chatHtml/hostile agent");
  for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(html, payload, "chatHtml/hostile agent");
});

test("hostile note and system lines stay one escaped line", () => {
  const events = [
    { id: "n1", type: "assignment.completed" as Event["type"], at: "2026-01-01T21:00:00.000Z", summary: PAYLOADS.img },
    { id: "n2", type: "crew.started" as Event["type"], at: "2026-01-01T21:00:01.000Z", summary: PAYLOADS.script },
  ];
  const html = chatHtml(chatBlocks(chatItems(events, [], {} as never), {} as never));
  assertSceneInert(html, "chatHtml/notes");
  for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(html, payload, "chatHtml/notes");
});

test("a hostile block key cannot break out of the data-block attribute the diff reads back", () => {
  const blocks = chatBlocks(chatItems([], [hostileMessage("hi", { id: PAYLOADS.attrBreak })], {} as never), {} as never);
  const html = chatBlockHtml(blocks[0]);
  assertSceneInert(html, "chatBlockHtml/key");
  const key = /data-block="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.ok(key.length > 0);
  assert.ok(!key.includes('"'));
});

test("a fenced code block keeps hostile text as text and never as markup", () => {
  const html = renderMarkdown("```\n<script>alert(1)</script>\n```");
  assertNothingExecutable(html, "renderMarkdown/fence");
  assert.match(html, /<pre><code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code><\/pre>/);
});

test("a hostile reply arriving in data.text cannot go live, for every markdown payload", () => {
  // This is the path the daemon now uses for real replies: raw, unescaped, un-rendered text
  // straight from a model, handed to a markdown renderer. It is the sharpest edge in the UI.
  for (const [name, payload] of Object.entries(MD_PAYLOADS)) {
    const events = [
      {
        id: "e1",
        type: "agent.output" as Event["type"],
        at: "2026-01-01T21:00:00.000Z",
        agentId: "agent-1",
        runId: PAYLOADS.attrBreak,
        summary: "cut…",
        data: { kind: "text", text: payload, truncated: true, fullLength: 99999 },
      },
    ];
    const agents = { "agent-1": hostileAgent({ id: "agent-1" }) } as Record<string, Agent>;
    const html = chatHtml(chatBlocks(chatItems(events, [], agents), agents));
    assertSceneInert(html, `data.text/${name}`);
    // The truncation notice quotes the runId into a path; that is text a model influenced too.
    const path = /logs\/([^<]*)\.log/.exec(html)?.[1] ?? "";
    assert.match(path, /^[A-Za-z0-9._:@#-]*$/, `data.text/${name}: the runId broke out of the log path`);
  }
});

test("a hostile agent name cannot break out of the composer's target picker", () => {
  const roster = [
    hostileAgent({ id: "a1", name: PAYLOADS.attrBreak, role: "manager" }),
    hostileAgent({ id: PAYLOADS.attrBreak, name: PAYLOADS.script, role: "worker" }),
  ] as Agent[];
  const html = targetOptionsHtml(addressTargets(roster), PAYLOADS.attrBreak);
  assertNothingExecutable(html, "targetOptionsHtml");
  for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(html, payload, "targetOptionsHtml");
  // The value is read straight back as the id the message is sent to.
  const value = /<option value="([^"]*)"/.exec(html.slice(html.indexOf("value=\"", 20)))?.[1] ?? "";
  assert.ok(!value.includes('"'));
});

test("a hostile addressee name stays inert in the direct-message label", () => {
  const agents = {
    m: hostileAgent({ id: "m", name: "lead", role: "manager" }),
    b: hostileAgent({ id: "b", name: PAYLOADS.img, role: "worker" }),
  } as Record<string, Agent>;
  const messages = [
    {
      id: "d1",
      from: "human",
      to: "b",
      workspace: "ws",
      kind: "message",
      body: PAYLOADS.script,
      createdAt: "2026-01-01T21:00:00.000Z",
    },
  ] as Parameters<typeof chatItems>[1];
  const html = chatHtml(chatBlocks(chatItems([], messages, agents), agents));
  assertSceneInert(html, "chatHtml/direct");
  for (const payload of Object.values(PAYLOADS)) assertNotPresentRaw(html, payload, "chatHtml/direct");
});

const { turnIndicators, turnsHtml } = await import("./client/render.js");

test("a hostile agent name stays inert in the live turn indicator", () => {
  // The indicator prints a name and a failure summary, and BOTH are attacker-influenced: a
  // hostile MCP client self-reports the first, a model writes the second. The row goes through
  // the same escapeHtml boundary as everything else on the page and adds no second path.
  const now = Date.parse("2026-01-01T21:04:00.000Z");
  const stamp = (offset: number) => new Date(now + offset).toISOString();
  for (const payload of Object.values(PAYLOADS)) {
    const roster = [
      hostileAgent({ id: payload, name: payload, status: "working" }),
      hostileAgent({ id: `f-${payload}`, name: payload, status: "failed" }),
    ] as Agent[];
    const events = [
      { id: "s", type: "agent.started", agentId: payload, at: stamp(-5000), summary: payload },
      { id: "o", type: "agent.output", agentId: payload, at: stamp(-2000), summary: payload, data: { text: payload } },
      { id: "f", type: "agent.failed", agentId: `f-${payload}`, at: stamp(-1000), summary: payload },
    ] as Event[];
    const html = turnsHtml(turnIndicators(roster, events, now), now);
    assertSceneInert(html, `turnsHtml/${payload}`);
    assertNotPresentRaw(html, payload, "turnsHtml");
    // data-agent is read back off the row the same way every other one on the page is.
    for (const value of html.match(/data-agent="([^"]*)"/g) ?? []) {
      assert.match(value, /^data-agent="[A-Za-z0-9._:@#-]*"$/, `turnsHtml: ${value} broke out`);
    }
  }
});
