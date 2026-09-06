import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The Office's two load-bearing rendering decisions, tested as pure functions:
 *
 *  1. event → feed line. The Team Feed is the whole orchestration view, and it is the one
 *     place where a wrong string is invisible rather than crashing.
 *  2. managed vs observed. Spec §17: Crew may prompt, cancel and stop what it launched, and
 *     must never draw a control implying it can do any of that to a Docket session it merely
 *     observed. That is a safety property, not a styling preference, so it gets assertions.
 */

const {
  agentCardHtml,
  boardHtml,
  coldStartHtml,
  columnOf,
  elapsedLabel,
  feedKind,
  feedLine,
  feedLineHtml,
  formatTime,
  groupAgents,
  outputEntries,
  outputHtml,
  parseOutputLine,
  profileRowHtml,
  runtimeLabel,
  statusLabel,
} = await import("./client/render.js");

type Agent = Parameters<typeof agentCardHtml>[0];
type Assignment = Parameters<typeof agentCardHtml>[1];
type Event = Parameters<typeof feedLineHtml>[0];
type Profile = Parameters<typeof profileRowHtml>[0];

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "codex-1",
    name: "Codex #1",
    origin: "managed",
    runtime: "codex",
    role: "worker",
    status: "working",
    startedAt: "2026-01-01T21:00:00.000Z",
    ...overrides,
  } as Agent;
}

function assignment(overrides: Record<string, unknown> = {}): NonNullable<Assignment> {
  return {
    id: "asg-1",
    title: "Review sync and persistence",
    instructions: "…",
    workspace: "todo-mcp",
    assignedBy: "manager-1",
    assignedTo: "codex-1",
    status: "running",
    createdAt: "2026-01-01T21:00:00.000Z",
    attempts: 1,
    ...overrides,
  } as NonNullable<Assignment>;
}

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: "e1",
    type: "assignment.created",
    at: "2026-01-01T21:04:00.000Z",
    ...overrides,
  } as Event;
}

const AGENTS: Record<string, Agent> = {
  "manager-1": agent({ id: "manager-1", name: "Manager", role: "manager", runtime: "claude" }),
  "codex-1": agent(),
};

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

test("formatTime renders HH:MM and never throws on junk", () => {
  const at = "2026-01-01T21:04:00.000Z";
  const expected = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  assert.equal(formatTime(at), `${pad(expected.getHours())}:${pad(expected.getMinutes())}`);
  assert.match(formatTime(at), /^\d{2}:\d{2}$/);
  assert.equal(formatTime("not a date"), "--:--");
  assert.equal(formatTime(undefined), "--:--");
  assert.equal(formatTime(null), "--:--");
});

test("elapsedLabel scales from seconds to days and is blank without a start", () => {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  assert.equal(elapsedLabel("2026-01-01T00:00:00.000Z", start + 41_000), "41s");
  assert.equal(elapsedLabel("2026-01-01T00:00:00.000Z", start + 125_000), "2m 05s");
  assert.equal(elapsedLabel("2026-01-01T00:00:00.000Z", start + 3_900_000), "1h 05m");
  assert.equal(elapsedLabel("2026-01-01T00:00:00.000Z", start + 200_000_000), "2d 7h");
  assert.equal(elapsedLabel(undefined, Date.now()), "");
  assert.equal(elapsedLabel("nonsense", Date.now()), "");
  // A clock that went backwards must not print a negative age.
  assert.equal(elapsedLabel("2026-01-01T00:00:00.000Z", start - 5000), "0s");
});

test("runtimeLabel shows the provider only when the model does not already carry it", () => {
  assert.equal(runtimeLabel({ runtime: "codex", model: "gpt-5" }), "codex · gpt-5");
  assert.equal(
    runtimeLabel({ runtime: "opencode", provider: "openrouter", model: "openrouter/anthropic/claude-sonnet-4" }),
    "opencode · openrouter/anthropic/claude-sonnet-4",
  );
  assert.equal(
    runtimeLabel({ runtime: "opencode", provider: "openrouter", model: "anthropic/claude-sonnet-4" }),
    "opencode · openrouter · anthropic/claude-sonnet-4",
  );
  assert.equal(runtimeLabel({ runtime: "claude" }), "claude");
  assert.equal(runtimeLabel({}), "");
});

test("statusLabel falls back rather than printing a raw unknown value", () => {
  assert.equal(statusLabel("working"), "working");
  assert.equal(statusLabel("teleporting"), "unknown");
  assert.equal(statusLabel(undefined), "unknown");
});

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

test("role decides the desk, and a role-less agent still gets one", () => {
  assert.equal(columnOf({ role: "manager" }), "lead");
  assert.equal(columnOf({ role: "reviewer" }), "review");
  assert.equal(columnOf({ role: "worker" }), "workers");
  assert.equal(columnOf({}), "workers", "an observed session with no role must not vanish off the board");
});

test("groupAgents sorts working agents to the top of their column", () => {
  const columns = groupAgents([
    agent({ id: "a", name: "Zed", status: "idle" }),
    agent({ id: "b", name: "Ann", status: "working" }),
    agent({ id: "c", name: "Bob", status: "stopped" }),
    agent({ id: "d", name: "Manager", role: "manager", status: "idle" }),
  ]);
  assert.deepEqual(
    columns.workers.map((a) => a.name),
    ["Ann", "Zed", "Bob"],
  );
  assert.deepEqual(columns.lead.map((a) => a.name), ["Manager"]);
  assert.deepEqual(columns.review, []);
});

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

test("feedKind routes each event type to the right dot", () => {
  assert.equal(feedKind("manager.woken"), "manager");
  assert.equal(feedKind("goal.created"), "manager");
  assert.equal(feedKind("agent.output"), "worker");
  assert.equal(feedKind("assignment.created"), "worker");
  assert.equal(feedKind("review.requested"), "review");
  assert.equal(feedKind("agent.failed"), "error");
  assert.equal(feedKind("assignment.failed"), "error");
  assert.equal(feedKind("crew.started"), "system");
  assert.equal(feedKind("something.new"), "system");
});

test("an assignment reads as `Manager → Codex #1  <task>`", () => {
  const line = feedLine(
    event({
      type: "assignment.created",
      summary: "Review sync and persistence.",
      data: { from: "manager-1", to: "codex-1" },
    }),
    AGENTS,
  );
  assert.equal(line.actor, "Manager → Codex #1");
  assert.equal(line.text, "Review sync and persistence.");
  assert.match(line.time, /^\d{2}:\d{2}$/);
  assert.equal(line.kind, "worker");
});

test("a `to` with no `from` is attributed to the manager, because that is who hands work out", () => {
  const line = feedLine(event({ data: { to: "codex-1", title: "Fix the race" } }), AGENTS);
  assert.equal(line.actor, "Manager → Codex #1");
  assert.equal(line.text, "Fix the race");
});

test("an agent's own event is attributed to that agent by display name, not id", () => {
  const line = feedLine(event({ type: "agent.output", agentId: "codex-1", summary: "ran the tests" }), AGENTS);
  assert.equal(line.actor, "Codex #1");
  assert.equal(line.text, "ran the tests");
});

test("an unknown agent id degrades to the id rather than an empty line", () => {
  const line = feedLine(event({ type: "agent.idle", agentId: "ghost-9", summary: "finished" }), AGENTS);
  assert.equal(line.actor, "ghost-9");
});

test("the event's own summary always wins over a derived sentence", () => {
  const line = feedLine(event({ type: "manager.woken", summary: "manager woken: human goal" }), AGENTS);
  assert.equal(line.text, "manager woken: human goal");
});

test("an event with no summary still produces a readable sentence for every type", () => {
  const cases: [string, Record<string, unknown> | undefined, string][] = [
    ["goal.created", { goal: "ship the thing" }, "new goal: ship the thing"],
    ["goal.created", undefined, "a new goal was created"],
    ["assignment.created", { title: "Fix the race" }, "Fix the race"],
    ["assignment.completed", { title: "Fix the race" }, "finished Fix the race"],
    ["assignment.failed", undefined, "assignment failed"],
    ["manager.paused", undefined, "manager paused — waiting for a human"],
    ["review.requested", { title: "branch/x" }, "review requested: branch/x"],
    ["review.completed", undefined, "review completed"],
  ];
  for (const [type, data, expected] of cases) {
    const line = feedLine(event({ type: type as Event["type"], summary: undefined, data }), AGENTS);
    assert.equal(line.text, expected, `${type} without a summary`);
  }
});

test("a completely unknown event type prints its type rather than nothing", () => {
  const line = feedLine(event({ type: "future.thing" as Event["type"], summary: undefined }), AGENTS);
  assert.equal(line.text, "future.thing");
  assert.equal(line.kind, "system");
});

test("a feed row carries its kind and type for styling and filtering", () => {
  const html = feedLineHtml(event({ type: "agent.failed", agentId: "codex-1", summary: "boom" }), AGENTS);
  assert.match(html, /data-kind="error"/);
  assert.match(html, /data-type="agent\.failed"/);
  assert.match(html, /<time class="fd-time">/);
  assert.match(html, /Codex #1/);
});

// ---------------------------------------------------------------------------
// Managed vs observed — spec §17
// ---------------------------------------------------------------------------

test("a managed agent card is solid and carries the full control strip", () => {
  const html = agentCardHtml(agent(), assignment(), Date.parse("2026-01-01T21:02:05.000Z"));
  assert.match(html, /class="ag managed"/);
  assert.match(html, /data-origin="managed"/);
  assert.match(html, /data-act="open"/);
  assert.match(html, /data-act="message"/);
  assert.match(html, /data-act="cancel"/);
  assert.match(html, /Review sync and persistence/, "the current task must be on the card");
  assert.match(html, /codex/, "the runtime must be on the card");
  assert.match(html, />2m 05s</, "elapsed time must be on the card");
  assert.match(html, /tag-managed/);
});

test("an observed agent card is dashed and has NO control that implies Crew can drive it", () => {
  const html = agentCardHtml(agent({ origin: "observed", role: undefined }), null, Date.now());
  assert.match(html, /class="ag observed"/);
  assert.match(html, /data-origin="observed"/);
  assert.match(html, /tag-observed/);
  // The safety assertion. Not "there are fewer buttons" — there are none at all.
  assert.doesNotMatch(html, /<button/i, "an observed session must render no buttons");
  assert.doesNotMatch(html, /data-act=/, "an observed session must expose no action hooks");
  for (const act of ["open", "message", "cancel", "stop", "spawn"]) {
    assert.ok(!html.includes(`data-act="${act}"`), `observed card offered a "${act}" control`);
  }
  assert.match(html, /Crew didn't launch/, "the card must say why it has no controls");
});

test("the two origins are distinguishable by more than a border colour", () => {
  const managed = agentCardHtml(agent(), null, Date.now());
  const observed = agentCardHtml(agent({ origin: "observed" }), null, Date.now());
  assert.notEqual(managed, observed);
  assert.match(managed, /class="tag tag-managed">managed</);
  assert.match(observed, /class="tag tag-observed">observed</);
});

test("a mixed board keeps observed sessions control-free while managed ones keep controls", () => {
  const asg = assignment();
  const html = boardHtml(
    [agent({ id: "m", role: "manager" }), agent(), agent({ id: "o", origin: "observed", name: "claude (docket)" })],
    { [asg.id]: asg },
    Date.now(),
  );
  const cards = html.split("<article").slice(1);
  assert.equal(cards.length, 3);
  for (const card of cards) {
    const isObserved = card.includes('data-origin="observed"');
    assert.equal(card.includes("data-act="), !isObserved, "controls appeared on exactly the wrong kind of card");
  }
});

test("a card with no assignment says so instead of rendering an empty line", () => {
  const html = agentCardHtml(agent({ currentAssignmentId: undefined }), null, Date.now());
  assert.match(html, /no current task/);
});

// ---------------------------------------------------------------------------
// Output, cold start
// ---------------------------------------------------------------------------

test("only agent.output events reach the transcript — nothing else in the log does", () => {
  const events = [
    event({ id: "a", type: "agent.output", agentId: "codex-1", summary: "reading src/state.ts" }),
    event({ id: "b", type: "agent.idle", agentId: "codex-1", summary: "PRIVATE-NOT-OUTPUT" }),
    event({ id: "c", type: "assignment.created", agentId: "codex-1", summary: "ALSO-NOT-OUTPUT" }),
    event({ id: "d", type: "agent.output", agentId: "someone-else", summary: "OTHER-AGENT-OUTPUT" }),
  ];
  const html = outputHtml(outputEntries([], events, "codex-1"));
  assert.match(html, /reading src\/state\.ts/);
  assert.ok(!html.includes("PRIVATE-NOT-OUTPUT"));
  assert.ok(!html.includes("ALSO-NOT-OUTPUT"));
  assert.ok(!html.includes("OTHER-AGENT-OUTPUT"), "another agent's output leaked into this panel");
  assert.equal(outputHtml([]).includes("No visible output"), true);
});

test("the replayed buffer and the live stream merge without a duplicate or a gap", () => {
  // The daemon replays "<iso> <summary>" lines; the SSE stream then carries the same shape.
  // The overlap is exact for the one line both sources hold, and must appear once.
  const seed = [
    "2026-01-01T21:00:00.000Z opened src/state.ts",
    "2026-01-01T21:00:05.000Z ran the tests",
  ];
  const live = [
    event({ id: "x", type: "agent.output", agentId: "codex-1", at: "2026-01-01T21:00:05.000Z", summary: "ran the tests" }),
    event({ id: "y", type: "agent.output", agentId: "codex-1", at: "2026-01-01T21:00:09.000Z", summary: "all green" }),
  ];
  const entries = outputEntries(seed, live, "codex-1");
  assert.deepEqual(
    entries.map((e) => e.text),
    ["opened src/state.ts", "ran the tests", "all green"],
  );
});

test("a buffer line with no parseable timestamp is kept whole rather than truncated", () => {
  assert.deepEqual(parseOutputLine("2026-01-01T21:00:00.000Z hello there"), {
    at: "2026-01-01T21:00:00.000Z",
    text: "hello there",
  });
  assert.deepEqual(parseOutputLine("no timestamp here"), { at: "", text: "no timestamp here" });
  assert.deepEqual(parseOutputLine("solid"), { at: "", text: "solid" });
});

test("cold start offers a launch button per profile, manager first", () => {
  const profiles = [
    { name: "reviewer", runtime: "claude", role: "reviewer" },
    { name: "lead", runtime: "claude", role: "manager" },
  ] as Profile[];
  const html = coldStartHtml(profiles, "lead", true, "");
  assert.ok(html.indexOf('data-profile="lead"') < html.indexOf('data-profile="reviewer"'), "the manager must come first");
  assert.match(html, /data-act="spawn"/);
  assert.match(html, /tag-manager/);
});

test("cold start with no profiles and with an error both say something useful", () => {
  assert.match(coldStartHtml([], "", true, ""), /No profiles are configured/);
  const errored = coldStartHtml([], "", false, "no /api/profiles here");
  assert.match(errored, /no \/api\/profiles here/);
  assert.doesNotMatch(errored, /data-act="spawn"/, "no spawn button when the daemon can't spawn");
});

// ---------------------------------------------------------------------------
// The pixel office: state → sprite
//
// The whole premise of the scene is that what you see is what the daemon reported. A pose or
// a screen that drifted from the status would be a lie told in a medium that looks playful,
// which is worse than a wrong label. So the mapping is a pure function and it is pinned here.
// ---------------------------------------------------------------------------

const {
  bubbleHtml,
  cabinetHtml,
  cabinetLabel,
  ghostHtml,
  ghostsHtml,
  hairFor,
  hireSeatHtml,
  latestOutput,
  openAssignments,
  pixelRects,
  poseFor,
  screenFor,
  seatAriaLabel,
  seatHtml,
  thoughtFor,
  truncateText,
  zoneAgents,
  zoneHtml,
  zoneSeats,
} = await import("./client/render.js");

test("every AgentStatus maps to exactly one pose and one screen, and nothing else does", () => {
  const expected: [string, string, string][] = [
    ["starting", "arriving", "boot"],
    ["working", "typing", "flicker"],
    ["idle", "breathing", "dim"],
    ["failed", "slumped", "alert"],
    ["stopped", "empty", "off"],
  ];
  for (const [status, pose, screen] of expected) {
    assert.equal(poseFor(status), pose, `pose for ${status}`);
    assert.equal(screenFor(status), screen, `screen for ${status}`);
  }
  // A status this build has never heard of must still draw a person at a desk.
  assert.equal(poseFor("teleporting"), "breathing");
  assert.equal(screenFor(undefined), "dim");
  // The five poses are distinct — a mapping that collapsed two states would be invisible.
  assert.equal(new Set(expected.map((row) => row[1])).size, 5);
  assert.equal(new Set(expected.map((row) => row[2])).size, 5);
});

test("a seat carries its status, pose, screen, role and runtime for CSS to read", () => {
  const html = seatHtml(agent({ status: "working" }), assignment(), "", Date.now());
  assert.match(html, /data-status="working"/);
  assert.match(html, /data-pose="typing"/);
  assert.match(html, /data-screen="flicker"/);
  assert.match(html, /data-role="worker"/);
  assert.match(html, /data-runtime="codex"/);
  assert.match(html, /data-act="open"/);
  assert.match(html, /data-agent="codex-1"/);
});

test("a stopped agent keeps its desk but nobody is in the chair", () => {
  const running = seatHtml(agent({ status: "working" }), null, "", Date.now());
  const stopped = seatHtml(agent({ status: "stopped" }), null, "", Date.now());
  assert.match(running, /class="px-person"/);
  assert.doesNotMatch(stopped, /class="px-person"/, "a stopped agent must not still be drawn sitting there");
  assert.match(stopped, /class="px-chair"/, "the chair and the desk stay — it is still their desk");
  assert.match(stopped, /class="px-desk"/);
  assert.match(stopped, /data-pose="empty"/);
});

test("an unknown runtime draws no badge rather than an invented one", () => {
  assert.match(seatHtml(agent({ runtime: "claude" }), null, "", Date.now()), /class="px-badge"/);
  assert.doesNotMatch(
    seatHtml(agent({ runtime: undefined }), null, "", Date.now()),
    /class="px-badge"/,
    "a badge with no runtime behind it would be decoration pretending to be information",
  );
});

test("the three runtime badges are different shapes, not three colours of one shape", () => {
  const shapes = ["claude", "codex", "opencode"].map((runtime) => {
    const html = seatHtml(agent({ runtime: runtime as never }), null, "", Date.now());
    return /class="px-badge">(.*?)<\/g>/.exec(html)?.[1] ?? "";
  });
  assert.ok(shapes.every((s) => s.length > 0), "every known runtime must get a badge");
  assert.equal(new Set(shapes).size, 3, "two runtimes drew the same glyph — colour-blind users see one badge");
});

test("hair colour is a stable function of identity, never a random draw", () => {
  assert.equal(hairFor("codex-1"), hairFor("codex-1"));
  assert.ok(hairFor("codex-1") >= 0 && hairFor("codex-1") < 5);
  assert.equal(hairFor(undefined), hairFor(""));
  const spread = new Set(["a", "b", "c", "codex-1", "manager-1", "reviewer-2"].map(hairFor));
  assert.ok(spread.size > 1, "every agent got the same hair — neighbours are indistinguishable");
});

test("role decides the desk zone, and only managed agents are on the floor", () => {
  const agents = [
    agent({ id: "m", name: "Lead", role: "manager" }),
    agent({ id: "w", name: "Worker" }),
    agent({ id: "r", name: "Rev", role: "reviewer" }),
    agent({ id: "o", name: "Ghost", origin: "observed", role: "worker" }),
  ];
  assert.deepEqual(zoneAgents(agents, "lead").map((a) => a.id), ["m"]);
  assert.deepEqual(zoneAgents(agents, "workers").map((a) => a.id), ["w"]);
  assert.deepEqual(zoneAgents(agents, "review").map((a) => a.id), ["r"]);
  for (const zone of ["lead", "workers", "review"] as const) {
    assert.ok(!zoneAgents(agents, zone).some((a) => a.origin === "observed"), "an observed session got a desk");
  }
});

test("seats are ordered by name and do not jump around when a status changes", () => {
  const before = zoneSeats("workers", [agent({ id: "z", name: "Zed" }), agent({ id: "a", name: "Ann" })], {}, {}, 0, {
    controls: false,
  });
  const after = zoneSeats(
    "workers",
    [agent({ id: "z", name: "Zed", status: "idle" }), agent({ id: "a", name: "Ann", status: "failed" })],
    {},
    {},
    0,
    { controls: false },
  );
  assert.deepEqual(before.map((s) => s.key), ["agent:a", "agent:z"]);
  assert.deepEqual(after.map((s) => s.key), before.map((s) => s.key));
  // The signature is what decides whether app.ts rebuilds the DOM. A status change must not
  // move it, or every animation in the room restarts on every reconciliation.
  assert.deepEqual(after.map((s) => s.sig), before.map((s) => s.sig));
});

test("an empty office offers a free desk in every zone, and the lead desk starts the manager", () => {
  const lead = zoneHtml("lead", [], {}, {}, 0, { controls: true });
  assert.match(lead, /data-act="start-manager"/);
  assert.match(lead, /Start the manager/);
  for (const zone of ["workers", "review"] as const) {
    const html = zoneHtml(zone, [], {}, {}, 0, { controls: true });
    assert.match(html, /data-act="hire"/, `${zone} offered no way to put somebody in it`);
  }
});

test("the lead desk stops offering to start a manager once one is sitting at it", () => {
  const running = zoneHtml("lead", [agent({ id: "m", role: "manager", status: "idle" })], {}, {}, 0, { controls: true });
  assert.doesNotMatch(running, /data-act="start-manager"/, "a second manager would be woken by every result");
  const gone = zoneHtml("lead", [agent({ id: "m", role: "manager", status: "stopped" })], {}, {}, 0, { controls: true });
  assert.match(gone, /data-act="start-manager"/, "a stopped manager must leave the desk offerable again");
});

test("a daemon with no control endpoints draws the room but offers no free desk", () => {
  const html = zoneHtml("workers", [agent()], {}, {}, 0, { controls: false });
  assert.match(html, /class="seat"/, "the room must still be drawn");
  assert.doesNotMatch(html, /data-act="hire"/, "a hire button that cannot hire is a dead end");
});

// ---------------------------------------------------------------------------
// Thought bubbles
// ---------------------------------------------------------------------------

test("a bubble appears only over somebody who is actually doing something", () => {
  const asg = assignment();
  for (const status of ["working", "starting"] as const) {
    assert.equal(thoughtFor(agent({ status }), asg, ""), "Review sync and persistence", status);
  }
  for (const status of ["idle", "failed", "stopped"] as const) {
    assert.equal(thoughtFor(agent({ status }), asg, "still running"), "", `${status} must be a quiet desk`);
  }
});

test("an observed session never gets a bubble — Crew is not narrating a process it does not own", () => {
  assert.equal(thoughtFor(agent({ origin: "observed", status: "working" }), assignment(), "doing things"), "");
});

test("the bubble prefers the live output line, and falls back to the assignment title", () => {
  assert.equal(thoughtFor(agent(), assignment(), "running the test suite"), "running the test suite");
  assert.equal(thoughtFor(agent(), assignment(), ""), "Review sync and persistence");
  assert.equal(thoughtFor(agent(), null, ""), "", "nothing to say means no bubble, not an empty one");
});

test("a bubble truncates rather than swallowing the office", () => {
  const long = "x".repeat(400);
  const text = thoughtFor(agent(), null, long);
  assert.ok(text.length <= 52, `bubble text was ${text.length} characters`);
  assert.ok(text.endsWith("…"));
  assert.equal(truncateText("  spaced   out  ", 80), "spaced out");
  assert.equal(truncateText(undefined, 10), "");
});

test("bubble text comes from agent.output and from nothing else in the event log", () => {
  const events = [
    event({ id: "a", type: "agent.output", agentId: "codex-1", at: "2026-01-01T21:00:00.000Z", summary: "reading state.ts" }),
    event({ id: "b", type: "agent.idle", agentId: "codex-1", at: "2026-01-01T21:00:30.000Z", summary: "NEVER-IN-A-BUBBLE" }),
    event({ id: "c", type: "agent.output", agentId: "other", at: "2026-01-01T21:00:40.000Z", summary: "OTHER-AGENTS-LINE" }),
    event({ id: "d", type: "agent.output", agentId: "codex-1", at: "2026-01-01T21:00:50.000Z", summary: "ran the tests" }),
  ];
  assert.equal(latestOutput(events, "codex-1"), "ran the tests");
  assert.equal(latestOutput(events, "nobody"), "");
  const html = seatHtml(agent(), null, thoughtFor(agent(), null, latestOutput(events, "codex-1")), Date.now());
  assert.match(html, /ran the tests/);
  assert.ok(!html.includes("NEVER-IN-A-BUBBLE"));
  assert.ok(!html.includes("OTHER-AGENTS-LINE"), "another agent's output floated over the wrong desk");
});

test("an empty thought renders a hidden bubble rather than an empty white box", () => {
  assert.match(bubbleHtml(""), /<div class="bubble" hidden>/);
  assert.match(bubbleHtml("   "), /hidden/);
  assert.doesNotMatch(bubbleHtml("busy"), /hidden/);
});

// ---------------------------------------------------------------------------
// Observed sessions at the window — spec §17, drawn
// ---------------------------------------------------------------------------

test("a ghost at the window has NO control of any kind", () => {
  const html = ghostHtml(agent({ origin: "observed", name: "claude (docket)", role: undefined }));
  assert.doesNotMatch(html, /<button/i, "an observed session must render no button, in any view");
  assert.doesNotMatch(html, /data-act=/, "an observed session must expose no action hook");
  assert.doesNotMatch(html, /tabindex/i, "an observed session must not even be a focus stop that implies action");
  assert.match(html, /Crew did not launch it/, "the label must say why it is outside");
  assert.match(html, /claude \(docket\)/);
});

test("only observed sessions reach the window, and managed agents never do", () => {
  const html = ghostsHtml([
    agent({ id: "a", name: "Codex #1" }),
    agent({ id: "b", name: "Zed session", origin: "observed" }),
    agent({ id: "c", name: "Ann session", origin: "observed" }),
  ]);
  assert.ok(!html.includes("Codex #1"), "a managed agent was drawn outside the window");
  assert.ok(html.indexOf("Ann session") < html.indexOf("Zed session"), "ghosts should be in a stable order");
  assert.doesNotMatch(html, /data-act=/);
  assert.equal(ghostsHtml([agent()]), "", "no observed sessions means an empty window, not an empty box");
});

// ---------------------------------------------------------------------------
// Docket, as furniture
// ---------------------------------------------------------------------------

test("the cabinet counts open work and not finished work", () => {
  const list = [
    assignment({ id: "1", status: "queued" }),
    assignment({ id: "2", status: "running" }),
    assignment({ id: "3", status: "waiting" }),
    assignment({ id: "4", status: "review" }),
    assignment({ id: "5", status: "done" }),
    assignment({ id: "6", status: "failed" }),
    assignment({ id: "7", status: "cancelled" }),
  ];
  assert.equal(openAssignments(list), 4);
  assert.equal(openAssignments([]), 0);
});

test("the cabinet says what it holds, in words, and opens the task list", () => {
  const busy = cabinetHtml(3, 9);
  assert.match(busy, /data-act="docket"/);
  assert.match(busy, /3 open/);
  assert.match(busy, /aria-label="Docket — 3 open tasks\. Opens the task list\."/);
  assert.match(cabinetLabel(1, 1), /1 open task\./, "one task must not read as 1 tasks");
  assert.match(cabinetLabel(0, 4), /no open tasks, 4 filed/);
  assert.match(cabinetHtml(0, 0), /data-empty="true"/);
  // Three drawers, so the three moments a task can move each get their own motion.
  for (const i of [0, 1, 2]) assert.match(busy, new RegExp(`px-drawer-${i}`));
});

// ---------------------------------------------------------------------------
// The sprite compiler
// ---------------------------------------------------------------------------

test("pixelRects merges horizontal runs and skips transparent cells", () => {
  const html = pixelRects(["..aa.", "aaaaa"], { a: "--px-skin" });
  assert.equal(html.match(/<rect/g)?.length, 2, "each row should collapse to one rect");
  assert.match(html, /<rect x="2" y="0" width="2" height="1" fill="var\(--px-skin\)"\/>/);
  assert.match(html, /<rect x="0" y="1" width="5" height="1"/);
  assert.equal(pixelRects(["...."], { a: "--px-skin" }), "", "an empty row draws nothing");
});

test("pixelRects offsets a sprite and refuses a palette entry that is not a --px- token", () => {
  assert.match(pixelRects(["a"], { a: "--px-skin" }, 4, 7), /x="4" y="7"/);
  // The fill lands inside an attribute, so a palette is the one place a future edit could put
  // arbitrary text there. Anything that is not a --px-* custom property is dropped, not escaped.
  for (const bad of ['--px-skin) fill="url(#x', "red", "--other-token", "--PX-SKIN", ""]) {
    assert.equal(pixelRects(["a"], { a: bad }), "", `palette token ${bad} was not rejected`);
  }
});

test("a seat's aria-label carries everything the picture carries", () => {
  const label = seatAriaLabel(agent({ status: "working" }), "Review sync and persistence");
  assert.match(label, /Codex #1/);
  assert.match(label, /working/);
  assert.match(label, /codex/);
  assert.match(label, /worker/);
  assert.match(label, /Review sync and persistence/);
  assert.match(label, /Opens this agent/);
});

test("a free desk announces what clicking it does", () => {
  const html = hireSeatHtml("reviewer", "hire", "Hire", "Hire a reviewer for the review corner — opens the profile roster");
  assert.match(html, /data-act="hire"/);
  assert.match(html, /data-role="reviewer"/);
  assert.match(html, /aria-label="Hire a reviewer for the review corner/);
});

// ---------------------------------------------------------------------------
// The conversation
//
// The old Team Feed printed the event log and called it a chat: `init`, `started a turn`,
// `used ToolSearch` and the manager's actual answer all got one row and the same weight, and
// the answer — the only line anybody came to read — was the one that got cut. These tests pin
// the sorting that fixes it, because "is this row worth a human's attention" is a product
// decision, and product decisions deserve assertions.
// ---------------------------------------------------------------------------

const {
  activitySummary,
  chatBlocks,
  chatBlockHtml,
  chatHtml,
  chatItems,
  eventBody,
  eventChannel,
  isLongBody,
  outputKind,
  toolLabel,
} = await import("./client/render.js");

type Message = Parameters<typeof chatItems>[1][number];

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    from: "human",
    to: "manager-1",
    workspace: "ws",
    kind: "message",
    body: "що ти вмієш?",
    createdAt: "2026-01-01T21:00:00.000Z",
    ...overrides,
  } as Message;
}

function output(overrides: Record<string, unknown> = {}): Event {
  return event({ type: "agent.output", agentId: "codex-1", ...overrides }) as Event;
}

// ---------------------------------------------------------------------------
// Full text
// ---------------------------------------------------------------------------

test("the body comes from the event data, and falls back to the summary for older events", () => {
  const full = "Відкрито **15** пунктів —\n8 у Todo, 7 у Backlog.";
  assert.equal(eventBody(output({ summary: "Відкрито **15** пунктів — 8 у То…", data: { text: full } })), full);
  // Every key the daemon might use for the same thing resolves to the same place, so pointing
  // the conversation at a different field stays a one-line change.
  for (const key of ["text", "body", "full", "output", "result", "message"]) {
    assert.equal(eventBody(output({ summary: "cut…", data: { [key]: full } })), full, key);
  }
  // events.jsonl is full of rows written before any of that existed.
  assert.equal(eventBody(output({ summary: "a plain summary", data: undefined })), "a plain summary");
  assert.equal(eventBody(output({ summary: "a plain summary", data: { text: "   " } })), "a plain summary");
});

test("a long reply is clamped for display but never cut in the markup", () => {
  const long = `${"словосполучення ".repeat(80)}кінець`;
  assert.ok(isLongBody(long));
  assert.ok(!isLongBody("short"));
  assert.ok(isLongBody(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")), "many short lines are long too");

  const blocks = chatBlocks(
    chatItems([output({ id: "e1", summary: "cut…", data: { text: long, kind: "text" } })], [], AGENTS),
    AGENTS,
  );
  const html = chatBlockHtml(blocks[0]);
  assert.match(html, /data-long="true"/);
  assert.match(html, /data-act="more"/, "a long reply must be expandable");
  assert.ok(html.includes("кінець"), "the end of a long reply must still be in the markup, not thrown away");
  assert.doesNotMatch(html, /…<\/p>/, "the renderer must never add an ellipsis of its own");
});

// ---------------------------------------------------------------------------
// Mechanics vs speech
// ---------------------------------------------------------------------------

test("the runtime's own kind decides what an output row is, when it is there", () => {
  assert.equal(outputKind(output({ data: { kind: "tool", tool: "mcp__crew__crew_wait" } })), "tool");
  assert.equal(outputKind(output({ data: { kind: "status" }, summary: "Some prose here" })), "status");
  assert.equal(outputKind(output({ data: { kind: "text" }, summary: "init" })), "reply");
  assert.equal(outputKind(output({ data: { tool: "ToolSearch" } })), "tool");
});

test("without a declared kind, a bare status token is mechanics and prose is speech", () => {
  for (const token of ["init", "turn.started", "turn.completed", "compacting"]) {
    assert.equal(outputKind(output({ summary: token })), "status", token);
  }
  for (const prose of ["Чекаю на задачу.", "Я — менеджер краю", "Reading src/state.ts now"]) {
    assert.equal(outputKind(output({ summary: prose })), "reply", prose);
  }
});

test("every event type lands in exactly one channel, and the answer is the only one that is speech", () => {
  const cases: [string, Record<string, unknown> | undefined, string, string][] = [
    ["agent.output", { text: "Я — менеджер краю" }, "Я — менеджер краю", "say"],
    ["agent.output", { tool: "mcp__crew__crew_profiles" }, "3fedc3ce used mcp__crew__crew_profiles", "activity"],
    ["agent.output", undefined, "init", "activity"],
    ["agent.started", undefined, "claude manager #1 started a turn", "activity"],
    ["agent.idle", undefined, "claude manager #1 finished its turn", "activity"],
    ["agent.idle", { text: "Готово, 3 файли змінено." }, "Готово, 3 файли…", "say"],
    ["message.delivered", undefined, "1 message(s) delivered to 3fedc3ce", "activity"],
    ["message.sent", undefined, "human → 3fedc3ce (message)", "activity"],
    ["manager.woken", undefined, "manager woken: message from human", "activity"],
    ["goal.created", undefined, "human: що ти вмієш?", "activity"],
    ["assignment.created", undefined, "Fix the race", "note"],
    ["review.requested", undefined, "review requested", "note"],
    ["agent.failed", undefined, "boom", "note"],
    ["agent.spawned", undefined, "spawned claude manager #1", "note"],
    ["crew.started", undefined, "crew daemon up", "system"],
  ];
  for (const [type, data, summary, channel] of cases) {
    const got = eventChannel(event({ type: type as Event["type"], summary, data }));
    assert.equal(got, channel, `${type} (${summary})`);
  }
});

test("the mechanical rows from the user's actual transcript all get demoted", () => {
  // Verbatim from the feed that was rejected. Not one of these is something anybody said.
  const mechanical = [
    output({ summary: "init" }),
    output({ summary: "3fedc3ce used ToolSearch", data: { tool: "ToolSearch" } }),
    output({ summary: "3fedc3ce used mcp__crew__crew_profiles", data: { tool: "mcp__crew__crew_profiles" } }),
    output({ summary: "3fedc3ce used mcp__crew__crew_agents", data: { tool: "mcp__crew__crew_agents" } }),
    output({ summary: "3fedc3ce used mcp__crew__crew_wait", data: { tool: "mcp__crew__crew_wait" } }),
    event({ type: "agent.started", summary: "claude manager #1 started a turn" }),
    event({ type: "agent.idle", summary: "claude manager #1 finished its turn" }),
    event({ type: "message.delivered", summary: "1 message(s) delivered to 3fedc3ce" }),
    event({ type: "manager.woken", summary: "manager woken: message from human" }),
  ];
  for (const e of mechanical) assert.equal(eventChannel(e), "activity", String(e.summary));
});

test("tool names lose the MCP server prefix that is noise in a chat line", () => {
  assert.equal(toolLabel("mcp__crew__crew_profiles"), "crew_profiles");
  assert.equal(toolLabel("ToolSearch"), "ToolSearch");
  assert.equal(toolLabel(""), "a tool");
  assert.equal(toolLabel(undefined), "a tool");
});

test("a turn's mechanics collapse to one line naming the tools and the time it took", () => {
  const items = chatItems(
    [
      event({ id: "a", type: "agent.started", agentId: "codex-1", at: "2026-01-01T21:00:00.000Z", summary: "started a turn" }),
      output({ id: "b", at: "2026-01-01T21:00:03.000Z", summary: "init" }),
      output({ id: "c", at: "2026-01-01T21:00:05.000Z", summary: "used a", data: { tool: "mcp__crew__crew_profiles" } }),
      output({ id: "d", at: "2026-01-01T21:00:07.000Z", summary: "used b", data: { tool: "mcp__crew__crew_agents" } }),
      output({ id: "e", at: "2026-01-01T21:00:12.000Z", summary: "used b again", data: { tool: "mcp__crew__crew_agents" } }),
    ],
    [],
    AGENTS,
  );
  const line = activitySummary(items);
  assert.match(line, /used crew_profiles, crew_agents/);
  assert.doesNotMatch(line, /crew_agents.*crew_agents/, "a repeated tool must be named once");
  assert.match(line, /2 steps/, "the non-tool rows are counted, not named");
  assert.match(line, /12s/, "how long the turn took is the other thing worth knowing");
  assert.equal(activitySummary([]), "");
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

test("consecutive rows from one speaker become one block, so the name is printed once", () => {
  const events = [
    event({ id: "a", type: "agent.started", agentId: "codex-1", at: "2026-01-01T21:00:00.000Z", summary: "started a turn" }),
    output({ id: "b", at: "2026-01-01T21:00:01.000Z", summary: "init" }),
    output({ id: "c", at: "2026-01-01T21:00:02.000Z", summary: "used x", data: { tool: "ToolSearch" } }),
    output({ id: "d", at: "2026-01-01T21:00:03.000Z", data: { text: "Ось що я знайшов." } }),
    event({ id: "e", type: "agent.idle", agentId: "codex-1", at: "2026-01-01T21:00:04.000Z", summary: "Codex #1 finished its turn" }),
  ];
  const blocks = chatBlocks(chatItems(events, [], AGENTS), AGENTS);
  assert.equal(blocks.length, 1, "one turn from one agent is one block");
  assert.equal(blocks[0].who, "Codex #1");
  assert.equal(blocks[0].says.length, 1, "only the reply is speech");
  assert.equal(blocks[0].acts.length, 4, "the four mechanical rows are kept, folded");
  const html = chatBlockHtml(blocks[0]);
  assert.equal(html.match(/class="cm-who"/g)?.length, 1, "the name must appear once, not once per row");
  assert.match(html, /Ось що я знайшов\./);
  assert.match(html, /data-act="acts"/, "the mechanics must still be reachable");
  assert.match(html, /init/, "nothing is deleted — only folded");
});

test("a different speaker starts a new block, and a long silence does too", () => {
  const items = chatItems(
    [
      output({ id: "a", agentId: "codex-1", at: "2026-01-01T21:00:00.000Z", data: { text: "first" } }),
      output({ id: "b", agentId: "manager-1", at: "2026-01-01T21:00:01.000Z", data: { text: "second" } }),
      output({ id: "c", agentId: "manager-1", at: "2026-01-01T21:00:02.000Z", data: { text: "still second" } }),
      output({ id: "d", agentId: "manager-1", at: "2026-01-01T23:00:00.000Z", data: { text: "much later" } }),
    ],
    [],
    AGENTS,
  );
  const blocks = chatBlocks(items, AGENTS);
  assert.deepEqual(blocks.map((b) => b.who), ["Codex #1", "Manager", "Manager"]);
  assert.equal(blocks[1].says.length, 2);
  assert.equal(blocks[2].says.length, 1, "a two-hour gap starts a fresh block");
});

test("the human's own message is a block of its own, marked as theirs", () => {
  const blocks = chatBlocks(chatItems([], [message()], AGENTS), AGENTS);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "human");
  assert.equal(blocks[0].who, "You");
  const html = chatBlockHtml(blocks[0]);
  assert.match(html, /data-kind="human"/);
  assert.match(html, /cm-tag-you/);
  assert.match(html, /що ти вмієш\?/);
});

test("the mailbox is the source for what was said, so nothing is ever the 200-char summary", () => {
  const long = "Подивився Docket. ".repeat(40).trim();
  const items = chatItems([], [message({ body: long })], AGENTS);
  assert.equal(items[0].text, long, "a message body must reach the chat whole");
  assert.ok(items[0].text.length > 700, "the sample is longer than any summary cap");
  assert.equal(items[0].channel, "say");
});

test("messages and events interleave by time, not by source", () => {
  const items = chatItems(
    [output({ id: "e1", at: "2026-01-01T21:00:02.000Z", data: { text: "reply" } })],
    [message({ id: "m1", createdAt: "2026-01-01T21:00:01.000Z", body: "ask" })],
    AGENTS,
  );
  assert.deepEqual(items.map((i) => i.text), ["ask", "reply"]);
});

test("notes and system lines stand on their own rather than joining a speaker's block", () => {
  const blocks = chatBlocks(
    chatItems(
      [
        output({ id: "a", at: "2026-01-01T21:00:00.000Z", data: { text: "working on it" } }),
        event({ id: "b", type: "assignment.completed", at: "2026-01-01T21:00:01.000Z", summary: "finished Fix the race" }),
        event({ id: "c", type: "crew.stopped", at: "2026-01-01T21:00:02.000Z", summary: "crew daemon stopped" }),
      ],
      [],
      AGENTS,
    ),
    AGENTS,
  );
  assert.deepEqual(blocks.map((b) => b.kind), ["agent", "note", "system"]);
  assert.match(chatBlockHtml(blocks[1]), /class="cn"/);
  assert.doesNotMatch(chatBlockHtml(blocks[1]), /cm-who/, "a note has no speaker header to print");
});

test("an empty conversation says so instead of rendering a blank panel", () => {
  assert.match(chatHtml([]), /Nothing has been said yet/);
});

// ---------------------------------------------------------------------------
// The daemon's actual agent.output contract
// ---------------------------------------------------------------------------

const { hasCarriedBody, seedEntries } = await import("./client/render.js");

test("data.kind is the discriminator, so no channel decision rests on a string pattern", () => {
  const reply = output({ summary: "Ось що я знайшов…", data: { kind: "text", text: "Ось що я знайшов.\n\n- один\n- два" } });
  const status = output({ summary: "init", data: { kind: "status", text: "init" } });
  const tool = output({ summary: "x used crew_wait", data: { kind: "tool", tool: "mcp__crew__crew_wait" } });
  assert.equal(eventChannel(reply), "say");
  assert.equal(eventChannel(status), "activity");
  assert.equal(eventChannel(tool), "activity");
  // The declared kind wins even when the text would fool the fallback heuristic.
  assert.equal(outputKind(output({ summary: "init", data: { kind: "text", text: "init" } })), "reply");
  assert.equal(outputKind(output({ summary: "a whole sentence", data: { kind: "status" } })), "status");
});

test("agent.idle is never mistaken for the reply on the daemon's normal path", () => {
  // The orchestrator publishes agent.idle itself with NO data, and its summary is a flattened
  // 200-char copy of what the agent already said. Promoting that to speech would print the
  // answer a second time, truncated — which is the exact bug this whole redesign is about.
  const idle = event({
    type: "agent.idle",
    agentId: "codex-1",
    summary: "Я — менеджер краю у репо github.com/pasichdev/docket. Сам код не пишу: розбиваю задачі…",
  });
  assert.equal(hasCarriedBody(idle), false);
  assert.equal(eventChannel(idle), "activity");

  // A supervisor turn that really did carry a body is the one case where it has something.
  const carried = event({ type: "agent.idle", agentId: "codex-1", summary: "cut…", data: { text: "Готово." } });
  assert.equal(eventChannel(carried), "say");
});

test("the same answer arriving by two doors is shown once, in its longer form", () => {
  const full = "Подивився Docket. Відкрито **15** пунктів —\n8 у Todo, 7 у Backlog.";
  const items = chatItems(
    [
      output({ id: "e1", at: "2026-01-01T21:00:00.000Z", summary: "Подивився Docket. Відкрито…", data: { kind: "text", text: full } }),
      event({ id: "e2", type: "agent.idle", agentId: "codex-1", at: "2026-01-01T21:00:01.000Z", summary: "Подивився Docket. Відкрито…", data: { text: "Подивився Docket. Відкрито…" } }),
    ],
    [],
    AGENTS,
  );
  const says = items.filter((item) => item.channel === "say");
  assert.equal(says.length, 1, "the answer must not appear twice");
  assert.equal(says[0].text, full, "and the copy that survives must be the full one, not the summary");
});

test("a clipped body says so, with the real size and where the rest lives", () => {
  const item = chatItems(
    [
      output({
        id: "e1",
        runId: "run-77",
        summary: "cut…",
        data: { kind: "text", text: "x".repeat(8000), truncated: true, fullLength: 12431 },
      }),
    ],
    [],
    AGENTS,
  )[0];
  assert.equal(item.truncated, true);
  assert.equal(item.fullLength, 12431);
  const html = chatBlockHtml(chatBlocks([item], AGENTS)[0]);
  assert.match(html, /the daemon kept the first 8,000 of 12,431 characters/);
  assert.match(html, /logs\/run-77\.log/, "the reader must be told where the untruncated stream is");
  // An untruncated body must not carry the notice.
  const clean = chatBlockHtml(chatBlocks(chatItems([output({ id: "e2", data: { kind: "text", text: "short" } })], [], AGENTS), AGENTS)[0]);
  assert.doesNotMatch(clean, /the daemon kept/);
});

test("the detail panel prefers the full-fidelity entries and still accepts the legacy lines", () => {
  const rich = seedEntries({
    output: ["2026-01-01T21:00:00.000Z flattened summary…"],
    outputEntries: [
      { at: "2026-01-01T21:00:00.000Z", kind: "text", summary: "flattened summary…", text: "the whole\nunflattened thing" },
      { at: "2026-01-01T21:00:01.000Z", kind: "status", summary: "init", text: "init" },
    ],
  });
  assert.deepEqual(rich.map((e) => e.text), ["the whole\nunflattened thing", "init"]);
  const legacy = seedEntries({ output: ["2026-01-01T21:00:00.000Z only a summary"] });
  assert.deepEqual(legacy, [{ at: "2026-01-01T21:00:00.000Z", text: "only a summary" }]);
  assert.deepEqual(seedEntries({}), []);
});

// ---------------------------------------------------------------------------
// Addressing: talking to one agent instead of to the manager
// ---------------------------------------------------------------------------

const { addressTargets, findTarget, parseAddress, targetOptionsHtml } = await import("./client/render.js");

const ROSTER = [
  agent({ id: "m", name: "lead", role: "manager", runtime: "claude" }),
  agent({ id: "b", name: "backend", role: "worker" }),
  agent({ id: "t", name: "tests", role: "worker" }),
  agent({ id: "r", name: "docs", role: "reviewer" }),
  agent({ id: "gone", name: "retired", status: "stopped" }),
  agent({ id: "ghost", name: "claude (docket)", origin: "observed" }),
];

test("the manager leads the roster, and only live managed agents can be addressed at all", () => {
  const targets = addressTargets(ROSTER);
  assert.deepEqual(targets.map((t) => t.name), ["lead", "backend", "docs", "tests"]);
  assert.equal(targets[0].manager, true);
  assert.ok(!targets.some((t) => t.name === "retired"), "a stopped agent cannot be handed work");
  assert.ok(!targets.some((t) => t.name.includes("docket")), "an observed session is not addressable — Crew has no handle on it");
});

test("a name resolves loosely, so @backend finds backend however it was typed", () => {
  const targets = addressTargets(ROSTER);
  for (const needle of ["backend", "Backend", "BACKEND", "back"]) {
    assert.equal(findTarget(targets, needle)?.id, "b", needle);
  }
  assert.equal(findTarget(targets, "b")?.id, "b", "an exact id still wins");
  assert.equal(findTarget(targets, "nobody"), null);
  assert.equal(findTarget(targets, ""), null);
  assert.equal(findTarget(targets, "claude (docket)"), null, "an observed session must never resolve");
});

test("an @mention at the front addresses that agent and is stripped from the message", () => {
  const targets = addressTargets(ROSTER);
  const sent = parseAddress("@backend rerun the tests", targets);
  assert.equal(sent.to, "b");
  assert.equal(sent.toName, "backend");
  assert.equal(sent.body, "rerun the tests");
  assert.equal(sent.mentioned, true);
  // The punctuated forms people actually type.
  assert.equal(parseAddress("@backend: rerun", targets).to, "b");
  assert.equal(parseAddress("  @tests, go", targets).to, "t");
});

test("addressing the manager by name is the same as not addressing anyone", () => {
  const targets = addressTargets(ROSTER);
  const sent = parseAddress("@lead plan the week", targets);
  assert.equal(sent.to, "", "the manager is the default, and the default sends no `to` at all");
  assert.equal(sent.body, "plan the week");
});

test("an @ that is not an agent is left alone rather than silently redirecting a message", () => {
  const targets = addressTargets(ROSTER);
  for (const text of ["@nobody do the thing", "email me at a@b.com about it", "look at foo@bar", "@backend"]) {
    const sent = parseAddress(text, targets);
    assert.equal(sent.mentioned, false, text);
    assert.equal(sent.body, text.trim(), text);
    assert.equal(sent.to, "", text);
  }
});

test("the picker supplies the target when nothing was mentioned, and a mention overrides it", () => {
  const targets = addressTargets(ROSTER);
  assert.equal(parseAddress("do the thing", targets, "t").to, "t", "the picker decides");
  assert.equal(parseAddress("@backend do the thing", targets, "t").to, "b", "the mention wins");
  assert.equal(parseAddress("do the thing", targets, "").to, "", "nothing chosen means the manager");
  assert.equal(parseAddress("do the thing", targets, "gone").to, "", "a target that left falls back to the manager");
});

test("the picker names the manager as the default and labels everyone else by role", () => {
  const html = targetOptionsHtml(addressTargets(ROSTER), "b");
  assert.match(html, /<option value="" >?|<option value="">lead \(manager\)<\/option>/);
  assert.match(html, /lead \(manager\)/);
  assert.match(html, /<option value="b" selected>backend · worker<\/option>/);
  assert.ok(!html.includes("retired") && !html.includes("docket"));
  // With no manager configured the default still exists and still means "the manager".
  assert.match(targetOptionsHtml([], ""), /the manager/);
});

test("a direct message is labelled in the conversation, and manager traffic is not", () => {
  const agents = { m: ROSTER[0], b: ROSTER[1] } as Record<string, Agent>;
  const direct = chatBlocks(
    chatItems([], [message({ id: "d1", from: "human", to: "b", body: "ти бро роби те" })], agents),
    agents,
  );
  assert.equal(direct[0].direct, true);
  assert.equal(direct[0].toWho, "backend");
  assert.match(chatBlockHtml(direct[0]), /→ backend/);

  const viaManager = chatBlocks(
    chatItems([], [message({ id: "d2", from: "human", to: "m", body: "plan the week" })], agents),
    agents,
  );
  assert.equal(viaManager[0].direct, false, "the normal path needs no label");
  assert.doesNotMatch(chatBlockHtml(viaManager[0]), /→/);
});

test("a rename repaints the conversation instead of leaving the old name on screen", () => {
  const before = { b: ROSTER[1] } as Record<string, Agent>;
  const after = { b: { ...ROSTER[1], name: "payments" } } as Record<string, Agent>;
  const events = [output({ id: "e1", agentId: "b", data: { kind: "text", text: "done" } })];
  const oldBlock = chatBlocks(chatItems(events, [], before), before)[0];
  const newBlock = chatBlocks(chatItems(events, [], after), after)[0];
  assert.equal(oldBlock.who, "backend");
  assert.equal(newBlock.who, "payments");
  // The signature is what app.ts diffs on. If it ignored the name, the stale one would stay.
  assert.notEqual(oldBlock.sig, newBlock.sig, "a renamed agent must invalidate its block");
  assert.match(chatBlockHtml(newBlock), /payments/);
});

// ---------------------------------------------------------------------------
// The live turn indicator
//
// A turn takes 20–60 seconds and the conversation used to say nothing for all of it. The
// property under test is not "a spinner appears" — it is that the spinner is a FUNCTION OF
// REAL STATE and can therefore never outlive the turn. There is no timer in this feature that
// can put a row on the screen; the only clock in it is how long an already-ENDED turn's
// failure lingers before the conversation's own note carries it alone.
// ---------------------------------------------------------------------------

const { TURN_RESOLVE_MS, turnIndicators, turnHtml, turnsHtml, turnsAnnouncement } = await import(
  "./client/render.js"
);

const T0 = Date.parse("2026-01-01T21:04:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function started(agentId: string, offsetMs = -20000): Event {
  return event({ id: `s:${agentId}:${offsetMs}`, type: "agent.started", agentId, at: at(offsetMs) }) as Event;
}

test("who is working comes from the daemon's own status, and from nothing else", () => {
  const roster = [
    agent({ id: "b", name: "backend", status: "working" }),
    agent({ id: "t", name: "tests", status: "idle" }),
    agent({ id: "m", name: "lead", role: "manager", status: "starting" }),
    agent({ id: "ghost", name: "claude (docket)", origin: "observed", status: "working" }),
  ];
  const rows = turnIndicators(roster, [started("b"), started("m")], T0);
  assert.deepEqual(rows.map((row) => `${row.name}:${row.phase}`), ["backend:working", "lead:starting"]);
  assert.ok(
    !rows.some((row) => row.name.includes("docket")),
    "an observed session is not Crew's turn to narrate — Crew did not launch it",
  );
});

test("an idle agent gets no row however many agent.started events are on the stream", () => {
  // The guarantee against an eternal spinner: the event log cannot hold one up on its own.
  const roster = [agent({ id: "b", name: "backend", status: "idle" })];
  const noisy = [started("b", -60000), started("b", -30000), started("b", -1000)];
  assert.deepEqual(turnIndicators(roster, noisy, T0), []);
});

test("the clock counts the turn, not the agent's uptime", () => {
  const roster = [agent({ id: "b", name: "backend", status: "working", startedAt: at(-3600000) })];
  const [row] = turnIndicators(roster, [started("b", -300000), started("b", -12000)], T0);
  assert.equal(row.since, at(-12000), "the newest agent.started opens the turn on screen");
  assert.match(turnHtml(row, T0), /data-since="2026-01-01T21:03:48\.000Z">12s</);
});

test("the row says what the agent last did, from the same output the transcript is built from", () => {
  const roster = [agent({ id: "b", name: "backend", status: "working" })];
  const rows = turnIndicators(
    roster,
    [
      started("b"),
      output({ id: "o1", agentId: "b", at: at(-9000), summary: "used Read" }),
      output({ id: "o2", agentId: "b", at: at(-4000), summary: "rewriting the composer's height" }),
    ],
    T0,
  );
  assert.equal(rows[0].line, "rewriting the composer's height");
});

test("a successful turn resolves into its reply, not into a second row saying it finished", () => {
  const roster = [agent({ id: "b", name: "backend", status: "idle" })];
  const events = [started("b", -30000), event({ id: "i", type: "agent.idle", agentId: "b", at: at(-1000) }) as Event];
  assert.deepEqual(turnIndicators(roster, events, T0), [], "the answer is the outcome; saying so twice is noise");
});

test("a failed turn ends the indicator with the failure, and the reason survives", () => {
  const roster = [agent({ id: "b", name: "backend", status: "failed" })];
  const events = [
    started("b", -30000),
    event({
      id: "f",
      type: "agent.failed",
      agentId: "b",
      at: at(-2000),
      summary: "backend failed: runtime exited with code 1",
    }) as Event,
  ];
  const [row] = turnIndicators(roster, events, T0);
  assert.equal(row.phase, "failed");
  assert.equal(row.reason, "runtime exited with code 1", "the row prints the name already");
  const html = turnHtml(row, T0);
  assert.match(html, /data-phase="failed"/);
  assert.doesNotMatch(html, /tw-dots/, "a finished turn must not still be animating");
  assert.doesNotMatch(html, /data-since/, "nothing is still counting up");
});

test("a cancelled run is told apart from a stopped agent, and both end the spinner", () => {
  // cancelAgentRun publishes agent.stopped with this exact summary and leaves the agent idle;
  // stopping the agent publishes the same type with a different one. Same type, two endings.
  const idle = [agent({ id: "b", name: "backend", status: "idle" })];
  const [cancelled] = turnIndicators(
    idle,
    [started("b", -9000), event({ id: "c", type: "agent.stopped", agentId: "b", at: at(-500), summary: "cancelled run r-9" }) as Event],
    T0,
  );
  assert.equal(cancelled.phase, "cancelled");

  const gone = [agent({ id: "b", name: "backend", status: "stopped" })];
  const [stopped] = turnIndicators(
    gone,
    [started("b", -9000), event({ id: "x", type: "agent.stopped", agentId: "b", at: at(-500), summary: "stopped b" }) as Event],
    T0,
  );
  assert.equal(stopped.phase, "stopped");
});

test("a resolved row ages out; only a running turn is held up by the daemon", () => {
  const roster = [agent({ id: "b", name: "backend", status: "failed" })];
  const events = [event({ id: "f", type: "agent.failed", agentId: "b", at: at(0), summary: "backend failed: boom" }) as Event];
  assert.equal(turnIndicators(roster, events, T0).length, 1);
  assert.equal(turnIndicators(roster, events, T0 + TURN_RESOLVE_MS).length, 1, "still inside the window");
  assert.deepEqual(turnIndicators(roster, events, T0 + TURN_RESOLVE_MS + 1), [], "and gone the moment it is past");
});

test("a new turn clears the last one's failure rather than wearing it forever", () => {
  const roster = [agent({ id: "b", name: "backend", status: "working" })];
  const events = [
    event({ id: "f", type: "agent.failed", agentId: "b", at: at(-8000), summary: "backend failed: boom" }) as Event,
    started("b", -2000),
  ];
  const [row] = turnIndicators(roster, events, T0);
  assert.equal(row.phase, "working");
  assert.equal(row.reason, "");
});

test("working agents sort above whatever just ended, so the live row is never buried", () => {
  const roster = [
    agent({ id: "z", name: "zeta", status: "failed" }),
    agent({ id: "a", name: "alpha", status: "working" }),
  ];
  const events = [
    started("a", -5000),
    event({ id: "f", type: "agent.failed", agentId: "z", at: at(-1000), summary: "zeta failed: boom" }) as Event,
  ];
  assert.deepEqual(turnIndicators(roster, events, T0).map((row) => row.name), ["alpha", "zeta"]);
});

test("the live region is told the state, not every streamed line", () => {
  const one = turnIndicators([agent({ id: "b", name: "backend", status: "working" })], [started("b")], T0);
  assert.equal(turnsAnnouncement(one), "backend is working.");
  // The announcement is a function of phase and name only — an output line cannot change it,
  // which is what stops a live region firing once per streamed token.
  const chatty = turnIndicators(
    [agent({ id: "b", name: "backend", status: "working" })],
    [started("b"), output({ id: "o", agentId: "b", at: at(-1000), summary: "used Bash" })],
    T0,
  );
  assert.equal(turnsAnnouncement(chatty), "backend is working.");
  assert.equal(turnsAnnouncement([]), "", "silence when nothing is happening");
  const failed = turnIndicators(
    [agent({ id: "b", name: "backend", status: "failed" })],
    [event({ id: "f", type: "agent.failed", agentId: "b", at: at(-1000), summary: "backend failed: boom" }) as Event],
    T0,
  );
  assert.equal(turnsAnnouncement(failed), "backend: the turn failed.");
});

test("the row is drawn as the speaker it belongs to, and says who in words", () => {
  const roster = [agent({ id: "m", name: "lead", role: "manager", status: "working" })];
  const html = turnsHtml(turnIndicators(roster, [started("m", -5000)], T0), T0);
  assert.match(html, /data-agent="m"/);
  assert.match(html, /data-role="manager"/);
  assert.match(html, /class="tw-who">lead</);
  assert.match(html, /tw-dots/, "a running turn animates");
  assert.match(html, /working/);
});
