/**
 * The Office UI's pure renderers.
 *
 * Everything in this file is a total function of its arguments: no DOM, no fetch, no clock
 * reads (the current time is always passed in). That is deliberate and load-bearing —
 * `node --test` imports this module directly, exactly the way Docket Core's
 * src/web/client/app/render.escaping.test.ts imports cards.ts, instead of running the page
 * in a fake browser.
 *
 * The browser loads this same compiled file as a native ES module (served by routes.ts),
 * so it must never import anything Node-only. The one import below is `import type`, which
 * TypeScript erases — nothing reaches the browser from ../../types.js.
 */

import type { Assignment, CrewAgent, CrewEvent, CrewMessage, CrewProfile } from "../../types.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";

// ---------------------------------------------------------------------------
// Escaping — the single boundary
// ---------------------------------------------------------------------------

/**
 * Agent names, assignment titles and event summaries are text a *runtime* produced. A model
 * that decides to name a worker `</script><img onerror=...>` is not an attack scenario we
 * get to rule out, so every value that reaches markup goes through here first.
 *
 * ONE implementation, in markdown.ts, re-exported here. It used to be written out twice, with
 * a comment claiming an import cycle forced it — but render.ts already imports markdown.ts
 * and markdown.ts imports nothing, so there was never a cycle in this direction. Two copies of
 * the page's entire safety boundary, kept in step by a test that noticed drift only after it
 * happened, is a worse guarantee than one copy that cannot drift.
 */
export { escapeHtml };

/**
 * Ids travel into `data-` attributes that the click delegate reads back, so they are held to
 * a stricter rule than free text: anything that is not a plain identifier character is
 * dropped rather than escaped. An id that cannot survive this was never one of ours.
 */
export function safeId(value: unknown): string {
  return String(value ?? "").replace(/[^A-Za-z0-9._:@#-]/g, "");
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

/** `21:04` in the viewer's own timezone. Never throws — a torn event still renders. */
export function formatTime(iso: unknown): string {
  const date = new Date(String(iso ?? ""));
  if (Number.isNaN(date.getTime())) return "--:--";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Coarse "how long has this been running", for a label that is glanced at, not read. */
export function elapsedLabel(startedAt: unknown, now: number): string {
  const started = new Date(String(startedAt ?? "")).getTime();
  if (!startedAt || Number.isNaN(started)) return "";
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * "codex · gpt-5" / "opencode · openrouter/anthropic/claude-sonnet-4".
 *
 * The provider is shown separately only when it is not already the first segment of the
 * model string — opencode encodes `provider/model` in one field, and printing
 * "openrouter · openrouter/…" reads as a rendering bug.
 */
export function runtimeLabel(agent: Pick<CrewAgent, "runtime" | "model" | "provider">): string {
  const parts: string[] = [];
  if (agent.runtime) parts.push(agent.runtime);
  const model = agent.model ?? "";
  const provider = agent.provider ?? "";
  if (provider && !model.startsWith(`${provider}/`)) parts.push(provider);
  if (model) parts.push(model);
  return parts.join(" · ");
}

const STATUS_TEXT: Record<string, string> = {
  starting: "starting",
  idle: "idle",
  working: "working",
  failed: "failed",
  stopped: "stopped",
};

export function statusLabel(status: unknown): string {
  return STATUS_TEXT[String(status ?? "")] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export type ColumnId = "lead" | "workers" | "review";

/**
 * The miniature office floor plan. Role decides the desk; an agent with no role (every
 * observed Docket session, and any managed agent whose profile omitted one) sits with the
 * workers rather than vanishing off the board.
 */
export function columnOf(agent: Pick<CrewAgent, "role">): ColumnId {
  if (agent.role === "manager") return "lead";
  if (agent.role === "reviewer") return "review";
  return "workers";
}

export function groupAgents(agents: CrewAgent[]): Record<ColumnId, CrewAgent[]> {
  const columns: Record<ColumnId, CrewAgent[]> = { lead: [], workers: [], review: [] };
  for (const agent of agents) columns[columnOf(agent)].push(agent);
  const rank: Record<string, number> = { working: 0, starting: 1, idle: 2, failed: 3, stopped: 4 };
  for (const id of Object.keys(columns) as ColumnId[]) {
    columns[id].sort(
      (a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.name.localeCompare(b.name),
    );
  }
  return columns;
}

// ---------------------------------------------------------------------------
// Agent cards
// ---------------------------------------------------------------------------

function metaRow(label: string, value: string): string {
  return value ? `<div class="ag-meta"><span class="k">${escapeHtml(label)}</span>${escapeHtml(value)}</div>` : "";
}

/**
 * MANAGED renders solid with the full control strip. OBSERVED renders dashed, muted and
 * button-less — spec §17: Crew did not launch that session and must never draw a control
 * that implies it can prompt, cancel or kill it. The difference is stated three ways
 * (border, an explicit badge, and a sentence) because a dashed border alone is exactly the
 * kind of signal a user stops seeing after a day.
 */
export function agentCardHtml(
  agent: CrewAgent,
  assignment: Assignment | null,
  now: number,
): string {
  const observed = agent.origin === "observed";
  const id = safeId(agent.id);
  const elapsed = elapsedLabel(agent.startedAt, now);
  const task = assignment ? assignment.title : "";
  const runtime = runtimeLabel(agent);

  const actions = observed
    ? `<p class="ag-observed-note">Docket session Crew didn't launch — visible only. Crew can't prompt, cancel or stop it.</p>`
    : `<div class="ag-actions">
        <button type="button" class="btn btn-ghost" data-act="open" data-agent="${id}" aria-label="Open ${escapeHtml(agent.name)}">Open</button>
        <button type="button" class="btn btn-ghost" data-act="message" data-agent="${id}" aria-label="Message ${escapeHtml(agent.name)}">Message</button>
        <button type="button" class="btn btn-ghost danger" data-act="cancel" data-agent="${id}" aria-label="Cancel the current run of ${escapeHtml(agent.name)}">Cancel</button>
      </div>`;

  return `<article class="ag ${observed ? "observed" : "managed"}" data-agent="${id}" data-origin="${observed ? "observed" : "managed"}" data-status="${escapeHtml(agent.status)}" tabindex="0" aria-label="${escapeHtml(agent.name)}, ${observed ? "observed" : "managed"}, ${escapeHtml(statusLabel(agent.status))}">
  <header class="ag-head">
    <span class="ag-name">${escapeHtml(agent.name)}</span>
    <span class="pill st-${escapeHtml(agent.status)}">${escapeHtml(statusLabel(agent.status))}</span>
  </header>
  <p class="ag-task">${task ? escapeHtml(task) : "<span class=\"faint\">no current task</span>"}</p>
  ${metaRow("runtime", runtime)}
  ${metaRow("role", agent.role ?? "")}
  ${metaRow("profile", agent.profile ?? "")}
  <div class="ag-foot">
    <span class="tag ${observed ? "tag-observed" : "tag-managed"}">${observed ? "observed" : "managed"}</span>
    <span class="ag-elapsed"${agent.startedAt ? ` data-since="${escapeHtml(agent.startedAt)}"` : ""}>${escapeHtml(elapsed)}</span>
  </div>
  ${actions}
</article>`;
}

export function columnHtml(
  title: string,
  agents: CrewAgent[],
  assignments: Record<string, Assignment>,
  now: number,
): string {
  const cards = agents
    .map((agent) => {
      const assignment = agent.currentAssignmentId ? (assignments[agent.currentAssignmentId] ?? null) : null;
      return agentCardHtml(agent, assignment, now);
    })
    .join("\n");
  return `<section class="col" aria-label="${escapeHtml(title)}">
  <h2 class="col-head">${escapeHtml(title)} <span class="n">${agents.length}</span></h2>
  <div class="col-body">${cards || '<p class="empty">nobody here yet</p>'}</div>
</section>`;
}

export function boardHtml(
  agents: CrewAgent[],
  assignments: Record<string, Assignment>,
  now: number,
): string {
  const columns = groupAgents(agents);
  return [
    columnHtml("Lead", columns.lead, assignments, now),
    columnHtml("Workers", columns.workers, assignments, now),
    columnHtml("Review", columns.review, assignments, now),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export function assignmentRowHtml(assignment: Assignment, agents: Record<string, CrewAgent>): string {
  const assignee = agents[assignment.assignedTo]?.name ?? assignment.assignedTo;
  const docket = assignment.docketTodoId
    ? `<span class="asg-docket" title="Linked Docket task">${escapeHtml(assignment.docketTodoId)}</span>`
    : '<span class="faint">—</span>';
  return `<tr>
  <td class="mono">${escapeHtml(assignment.id)}</td>
  <td>${escapeHtml(assignment.title)}</td>
  <td>${escapeHtml(assignee)}</td>
  <td><span class="pill as-${escapeHtml(assignment.status)}">${escapeHtml(assignment.status)}</span></td>
  <td>${docket}</td>
</tr>`;
}

export function assignmentsHtml(assignments: Assignment[], agents: Record<string, CrewAgent>): string {
  if (assignments.length === 0) return '<p class="empty">No assignments yet.</p>';
  const rows = assignments.map((a) => assignmentRowHtml(a, agents)).join("\n");
  return `<table class="asg">
  <thead><tr><th>id</th><th>task</th><th>assignee</th><th>status</th><th>docket</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

// ---------------------------------------------------------------------------
// Team Feed
// ---------------------------------------------------------------------------

/** Which side of the room an event came from — drives only the colour of the dot. */
export function feedKind(type: string): "manager" | "worker" | "review" | "system" | "error" {
  if (type.startsWith("review.")) return "review";
  if (type === "assignment.failed" || type === "agent.failed") return "error";
  if (type === "manager.woken" || type === "manager.paused" || type === "goal.created") return "manager";
  if (type.startsWith("agent.") || type.startsWith("assignment.")) return "worker";
  return "system";
}

function nameOf(agents: Record<string, CrewAgent>, id: unknown): string {
  const key = String(id ?? "");
  if (!key) return "";
  return agents[key]?.name ?? key;
}

function dataString(event: CrewEvent, ...keys: string[]): string {
  const data = event.data;
  if (!data) return "";
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

export interface FeedLine {
  time: string;
  /** "Manager → Codex #1", or a single name, or "" when the event belongs to no one. */
  actor: string;
  text: string;
  kind: ReturnType<typeof feedKind>;
}

/**
 * The Team Feed's whole job: turn a CrewEvent into the sentence a human reads.
 *
 * `summary` is the event's own one-liner (spec §39) and is preferred whenever present —
 * the orchestrator knows more about why an event happened than this function ever can. The
 * derivations below are the fallback for events that arrive without one, so a new event type
 * degrades to something readable instead of a blank row.
 */
export function feedLine(event: CrewEvent, agents: Record<string, CrewAgent>): FeedLine {
  const time = formatTime(event.at);
  const kind = feedKind(String(event.type ?? ""));
  const from = nameOf(agents, dataString(event, "from", "assignedBy"));
  const to = nameOf(agents, dataString(event, "to", "assignedTo"));
  const subject = nameOf(agents, event.agentId);

  let actor = "";
  if (from && to) actor = `${from} → ${to}`;
  else if (to) actor = `Manager → ${to}`;
  else if (subject) actor = subject;
  else if (from) actor = from;

  let text = String(event.summary ?? "").trim();
  if (!text) {
    const title = dataString(event, "title", "body", "goal");
    switch (event.type) {
      case "goal.created":
        text = title ? `new goal: ${title}` : "a new goal was created";
        break;
      case "assignment.created":
        text = title || "a new assignment was created";
        break;
      case "assignment.completed":
        text = title ? `finished ${title}` : "assignment completed";
        break;
      case "assignment.failed":
        text = title ? `failed ${title}` : "assignment failed";
        break;
      case "manager.woken":
        text = "manager woken";
        break;
      case "manager.paused":
        text = "manager paused — waiting for a human";
        break;
      case "review.requested":
        text = title ? `review requested: ${title}` : "review requested";
        break;
      case "review.completed":
        text = title ? `review completed: ${title}` : "review completed";
        break;
      case "message.sent":
        text = title || "message sent";
        break;
      default:
        text = String(event.type ?? "event");
    }
  }
  return { time, actor, text, kind };
}

export function feedLineHtml(event: CrewEvent, agents: Record<string, CrewAgent>): string {
  const line = feedLine(event, agents);
  const actor = line.actor ? `<span class="fd-actor">${escapeHtml(line.actor)}</span>` : "";
  return `<li class="fd-row" data-kind="${escapeHtml(line.kind)}" data-type="${escapeHtml(String(event.type ?? ""))}">
  <span class="fd-dot" aria-hidden="true"></span>
  <time class="fd-time">${escapeHtml(line.time)}</time>
  ${actor}
  <span class="fd-text">${escapeHtml(line.text)}</span>
</li>`;
}

export function feedHtml(events: CrewEvent[], agents: Record<string, CrewAgent>): string {
  if (events.length === 0) return '<li class="empty">Nothing has happened yet.</li>';
  return events.map((event) => feedLineHtml(event, agents)).join("\n");
}

// ---------------------------------------------------------------------------
// Live agent output
// ---------------------------------------------------------------------------

export interface OutputEntry {
  at: string;
  text: string;
}

/**
 * The daemon's per-agent buffer is a list of "&lt;iso&gt; &lt;summary&gt;" strings
 * (GET /api/agents/:id). Split on the first space; a line that does not start with a
 * timestamp is kept whole rather than silently truncated.
 */
export function parseOutputLine(line: string): OutputEntry {
  const space = line.indexOf(" ");
  if (space <= 0) return { at: "", text: line };
  const at = line.slice(0, space);
  return Number.isNaN(new Date(at).getTime()) ? { at: "", text: line } : { at, text: line.slice(space + 1) };
}

/**
 * The agent panel's transcript: the buffer the daemon replays when the panel opens, plus
 * every `agent.output` event that has arrived on the live stream since, merged and
 * deduplicated so the seam is invisible.
 *
 * Only `agent.output` is included, and only its `summary` — which is what the supervisor
 * built from the runtime's *visible* stream (AgentEvent text/status/tool). No reasoning,
 * thinking or chain-of-thought channel is read anywhere in Crew, and this renderer
 * deliberately has no access to one: it is handed CrewEvents and buffer lines, and neither
 * ever carries private model reasoning.
 */
export function outputEntries(seed: string[], events: CrewEvent[], agentId: string): OutputEntry[] {
  const entries = seed.map(parseOutputLine);
  for (const event of events) {
    if (event.type !== "agent.output" || event.agentId !== agentId) continue;
    entries.push({ at: String(event.at ?? ""), text: String(event.summary ?? "") });
  }
  const seen = new Set<string>();
  const unique: OutputEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.at}\u0000${entry.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * `GET /api/agents/:id` now answers with `outputEntries` beside the old `output` string list:
 * the same rows, but carrying the full unflattened `text` instead of the 200-char summary.
 * Prefer it when it is there; fall back to parsing the legacy lines when it is not.
 */
export function seedEntries(body: Record<string, unknown>): OutputEntry[] {
  const rich = body.outputEntries;
  if (Array.isArray(rich)) {
    return rich
      .map((row) => {
        const entry = (row ?? {}) as Record<string, unknown>;
        const text = typeof entry.text === "string" && entry.text.trim() ? entry.text : String(entry.summary ?? "");
        return { at: String(entry.at ?? ""), text };
      })
      .filter((entry) => entry.text !== "");
  }
  const legacy = body.output;
  return Array.isArray(legacy) ? legacy.map((line) => parseOutputLine(String(line))) : [];
}

export function outputHtml(entries: OutputEntry[]): string {
  if (entries.length === 0) return '<p class="empty">No visible output from this agent yet.</p>';
  return entries
    .map(
      (entry) =>
        `<div class="out-row"><time class="out-time">${escapeHtml(entry.at ? formatTime(entry.at) : "")}</time><span class="out-text">${escapeHtml(entry.text)}</span></div>`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export function profileRowHtml(profile: CrewProfile, isManager: boolean): string {
  const spec = runtimeLabel(profile);
  return `<div class="pf-row">
  <div class="pf-text">
    <span class="pf-name">${escapeHtml(profile.name)}</span>
    <span class="pf-role">${escapeHtml(profile.role ?? "")}</span>
    ${isManager ? '<span class="tag tag-manager">manager</span>' : ""}
    <div class="pf-spec">${escapeHtml(spec)}</div>
  </div>
  <button type="button" class="btn btn-solid" data-act="spawn" data-profile="${escapeHtml(profile.name)}" aria-label="Spawn a ${escapeHtml(profile.name)} agent">Spawn</button>
</div>`;
}

export function profilesHtml(profiles: CrewProfile[], manager: string): string {
  if (profiles.length === 0) return '<p class="empty">No profiles configured.</p>';
  return profiles.map((profile) => profileRowHtml(profile, profile.name === manager)).join("\n");
}

/**
 * What the board shows when the daemon is up and the room is empty.
 *
 * A blank three-column shell is the worst possible first screen after `docket crew start`:
 * it looks broken and it tells the user nothing about what to do. So the empty board becomes
 * the roster — every configured profile with a one-click launch, and the manager first,
 * because starting the manager is what the user almost always wants.
 */
export function coldStartHtml(
  profiles: CrewProfile[],
  manager: string,
  controlsAvailable: boolean,
  error: string,
): string {
  if (error) {
    return `<div class="cold">
  <h2>Nobody is in the office yet</h2>
  <p class="warn">${escapeHtml(error)}</p>
</div>`;
  }
  if (profiles.length === 0) {
    return `<div class="cold">
  <h2>Nobody is in the office yet</h2>
  <p>No profiles are configured. Add some to <code>~/.docket/crew/config.yml</code> and reload.</p>
</div>`;
  }
  const ordered = [...profiles].sort(
    (a, b) => Number(b.name === manager) - Number(a.name === manager) || a.name.localeCompare(b.name),
  );
  const rows = ordered.map((profile) => profileRowHtml(profile, profile.name === manager)).join("\n");
  const note = controlsAvailable
    ? "<p>Start the manager and it will hire the rest, or launch anyone directly.</p>"
    : `<p class="warn">${escapeHtml(
        "This daemon doesn't expose Crew's control endpoints yet, so these are read-only for now.",
      )}</p>`;
  return `<div class="cold">
  <h2>Nobody is in the office yet</h2>
  ${note}
  <div class="cold-roster">${rows}</div>
</div>`;
}

// ===========================================================================
// The pixel office
// ===========================================================================
//
// Technique: every sprite is a character map — one char per pixel — compiled to a run of
// <rect> elements inside an inline SVG with a tiny integer viewBox. Not a <canvas>, and not
// a box-shadow pixel grid.
//
//  * SVG rects are DOM, so a sprite costs nothing to render server-side-style from a pure
//    function, and `node --test` can assert on the markup exactly the way it already asserts
//    on the cards. A canvas would be an opaque blob with no test surface and no accessibility.
//  * Every pixel's colour is `var(--px-…)`, so the whole office re-themes (dark/light,
//    role tint, runtime badge, screen state) from CSS alone — no redraw, no JS.
//  * Animation is CSS transforms on named <g> groups keyed off `data-status`, so a state
//    change is one attribute write and the CPU is idle when nothing is happening.
//  * No external asset, no data-URI image, no dependency. The art is the source.
//
// The maps below are drawn on a 32x24 grid for a desk and are meant to be read as pictures.

/** char → CSS custom property. A char with no entry is transparent. */
export type PixelPalette = Record<string, string>;

const PX_TOKEN = /^--px-[a-z0-9-]+$/;

/**
 * Compile a character map to SVG rects, merging horizontal runs of the same colour.
 *
 * The token allowlist is not decoration: these strings land inside `fill="var(…)"`, and a
 * palette is the one place a future edit could put arbitrary text into an attribute.
 */
export function pixelRects(rows: string[], palette: PixelPalette, ox = 0, oy = 0): string {
  const out: string[] = [];
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y] ?? "";
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      const token = palette[ch];
      if (!token || !PX_TOKEN.test(token)) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < row.length && row[x + run] === ch) run++;
      out.push(`<rect x="${ox + x}" y="${oy + y}" width="${run}" height="1" fill="var(${token})"/>`);
      x += run;
    }
  }
  return out.join("");
}

const PALETTE: PixelPalette = {
  k: "--px-chair-dark",
  l: "--px-chair",
  h: "--px-hair",
  s: "--px-skin",
  e: "--px-eye",
  m: "--px-mouth",
  b: "--px-shirt",
  f: "--px-frame",
  d: "--px-desk",
  t: "--px-desk-dark",
  g: "--px-mug",
  p: "--px-paper",
  u: "--px-lamp",
  r: "--px-rt",
  c: "--px-cab",
  w: "--px-cab-drawer",
  i: "--px-cab-handle",
  o: "--px-ghost",
  x: "--px-ghost-eye",
  z: "--px-alert-mark",
  v: "--px-hire",
};

// --- the desk unit, 32 wide x 24 tall ------------------------------------------------------

/**
 * Office chair: a backrest on a gas post, not a filled slab.
 *
 * Deliberately narrower and shorter than the sitter, so an occupied desk shows only the
 * backrest peeking past the shoulders — a chair the same size as the body would be invisible
 * when used and read as a second monitor when empty, which is exactly what the first draft did.
 */
const CHAIR = [
  "...kkkkkkkkkkkk",
  "...kllllllllllk",
  "...kllllllllllk",
  "...kllllllllllk",
  "...kllllllllllk",
  "...kkkkkkkkkkkk",
  ".......kkkk",
  ".......kkkk",
  ".......kkkk",
  ".......kkkk",
];
const CHAIR_Y = 8;

const HEAD = [
  ".....hhhhhhhh",
  "....hhhhhhhhhh",
  "....hssssssssh",
  "....hssssssssh",
  "....hsessssesh",
  "....hssssssssh",
  "....hsssmmsssh",
  ".....ssssssss",
  "......ssssss",
];
const HEAD_Y = 3;

const BODY = [
  "....bbbbbbbbbb",
  "...bbbbbbbbbbbb",
  "...bbbbbbbbbbbb",
  "...bbbbbbbbbbbb",
  "...bbbbbbbbbbbb",
  "...bbbbbbbbbbbb",
];
const BODY_Y = 12;

/** Forearms and hands, resting on the desk lip. Their own group so typing can move them. */
const ARMS = ["..bb..........bb", "..bb..........bb", "..bb..........bb", ".ssss........ssss"];
const ARMS_Y = 14;

const MONITOR = [
  "................ffffffff",
  "................f......f",
  "................f......f",
  "................f......f",
  "................f......f",
  "................f......f",
  "................ffffffff",
  "..................ffff",
  ".................ffffff",
];
const MONITOR_Y = 9;
/** The screen is one rect rather than map pixels: its colour is the loudest status signal. */
const SCREEN = { x: 17, y: 10, w: 6, h: 5 };
/** An exclamation mark inside the screen, revealed by CSS only when the agent failed. */
const ALERT = ["zz", "zz", "zz", "..", "zz"];

const DESK = [
  "dddddddddddddddddddddddddddddddd",
  "dddddddddddddddddddddddddddddddd",
  "tttttttttttttttttttttttttttttttt",
  "tttttttttttttttttttttttttttttttt",
  "..tt........................tt..",
  "..tt........................tt..",
];
const DESK_Y = 18;

/** Role reads at a glance from the desk it is on, before any label is read. */
const DECOR: Record<string, { rows: string[]; y: number }> = {
  manager: {
    y: 11,
    rows: [
      "..........................uuu",
      ".........................uuuuu",
      "...........................u",
      "...........................u",
      "...........................u",
      "...........................u",
      ".........................uuuuu",
    ],
  },
  reviewer: {
    y: 15,
    rows: ["..........................pppp", ".........................ppppp", ".........................ppppp"],
  },
  worker: { y: 15, rows: [".........................ggg", ".........................gggg", ".........................ggg"] },
};

/**
 * The runtime sticker on the desk front. Three different *shapes*, not three colours of the
 * same shape — a badge that only differs by hue is invisible to a colour-blind user and
 * unreadable in a screenshot.
 */
const RUNTIME_BADGE: Record<string, string[]> = {
  claude: ["r..r", ".rr.", "r..r"],
  codex: ["rr..", "..rr", "rr.."],
  opencode: ["rrrr", "r..r", "rrrr"],
};
const BADGE_AT = { x: 3, y: 20 };

/** The plus that marks a free desk. Sits exactly where a head would be. */
const HIRE_PLUS = ["...v...", "...v...", "...v...", "vvvvvvv", "...v...", "...v...", "...v..."];

const GHOST = [
  "....oooo",
  "..oooooooo",
  ".oooooooooo",
  ".oooooooooo",
  ".ooxooooxoo",
  ".oooooooooo",
  ".oooooooooo",
  ".oooooooooo",
  ".oooooooooo",
  ".oooooooooo",
  ".oooooooooo",
  ".oooooooooo",
  ".oo.oo.oo.o",
];

const CABINET_BODY = Array.from({ length: 26 }, () => "cccccccccccccccccccc").concat([
  "..cc............cc..",
  "..cc............cc..",
]);
const CABINET_DRAWER = [
  "wwwwwwwwwwwwwwww",
  "wwwwwwwwwwwwwwww",
  "wwwwwwiiiiwwwwww",
  "wwwwwwiiiiwwwwww",
  "wwwwwwwwwwwwwwww",
  "wwwwwwwwwwwwwwww",
];
const DRAWER_ROWS = [2, 9, 16];

// ---------------------------------------------------------------------------
// State → sprite. The whole point: nothing here is decorative randomness.
// ---------------------------------------------------------------------------

export type Pose = "arriving" | "typing" | "breathing" | "slumped" | "empty";

/** What the character is doing. One pose per AgentStatus, and no other input. */
export function poseFor(status: unknown): Pose {
  switch (String(status ?? "")) {
    case "starting":
      return "arriving";
    case "working":
      return "typing";
    case "idle":
      return "breathing";
    case "failed":
      return "slumped";
    case "stopped":
      return "empty";
    default:
      return "breathing";
  }
}

export type ScreenState = "boot" | "flicker" | "dim" | "alert" | "off";

/** What the monitor is doing. Same input, so the two can never disagree. */
export function screenFor(status: unknown): ScreenState {
  switch (String(status ?? "")) {
    case "starting":
      return "boot";
    case "working":
      return "flicker";
    case "idle":
      return "dim";
    case "failed":
      return "alert";
    case "stopped":
      return "off";
    default:
      return "dim";
  }
}

/**
 * A stable hair colour per agent so two workers at neighbouring desks are tellable apart.
 *
 * Derived from the agent's id, never from Math.random: the same agent is the same person on
 * every reload and in every reconnect, which is the difference between identity and noise.
 */
export function hairFor(id: unknown): number {
  const key = String(id ?? "");
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % 5;
}

const RUNTIMES = new Set(["claude", "codex", "opencode"]);
function runtimeKey(runtime: unknown): string {
  const id = String(runtime ?? "");
  return RUNTIMES.has(id) ? id : "";
}

function roleKey(role: unknown): string {
  const id = String(role ?? "");
  return id === "manager" || id === "reviewer" ? id : "worker";
}

// ---------------------------------------------------------------------------
// Thought bubbles
// ---------------------------------------------------------------------------

export function truncateText(value: unknown, max: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * What floats above a busy character's head.
 *
 * Two sources and no third: the latest line the supervisor produced from the runtime's
 * *visible* stream (an `agent.output` summary — see outputEntries), and the assignment title
 * the human or the manager wrote. Neither is, or can become, private model reasoning: Crew
 * reads no thinking/reasoning channel anywhere, and this function is handed strings, never an
 * agent handle it could ask for more. A bubble is drawn only while the character is actually
 * doing something — an idle or stopped desk is quiet.
 */
export function thoughtFor(
  agent: Pick<CrewAgent, "origin" | "status">,
  assignment: Pick<Assignment, "title"> | null,
  lastOutput: unknown,
): string {
  if (agent.origin !== "managed") return "";
  const status = String(agent.status ?? "");
  if (status !== "working" && status !== "starting") return "";
  const live = truncateText(lastOutput, 52);
  if (live) return live;
  return truncateText(assignment?.title ?? "", 52);
}

/**
 * The latest visible output line for one agent, straight off the same event list the panel
 * transcript is built from — so the bubble can never say something the transcript does not.
 */
export function latestOutput(events: CrewEvent[], agentId: string): string {
  const entries = outputEntries([], events, agentId);
  return entries.length ? entries[entries.length - 1].text : "";
}

// ---------------------------------------------------------------------------
// Sprites → markup
// ---------------------------------------------------------------------------

function svgOpen(cls: string, w: number, h: number, ox = 0, oy = 0): string {
  return `<svg class="px ${cls}" viewBox="${ox} ${oy} ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMax meet">`;
}

/**
 * One desk, drawn back to front: chair, sitter, arms, then the desk itself (which is what
 * hides the sitter's legs), then what stands on the desk.
 *
 * `person` false leaves the chair empty — a stopped agent's desk is still their desk.
 */
export function deskSvg(role: string, runtime: string, person: boolean): string {
  const decor = DECOR[roleKey(role)] ?? DECOR.worker;
  const badge = RUNTIME_BADGE[runtimeKey(runtime)];
  return [
    svgOpen("px-seat-art", 32, 24),
    `<g class="px-chair">${pixelRects(CHAIR, PALETTE, 0, CHAIR_Y)}</g>`,
    person
      ? `<g class="px-person"><g class="px-body">${pixelRects(BODY, PALETTE, 0, BODY_Y)}</g>` +
        `<g class="px-head">${pixelRects(HEAD, PALETTE, 0, HEAD_Y)}</g></g>` +
        `<g class="px-arms">${pixelRects(ARMS, PALETTE, 0, ARMS_Y)}</g>`
      : "",
    `<g class="px-desk">${pixelRects(DESK, PALETTE, 0, DESK_Y)}</g>`,
    `<g class="px-monitor">${pixelRects(MONITOR, PALETTE, 0, MONITOR_Y)}` +
      `<rect class="px-screen" x="${SCREEN.x}" y="${SCREEN.y}" width="${SCREEN.w}" height="${SCREEN.h}"/>` +
      `<g class="px-alert">${pixelRects(ALERT, PALETTE, 19, 10)}</g></g>`,
    `<g class="px-decor">${pixelRects(decor.rows, PALETTE, 0, decor.y)}</g>`,
    badge ? `<g class="px-badge">${pixelRects(badge, PALETTE, BADGE_AT.x, BADGE_AT.y)}</g>` : "",
    "</svg>",
  ].join("");
}

/** An unclaimed desk: same furniture, a plus where a head would be. */
export function hireDeskSvg(role: string): string {
  const decor = DECOR[roleKey(role)] ?? DECOR.worker;
  return [
    svgOpen("px-seat-art", 32, 24),
    `<g class="px-chair">${pixelRects(CHAIR, PALETTE, 0, CHAIR_Y)}</g>`,
    `<g class="px-plus">${pixelRects(HIRE_PLUS, PALETTE, 5, 2)}</g>`,
    `<g class="px-desk">${pixelRects(DESK, PALETTE, 0, DESK_Y)}</g>`,
    `<g class="px-monitor">${pixelRects(MONITOR, PALETTE, 0, MONITOR_Y)}` +
      `<rect class="px-screen" x="${SCREEN.x}" y="${SCREEN.y}" width="${SCREEN.w}" height="${SCREEN.h}"/></g>`,
    `<g class="px-decor">${pixelRects(decor.rows, PALETTE, 0, decor.y)}</g>`,
    "</svg>",
  ].join("");
}

export function ghostSvg(): string {
  return `${svgOpen("px-ghost-art", 12, 14)}${pixelRects(GHOST, PALETTE, 0, 0)}</svg>`;
}

export function cabinetSvg(): string {
  const drawers = DRAWER_ROWS.map(
    (y, i) => `<g class="px-drawer px-drawer-${i}">${pixelRects(CABINET_DRAWER, PALETTE, 2, y)}</g>`,
  ).join("");
  return `${svgOpen("px-cab-art", 20, 28)}${pixelRects(CABINET_BODY, PALETTE, 0, 0)}${drawers}</svg>`;
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/**
 * The bubble is a plain HTML element on top of the SVG, not SVG text: it has to wrap, clip
 * and be readable by a screen reader, and none of that is free inside an <svg>.
 */
export function bubbleHtml(text: string): string {
  const shown = text.trim();
  return `<div class="bubble"${shown ? "" : " hidden"}><span class="bubble-text">${escapeHtml(shown)}</span></div>`;
}

/**
 * The seat's whole meaning, in words. This is what a screen reader reads out for a desk, so
 * it has to carry everything the picture carries: who, what state, which runtime, what role
 * and what they are on. Exported because app.ts rewrites it in place when status changes,
 * rather than rebuilding the seat and restarting its animation.
 */
export function seatAriaLabel(agent: CrewAgent, task: string, now?: number): string {
  const bits = [agent.name, statusLabel(agent.status)];
  const spec = runtimeLabel(agent);
  if (spec) bits.push(spec);
  if (agent.role) bits.push(agent.role);
  if (task) bits.push(`working on ${task}`);
  // The desk plate no longer prints the clock, so the label carries it: a screen-reader user
  // must not lose information the sighted layout dropped for space.
  const elapsed = now === undefined ? "" : elapsedLabel(agent.startedAt, now);
  if (elapsed) bits.push(`up ${elapsed}`);
  return `${bits.join(", ")}. Opens this agent.`;
}

/**
 * A managed agent at a desk.
 *
 * `data-sig` is the part of the seat that changes its *shape* — role, runtime, origin, and
 * whether anyone is in the chair. app.ts rebuilds a seat only when that changes and writes
 * `data-status` in place otherwise, so a ten-second reconciliation does not restart every
 * animation in the room.
 */
export function seatHtml(
  agent: CrewAgent,
  assignment: Assignment | null,
  thought: string,
  now: number,
): string {
  const id = safeId(agent.id);
  const role = roleKey(agent.role);
  const runtime = runtimeKey(agent.runtime);
  const pose = poseFor(agent.status);
  const person = pose !== "empty";
  const task = assignment ? assignment.title : "";
  const elapsed = elapsedLabel(agent.startedAt, now);
  return `<div class="seat" data-slot="agent:${id}" data-sig="${escapeHtml(`${role}|${runtime}|${person}`)}" data-agent="${id}" data-role="${escapeHtml(role)}" data-runtime="${escapeHtml(runtime)}" data-status="${escapeHtml(agent.status)}" data-pose="${escapeHtml(pose)}" data-screen="${escapeHtml(screenFor(agent.status))}" data-hair="${hairFor(agent.id)}">
  ${bubbleHtml(thought)}
  <button type="button" class="desk-btn" data-act="open" data-agent="${id}" aria-label="${escapeHtml(seatAriaLabel(agent, task, now))}">
    ${deskSvg(role, runtime, person)}
    <span class="plate">
      <span class="plate-name">${escapeHtml(agent.name)}</span>
      <span class="plate-meta"><span class="plate-st">${escapeHtml(statusLabel(agent.status))}</span>${runtime ? `<span class="plate-rt">${escapeHtml(runtime)}</span>` : ""}</span>
    </span>
  </button>
</div>`;
}

/**
 * A free desk. `act` is "hire" everywhere except the lead desk with no manager in it, where
 * it is the one-click "start-manager" the whole product is designed around.
 */
export function hireSeatHtml(role: string, act: "hire" | "start-manager", label: string, hint: string): string {
  const key = roleKey(role);
  return `<div class="seat seat-free" data-slot="free:${escapeHtml(key)}:${escapeHtml(act)}" data-sig="free-${escapeHtml(act)}" data-role="${escapeHtml(key)}">
  <button type="button" class="desk-btn desk-free" data-act="${escapeHtml(act)}" data-role="${escapeHtml(key)}" aria-label="${escapeHtml(hint)}">
    ${hireDeskSvg(key)}
    <span class="plate"><span class="plate-name">${escapeHtml(label)}</span><span class="plate-meta"><span class="plate-st">free desk</span></span></span>
  </button>
</div>`;
}

/**
 * Only managed agents get a desk. Observed sessions are never on the floor.
 *
 * Sorted by name and *not* by status, unlike the plain-view columns: a desk that jumps across
 * the room every time its occupant goes idle is disorienting, and it would also force a
 * rebuild of the whole zone (restarting every animation in it) on a status change that the
 * seat can otherwise absorb with one attribute write.
 */
export function zoneAgents(agents: CrewAgent[], zone: ColumnId): CrewAgent[] {
  return agents
    .filter((agent) => agent.origin === "managed" && columnOf(agent) === zone)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export interface ZoneOptions {
  /** False when the daemon has no control endpoints: draw the room, offer no free desks. */
  controls: boolean;
}

const ZONE_FREE: Record<ColumnId, { role: string; label: string; hint: string }> = {
  lead: { role: "manager", label: "Hire a lead", hint: "Hire a manager for the lead desk — opens the profile roster" },
  workers: { role: "worker", label: "Hire", hint: "Hire a worker for this desk — opens the profile roster" },
  review: { role: "reviewer", label: "Hire", hint: "Hire a reviewer for the review corner — opens the profile roster" },
};

/**
 * One zone of the floor, as keyed slots rather than one blob of markup.
 *
 * `key` identifies the seat and `sig` is everything about it that changes its *shape*. app.ts
 * rebuilds a container only when the key/sig list changes and writes status, name and thought
 * onto the surviving nodes otherwise — which is what stops a ten-second reconciliation from
 * restarting every animation in the room.
 */
export interface Slot {
  key: string;
  sig: string;
  html: string;
}

export function zoneSeats(
  zone: ColumnId,
  agents: CrewAgent[],
  assignments: Record<string, Assignment>,
  thoughts: Record<string, string>,
  now: number,
  options: ZoneOptions,
): Slot[] {
  const seated = zoneAgents(agents, zone);
  const slots: Slot[] = seated.map((agent) => {
    const assignment = agent.currentAssignmentId ? (assignments[agent.currentAssignmentId] ?? null) : null;
    const person = poseFor(agent.status) !== "empty";
    return {
      key: `agent:${safeId(agent.id)}`,
      sig: `${roleKey(agent.role)}|${runtimeKey(agent.runtime)}|${person}`,
      html: seatHtml(agent, assignment, thoughts[agent.id] ?? "", now),
    };
  });
  if (options.controls) {
    const free = ZONE_FREE[zone];
    if (zone === "lead") {
      // The lead desk offers the one click the whole product is built around, and only while
      // there is nobody in it — a permanent "start manager" beside a running manager is a trap.
      if (!seated.some((agent) => agent.status !== "stopped")) {
        slots.push({
          key: "free:manager:start-manager",
          sig: "free-start-manager",
          html: hireSeatHtml(
            "manager",
            "start-manager",
            "Start the manager",
            "Start the manager — the one click that gets the crew working",
          ),
        });
      }
    } else {
      slots.push({
        key: `free:${free.role}:hire`,
        sig: "free-hire",
        html: hireSeatHtml(free.role, "hire", free.label, free.hint),
      });
    }
  }
  return slots;
}

export function zoneHtml(
  zone: ColumnId,
  agents: CrewAgent[],
  assignments: Record<string, Assignment>,
  thoughts: Record<string, string>,
  now: number,
  options: ZoneOptions,
): string {
  return zoneSeats(zone, agents, assignments, thoughts, now, options)
    .map((slot) => slot.html)
    .join("\n");
}

/**
 * Observed Docket sessions: outside, behind the window glass.
 *
 * Spec §17 rendered as a picture — Crew did not launch these processes and has no handle on
 * them, so they are not in the room and they carry no control. Not a dimmed button: a
 * <li> with no button and no data-act anywhere inside it, which is what the tests assert.
 */
export function ghostHtml(agent: CrewAgent): string {
  const id = safeId(agent.id);
  const spec = runtimeLabel(agent);
  const label = `${agent.name}, observed Docket session, ${statusLabel(agent.status)}${spec ? `, ${spec}` : ""}. Crew did not launch it and cannot prompt, cancel or stop it.`;
  return `<li class="ghost" data-slot="ghost:${id}" data-status="${escapeHtml(agent.status)}" title="${escapeHtml(label)}">
  <span class="ghost-fig" aria-hidden="true">${ghostSvg()}</span>
  <span class="ghost-name">${escapeHtml(agent.name)}</span>
  <span class="sr-only">${escapeHtml(label)}</span>
</li>`;
}

export function ghostsHtml(agents: CrewAgent[]): string {
  const observed = agents.filter((agent) => agent.origin === "observed");
  if (observed.length === 0) return "";
  return observed
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(ghostHtml)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Docket, drawn as the cabinet it is
// ---------------------------------------------------------------------------

/** Open = still someone's problem. Done/failed/cancelled have left the drawer. */
export function openAssignments(assignments: Assignment[]): number {
  return assignments.filter((a) => {
    const status = String(a.status ?? "");
    return status === "queued" || status === "running" || status === "waiting" || status === "review";
  }).length;
}

/** A count that always renders as a number. "NaN open" on a drawer is a bug the user can see. */
function countOf(value: unknown): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function cabinetLabel(open: number, total: number): string {
  const count = countOf(open);
  return count === 0
    ? `Docket — no open tasks${countOf(total) > 0 ? `, ${countOf(total)} filed` : ""}. Opens the task list.`
    : `Docket — ${count} open task${count === 1 ? "" : "s"}. Opens the task list.`;
}

/**
 * Docket itself as a piece of office furniture — the shared store the whole crew files work
 * into and pulls work out of. The count is the real number of open assignments; the drawer
 * animation is triggered by app.ts from real assignment events, never on a timer.
 */
export function cabinetHtml(open: number, total: number): string {
  const count = countOf(open);
  const label = cabinetLabel(open, total);
  return `<button type="button" class="cabinet" data-act="docket" aria-label="${escapeHtml(label)}">
  ${cabinetSvg()}
  <span class="cab-plate"><span class="cab-name">Docket</span><span class="cab-count" data-empty="${count === 0}">${escapeHtml(String(count))} open</span></span>
</button>`;
}

// ===========================================================================
// The conversation
// ===========================================================================
//
// The Team Feed used to be the event log, printed. That is the wrong object: `init`,
// `started a turn`, `1 message(s) delivered` and `used ToolSearch` are not things anybody
// said, and giving them the same weight as the manager's actual answer buries the one row a
// human came to read.
//
// So the stream is sorted into four channels and only one of them is the conversation:
//
//   say       what a person or an agent actually said. Full text, markdown, never cut.
//   note      one meaningful line worth keeping visible: an assignment moved, a review was
//             asked for, an agent failed. Compact, but not hidden.
//   activity  the mechanics of a turn. Never deleted — folded into one muted line per block
//             that expands to the full detail.
//   system    the daemon coming up and going down.
//
// Everything here is a pure function of (events, messages), so the whole classification is
// testable without a browser — which matters, because "is this row worth the reader's
// attention" is a product decision and product decisions deserve assertions.

export type ChatChannel = "say" | "note" | "activity" | "system";

/**
 * The full, unflattened body an event carried.
 *
 * `summary` is by contract a short one-liner — the daemon flattens whitespace and hard-cuts
 * it (supervisor.ts SUMMARY_MAX) so that compact renderers stay compact. The real text rides
 * in `data`. This is the ONE place that knows which key it rides in, so pointing the
 * conversation at a different field is a one-line change here; the fallback to `summary`
 * keeps every event already sitting in events.jsonl readable.
 */
const BODY_KEYS = ["text", "body", "full", "output", "result", "message"];

/** True when the event carried a real body in `data`, rather than only its short summary. */
export function hasCarriedBody(event: CrewEvent): boolean {
  const data = event.data;
  if (!data) return false;
  return BODY_KEYS.some((key) => typeof data[key] === "string" && String(data[key]).trim() !== "");
}

export function eventBody(event: CrewEvent): string {
  const data = event.data;
  if (data) {
    for (const key of BODY_KEYS) {
      const value = data[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return String(event.summary ?? "");
}

/**
 * What an `agent.output` event actually is.
 *
 * Prefers the daemon's own `data.kind` when it is there, because the runtime knows and this
 * function is guessing. The guess only runs for events emitted before that field existed: a
 * runtime status tick is always one bare token (`init`, `turn.started`), and prose always has
 * whitespace in it — which is a weak rule, and exactly why the declared kind wins.
 */
export function outputKind(event: CrewEvent): "reply" | "tool" | "status" {
  const data = event.data ?? {};
  const declared = typeof data.kind === "string" ? data.kind : "";
  if (declared === "tool") return "tool";
  if (declared === "status") return "status";
  if (declared === "text" || declared === "reply" || declared === "result") return "reply";
  if (typeof data.tool === "string" && data.tool.trim()) return "tool";
  // A carried body is itself the signal: the daemon only ships the full, unflattened text for
  // an actual reply — a tool call and a status tick have nothing to unflatten.
  if (hasCarriedBody(event)) return "reply";
  // Last resort, for events written before any of that existed: a runtime status tick is one
  // bare token ("init", "turn.started"); prose has whitespace in it.
  const text = eventBody(event).trim();
  if (!text) return "status";
  return /^[a-z][a-z0-9._:-]*$/.test(text) ? "status" : "reply";
}

/** `mcp__crew__crew_profiles` → `crew_profiles`. The server prefix is noise in a chat line. */
export function toolLabel(name: unknown): string {
  const raw = String(name ?? "").trim();
  if (!raw) return "a tool";
  const parts = raw.split("__").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : raw;
}

/** An `agent.idle` with nothing to say falls back to this shape; it is a turn ending, not speech. */
const TURN_END = /finished (its|the) turn$/;

const NOTE_TYPES = new Set([
  "assignment.created",
  "assignment.started",
  "assignment.completed",
  "assignment.failed",
  "review.requested",
  "review.completed",
  "agent.failed",
  "agent.spawned",
  "agent.stopped",
]);

const ACTIVITY_TYPES = new Set([
  "agent.started",
  "message.sent",
  "message.delivered",
  "manager.woken",
  "manager.paused",
  // The human's goal is rendered in full from the mailbox; this is its shadow.
  "goal.created",
]);

export function eventChannel(event: CrewEvent): ChatChannel {
  const type = String(event.type ?? "");
  if (type === "crew.started" || type === "crew.stopped") return "system";
  if (type === "agent.output") return outputKind(event) === "reply" ? "say" : "activity";
  if (type === "agent.idle") {
    // The reply is the last `agent.output` with kind:"text" — never this. On the daemon's
    // normal path the orchestrator publishes agent.idle itself with NO `data`, so its
    // `summary` is a flattened 200-char copy of what the agent already said; promoting that
    // to speech would print the answer twice, the second time truncated. Only a supervisor
    // turn that carried a real body in `data` has anything here worth reading.
    if (!hasCarriedBody(event)) return "activity";
    const body = eventBody(event).trim();
    return body && !TURN_END.test(body) ? "say" : "activity";
  }
  if (NOTE_TYPES.has(type)) return "note";
  if (ACTIVITY_TYPES.has(type)) return "activity";
  return "note";
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface ChatItem {
  id: string;
  at: string;
  channel: ChatChannel;
  /** "" for a system line or a note that belongs to nobody in particular. */
  whoId: string;
  who: string;
  /** Display text. For a `say` this is the full markdown source, never truncated. */
  text: string;
  /** Feed dot colour, for notes. */
  kind: ReturnType<typeof feedKind>;
  /** Set on an activity row that was a tool call, so a block can list the tools it used. */
  tool?: string;
  /** True for the human's own messages. */
  human?: boolean;
  /** The daemon clipped this body; `fullLength` is what it was before. */
  truncated?: boolean;
  fullLength?: number;
  /** Which run produced it — the untruncated stream is in logs/<runId>.log. */
  runId?: string;
  /** Display name of who it was addressed to, when that is not obvious. */
  toWho?: string;
  /** True when the human addressed an agent directly rather than going through the manager. */
  direct?: boolean;
}

/**
 * Senders Crew renders as "You" rather than as an agent.
 *
 * This is `naming.ts`'s RESERVED_AGENT_NAMES minus "crew" (which is reserved so no agent can
 * impersonate the daemon, not because it is a human speaker). It is DUPLICATED rather than
 * imported: this module is served to the browser as a raw ES module from dist/office/client/,
 * and the asset route serves nothing outside that directory — a value import of ../../naming.js
 * compiles but 404s in the browser and takes the page down. `render.human-ids.test.ts` asserts
 * this set still agrees with naming.ts, the same drift guard markdown.ts uses for escapeHtml.
 */
export const HUMAN_SPEAKER_IDS: readonly string[] = ["human", "user", "you"];
const HUMAN_IDS = new Set(HUMAN_SPEAKER_IDS);

/**
 * Mirrors naming.ts's agentNameKey. A sender arriving as "ｈｕｍａｎ" or with a zero-width
 * joiner must fold onto the same key as "human", or it renders as a separate speaker whose
 * name reads as the human's — the display half of the spoofing naming.ts blocks at the source.
 */
function speakerKey(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\p{Cf}]/gu, "")
    .trim()
    .toLowerCase();
}

function speaker(agents: Record<string, CrewAgent>, id: unknown): { whoId: string; who: string; human: boolean } {
  const key = String(id ?? "");
  if (!key) return { whoId: "", who: "", human: false };
  if (HUMAN_IDS.has(speakerKey(key))) return { whoId: "human", who: "You", human: true };
  return { whoId: key, who: agents[key]?.name ?? key, human: false };
}

/**
 * The conversation, merged from the two places it actually lives.
 *
 * `CrewState.messages` is the mailbox ledger and carries every body in full and untouched —
 * it is the authoritative source for anything a human or an agent *sent*. The event stream
 * carries everything else, including what an agent said out loud during a turn.
 */
export function chatItems(
  events: CrewEvent[],
  messages: CrewMessage[],
  agents: Record<string, CrewAgent>,
): ChatItem[] {
  const items: ChatItem[] = [];

  for (const message of messages) {
    const from = speaker(agents, message.from);
    const to = speaker(agents, message.to);
    const body = String(message.body ?? "").trim();
    if (!body) continue;
    // Going through the manager is the default and needs no label; going round it is a
    // deliberate act — "ти бро роби те" — and the conversation has to say so.
    const target = agents[to.whoId];
    const direct = from.human && target !== undefined && target.role !== "manager";
    items.push({
      id: `m:${String(message.id ?? "")}`,
      at: String(message.createdAt ?? ""),
      channel: "say",
      whoId: from.whoId,
      who: from.who || "someone",
      text: body,
      kind: message.kind === "help-request" ? "error" : from.human ? "manager" : "worker",
      human: from.human,
      tool: undefined,
      toWho: to.who,
      direct,
    });
  }

  for (const event of events) {
    const channel = eventChannel(event);
    const who = speaker(agents, event.agentId);
    const data = event.data ?? {};
    const tool = typeof data.tool === "string" ? data.tool : undefined;
    const text =
      channel === "say"
        ? eventBody(event)
        : channel === "activity" && tool
          ? `used ${toolLabel(tool)}`
          : String(event.summary ?? String(event.type ?? ""));
    items.push({
      id: `e:${String(event.id ?? "")}`,
      at: String(event.at ?? ""),
      channel,
      whoId: who.whoId,
      who: who.who,
      text: String(text ?? "").trim(),
      kind: feedKind(String(event.type ?? "")),
      tool,
      human: false,
      truncated: data.truncated === true,
      fullLength: typeof data.fullLength === "number" ? data.fullLength : undefined,
      runId: typeof event.runId === "string" ? event.runId : undefined,
    });
  }

  // A stable sort on the timestamp: two events inside the same millisecond keep the order
  // they arrived in, which is the order the daemon published them.
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.at.localeCompare(b.item.at) || a.index - b.index)
    .map((entry) => entry.item);

  // Belt and braces against the same sentence arriving by two doors — a supervisor turn that
  // publishes both the streamed text and a result carrying the same body. The reader should
  // never see an answer twice, and the second copy is always the poorer one.
  const deduped: ChatItem[] = [];
  for (const item of ordered) {
    if (item.channel === "say") {
      const previous = [...deduped].reverse().find((entry) => entry.channel === "say");
      if (previous && previous.whoId === item.whoId && sameSaying(previous.text, item.text)) {
        // Keep whichever copy is longer: a flattened summary must never replace the real text.
        if (item.text.length > previous.text.length) previous.text = item.text;
        continue;
      }
    }
    deduped.push(item);
  }
  return deduped;
}

/**
 * Two bodies are the same saying when one is a flattened, clipped copy of the other — which
 * is exactly the relationship between an event `summary` and its `data.text`.
 */
function sameSaying(a: string, b: string): boolean {
  const flat = (text: string) => text.replace(/\s+/g, " ").replace(/…$/, "").trim();
  const [short, long] = flat(a).length <= flat(b).length ? [flat(a), flat(b)] : [flat(b), flat(a)];
  if (!short) return false;
  return long.startsWith(short);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export interface ChatBlock {
  key: string;
  kind: "human" | "agent" | "note" | "system";
  whoId: string;
  who: string;
  /** Who this block was addressed to, when it was not the manager. */
  toWho: string;
  /** True when the human went straight to an agent. Rendered, because it matters. */
  direct: boolean;
  role: string;
  at: string;
  endAt: string;
  says: ChatItem[];
  notes: ChatItem[];
  acts: ChatItem[];
  /** Rebuild marker: changes whenever anything inside the block changed. */
  sig: string;
}

/** A pause this long means the next thing said starts a new block, even from the same speaker. */
const BLOCK_GAP_MS = 10 * 60 * 1000;

function blockOf(item: ChatItem): "human" | "agent" | "note" | "system" {
  if (item.channel === "system") return "system";
  if (item.channel === "note") return "note";
  return item.human ? "human" : "agent";
}

/**
 * Consecutive rows from one speaker become one block, so a name is printed once per turn
 * instead of once per line — which is most of what made the old feed unreadable.
 */
export function chatBlocks(items: ChatItem[], agents: Record<string, CrewAgent>): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  for (const item of items) {
    const kind = blockOf(item);
    const last = blocks[blocks.length - 1];
    const sameSpeaker =
      last !== undefined &&
      last.kind === kind &&
      (kind === "note" || kind === "system" || last.whoId === item.whoId) &&
      Math.abs(Date.parse(item.at) - Date.parse(last.endAt)) < BLOCK_GAP_MS;

    const target = sameSpeaker
      ? last
      : (() => {
          const agent = agents[item.whoId];
          const fresh: ChatBlock = {
            key: `b:${item.id}`,
            kind,
            whoId: item.whoId,
            who: item.who,
            toWho: "",
            direct: false,
            role: roleKey(agent?.role),
            at: item.at,
            endAt: item.at,
            says: [],
            notes: [],
            acts: [],
            sig: "",
          };
          blocks.push(fresh);
          return fresh;
        })();

    if (item.channel === "say") {
      target.says.push(item);
      if (item.direct && item.toWho) {
        target.direct = true;
        target.toWho = item.toWho;
      }
    }
    else if (item.channel === "note" || item.channel === "system") target.notes.push(item);
    else target.acts.push(item);
    target.endAt = item.at;
    // A block that opened on an activity row and then got a name keeps the better one.
    if (!target.who && item.who) target.who = item.who;
  }
  for (const block of blocks) {
    // The name is part of the signature on purpose. Agents can be renamed mid-session, and a
    // signature that ignored the name would leave the old one on screen until the block
    // happened to change for some other reason.
    block.sig = `${block.says.length}/${block.notes.length}/${block.acts.length}/${block.endAt}/${
      block.says[block.says.length - 1]?.id ?? ""
    }/${block.who}/${block.toWho}`;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/** Who a message can be sent to: the manager (the default) or one managed agent by name. */
export interface AddressTarget {
  id: string;
  name: string;
  role: string;
  manager: boolean;
}

/**
 * Everyone the human can address. The manager is first and is the default, because routing
 * through it is the normal way to work; the rest are there for "ти бро роби те".
 */
export function addressTargets(agents: CrewAgent[]): AddressTarget[] {
  return agents
    .filter((agent) => agent.origin === "managed" && agent.status !== "stopped")
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: roleKey(agent.role),
      manager: agent.role === "manager",
    }))
    .sort(
      (a, b) => Number(b.manager) - Number(a.manager) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
}

/** Loose match so "@backend" finds "backend", "Backend" and "backend #2". */
function nameKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function findTarget(targets: AddressTarget[], needle: unknown): AddressTarget | null {
  const key = nameKey(needle);
  if (!key) return null;
  return (
    targets.find((target) => target.id === String(needle).trim()) ??
    targets.find((target) => nameKey(target.name) === key) ??
    targets.find((target) => nameKey(target.name).startsWith(key)) ??
    null
  );
}

export interface Addressed {
  /** "" means the manager — which is what an empty `to` means to the daemon too. */
  to: string;
  toName: string;
  body: string;
  /** True when an @mention was consumed from the front of the text. */
  mentioned: boolean;
}

/**
 * "@backend rerun the tests" → send "rerun the tests" to backend.
 *
 * Only a mention at the very start counts, and only one that resolves to a real agent —
 * otherwise the text is left exactly as typed. An email address or a stray "@" in the middle
 * of a sentence must never silently redirect a message.
 */
export function parseAddress(text: string, targets: AddressTarget[], fallback = ""): Addressed {
  const raw = String(text ?? "");
  const match = /^\s*@([^\s:,]+)[:,]?\s+([\s\S]*)$/.exec(raw);
  if (match) {
    const found = findTarget(targets, match[1]);
    if (found) {
      return { to: found.manager ? "" : found.id, toName: found.name, body: match[2].trim(), mentioned: true };
    }
  }
  const chosen = fallback ? findTarget(targets, fallback) : null;
  return {
    to: chosen && !chosen.manager ? chosen.id : "",
    toName: chosen?.name ?? "",
    body: raw.trim(),
    mentioned: false,
  };
}

/** The options for the composer's "to" picker. The manager is the default and says so. */
export function targetOptionsHtml(targets: AddressTarget[], selected: string): string {
  const manager = targets.find((target) => target.manager);
  const rows = [
    `<option value=""${selected === "" ? " selected" : ""}>${
      manager ? `${escapeHtml(manager.name)} (manager)` : "the manager"
    }</option>`,
  ];
  for (const target of targets) {
    if (target.manager) continue;
    rows.push(
      `<option value="${escapeHtml(target.id)}"${selected === target.id ? " selected" : ""}>${escapeHtml(
        target.name,
      )} · ${escapeHtml(target.role)}</option>`,
    );
  }
  return rows.join("");
}

// ---------------------------------------------------------------------------
// Blocks → markup
// ---------------------------------------------------------------------------

/** A body this long gets a "show more" rather than a scroll or a cut. */
export const LONG_BODY_CHARS = 700;
export const LONG_BODY_LINES = 14;

export function isLongBody(text: string): boolean {
  const body = String(text ?? "");
  return body.length > LONG_BODY_CHARS || body.split("\n").length > LONG_BODY_LINES;
}

/** Ties a chat line back to the room: the same head that is sitting at that desk. */
export function avatarSvg(): string {
  return `${svgOpen("px-avatar", 10, 9, 4, 3)}${pixelRects(HEAD, PALETTE, 0, HEAD_Y)}</svg>`;
}

/** "12s" / "4m 20s" — how long the mechanics of one block took. */
export function spanLabel(from: unknown, to: unknown): string {
  const start = Date.parse(String(from ?? ""));
  const end = Date.parse(String(to ?? ""));
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
  return elapsedLabel(String(from), end);
}

/**
 * The one muted line that stands for a whole turn's mechanics: which tools were used, how
 * many other steps there were, and how long it took. Nothing is deleted — the button opens
 * every row with its timestamp.
 */
export function activitySummary(acts: ChatItem[]): string {
  if (acts.length === 0) return "";
  const tools: string[] = [];
  for (const act of acts) {
    if (!act.tool) continue;
    const label = toolLabel(act.tool);
    if (!tools.includes(label)) tools.push(label);
  }
  const others = acts.length - acts.filter((act) => act.tool).length;
  const parts: string[] = [];
  if (tools.length) parts.push(`used ${tools.slice(0, 4).join(", ")}${tools.length > 4 ? ` +${tools.length - 4}` : ""}`);
  if (others > 0) parts.push(`${others} step${others === 1 ? "" : "s"}`);
  const span = spanLabel(acts[0].at, acts[acts.length - 1].at);
  if (span && span !== "0s") parts.push(span);
  return parts.join(" · ") || `${acts.length} step${acts.length === 1 ? "" : "s"}`;
}

/**
 * What the collapsed line SAYS, as opposed to what it means.
 *
 * activitySummary() names every tool, which is the right thing for the accessible label and
 * for anyone who opens the fold — but printed in the conversation it is a dense technical
 * string competing with speech for attention. The visible line counts instead of naming:
 * "3 tools · 5 steps · 30s". Nothing is lost; the names are one click away.
 */
export function activityLabel(acts: ChatItem[]): string {
  if (acts.length === 0) return "";
  const tools = new Set<string>();
  for (const act of acts) if (act.tool) tools.add(toolLabel(act.tool));
  const others = acts.length - acts.filter((act) => act.tool).length;
  const parts: string[] = [];
  if (tools.size) parts.push(`${tools.size} tool${tools.size === 1 ? "" : "s"}`);
  if (others > 0) parts.push(`${others} step${others === 1 ? "" : "s"}`);
  const span = spanLabel(acts[0].at, acts[acts.length - 1].at);
  if (span && span !== "0s") parts.push(span);
  return parts.join(" · ") || `${acts.length} step${acts.length === 1 ? "" : "s"}`;
}

/** en-GB grouping, so "12431 characters" reads as a number and not as a token. */
function groupDigits(value: number): string {
  return String(Math.max(0, Math.trunc(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The daemon caps a carried body at 8000 characters. Saying so is not an apology, it is the
 * difference between a prefix and a lie — and it points at the file that still has all of it.
 */
function truncationHtml(item: ChatItem): string {
  if (!item.truncated) return "";
  const shown = groupDigits(item.text.length);
  const total = item.fullLength && item.fullLength > item.text.length ? groupDigits(item.fullLength) : "";
  const where = item.runId ? ` · full stream in logs/${escapeHtml(safeId(item.runId))}.log` : "";
  return `<p class="cm-clipped">the daemon kept the first ${escapeHtml(shown)}${
    total ? ` of ${escapeHtml(total)}` : ""
  } characters${where}</p>`;
}

function sayHtml(item: ChatItem): string {
  const long = isLongBody(item.text);
  // renderMarkdown escapes the whole source before a single rule can match, so every tag in
  // here is one it wrote. The body is a model's output: this is the only thing standing
  // between a "</script><img onerror=…>" in a reply and the page.
  return `<div class="cm-say"${long ? ' data-long="true"' : ""}>
  <div class="md">${renderMarkdown(item.text)}</div>
  ${long ? '<button type="button" class="cm-more" data-act="more" aria-expanded="false">Show more</button>' : ""}
  ${truncationHtml(item)}
</div>`;
}

/**
 * Something that happened, rather than something that was said.
 *
 * Rendered as a centred marker across the column — the shape every chat product uses for
 * "X joined", "Y left" — so it can never be mistaken for a turn. The timestamp moves to the
 * end and goes faint: on a note nobody is reading, the clock is the least interesting field.
 */
function noteHtml(item: ChatItem): string {
  const who = item.who ? `<span class="cn-who">${escapeHtml(item.who)}</span> ` : "";
  return `<li class="cn" data-kind="${escapeHtml(item.kind)}">
  <span class="cn-dot" aria-hidden="true"></span>
  <span class="cn-text">${who}${escapeHtml(item.text)}</span>
  <time class="cn-time">${escapeHtml(formatTime(item.at))}</time>
</li>`;
}

/**
 * The one quiet, expandable line that stands in for a whole turn's mechanics.
 *
 * The visible text counts (activityLabel); the accessible label and the title name the tools
 * (activitySummary), and the fold holds every row with its timestamp. Mechanics sit at the
 * bottom of the visual hierarchy on purpose — ignorable until wanted, never deleted.
 */
function actsHtml(block: ChatBlock): string {
  if (block.acts.length === 0) return "";
  const detail = activitySummary(block.acts);
  return `<div class="cm-acts">
    <button type="button" class="cm-acts-btn" data-act="acts" aria-expanded="false" title="${escapeHtml(detail)}" aria-label="Show what this turn did: ${escapeHtml(detail)}">
      <span class="cm-acts-mark" aria-hidden="true"></span><span class="cm-acts-text">${escapeHtml(activityLabel(block.acts))}</span>
    </button>
    <ol class="cm-acts-list" hidden>${block.acts
      .map((act) => `<li><time>${escapeHtml(formatTime(act.at))}</time><span>${escapeHtml(act.text)}</span></li>`)
      .join("")}</ol>
  </div>`;
}

export function chatBlockHtml(block: ChatBlock): string {
  const key = escapeHtml(block.key);

  // A turn with mechanics but nothing said is not speech, and must not be drawn as a speech
  // container with nothing in it — an empty bubble under a name reads as a bug. It gets the
  // quiet fold instead, with the name beside it when there is one. (Mechanics that belong to
  // nobody at all — a message being queued, the manager being woken — used to be drawn as a
  // block headed "crew", which is a person who does not exist.)
  if (block.kind !== "note" && block.kind !== "system" && block.says.length === 0) {
    const named = block.whoId && block.who ? `<span class="ca-who">${escapeHtml(block.who)}</span>` : "";
    return `<li class="cb cb-acts" data-block="${key}" data-sig="${escapeHtml(block.sig)}">
  ${named}${actsHtml(block)}
</li>`;
  }

  if (block.kind === "note" || block.kind === "system") {
    return `<li class="cb cb-${block.kind}" data-block="${key}" data-sig="${escapeHtml(block.sig)}">
  <ul class="cn-list">${block.notes.map(noteHtml).join("\n")}</ul>
</li>`;
  }

  const acts = actsHtml(block);
  // "You" and a YOU badge next to each other is the same word twice. On the human's own turns
  // the badge IS the name — the turn is already on the other side of the conversation in the
  // accent colour, so nothing else has to say whose it is.
  const human = block.kind === "human";
  const tag = human
    ? '<span class="cm-tag cm-tag-you">you</span>'
    : block.role && block.whoId
      ? `<span class="cm-tag cm-tag-${escapeHtml(block.role)}">${escapeHtml(block.role)}</span>`
      : "";
  const who = human ? "" : `<span class="cm-who">${escapeHtml(block.who || "crew")}</span>`;

  /*
   * Avatar in its own gutter, name over a speech container, mechanics tucked in the container's
   * footer. The avatar is a real element rather than a decoration inside the header line: it is
   * what makes a row read as somebody talking instead of a line of output with a name on it.
   */
  return `<li class="cb cb-msg" data-block="${key}" data-sig="${escapeHtml(block.sig)}" data-kind="${escapeHtml(block.kind)}" data-role="${escapeHtml(block.role)}" data-hair="${hairFor(block.whoId)}">
  <span class="cm-av" aria-hidden="true">${avatarSvg()}</span>
  <div class="cm-col">
    <div class="cm-head">
      ${who}
      ${
        block.direct && block.toWho
          ? `<span class="cm-to" title="Sent straight to this agent, not through the manager">→ ${escapeHtml(block.toWho)}</span>`
          : ""
      }
      ${tag}
      <time class="cm-time">${escapeHtml(formatTime(block.at))}</time>
    </div>
    <div class="cm-bubble">
      <div class="cm-body">
        ${block.says.map(sayHtml).join("\n")}
      </div>
      ${acts}
    </div>
  </div>
</li>`;
}

export function chatHtml(blocks: ChatBlock[]): string {
  if (blocks.length === 0) {
    return '<li class="cb cb-empty">Nothing has been said yet. Tell the team what to do below.</li>';
  }
  return blocks.map(chatBlockHtml).join("\n");
}

// ---------------------------------------------------------------------------
// The live turn indicator
// ---------------------------------------------------------------------------
//
// A turn takes 20–60 seconds. Between pressing Send and the reply landing the conversation
// used to say nothing at all, which reads as "it broke" rather than "it is thinking".
//
// Everything below is derived from what the daemon actually reports, and from nothing else:
//
//   * WHO is working, and whether anyone is, comes from `CrewAgent.status` in /api/state —
//     the same field the desks are drawn from. There is no timer that "runs for N seconds":
//     the moment the daemon says the agent is idle again, the row is gone on the next render.
//   * WHEN the turn started comes from that agent's most recent `agent.started` event, so the
//     elapsed clock counts the turn and not the agent's uptime.
//   * WHAT it is doing comes from the newest `agent.output` line — the same source the desk
//     bubble and the panel transcript use, so the three can never disagree.
//   * HOW IT ENDED comes from the terminal event: `agent.idle` (success — the reply itself is
//     the outcome, so no row), `agent.failed`, or `agent.stopped` (a cancelled run and a
//     stopped agent both arrive as this type; the orchestrator's summary tells them apart).
//
// The one clock in here governs how long a RESOLVED row lingers before the conversation's own
// note carries it alone. It can never hold a spinner up: a spinner exists only while the
// daemon says the agent is working.

export type TurnPhase = "starting" | "working" | "failed" | "cancelled" | "stopped";

export interface TurnIndicator {
  id: string;
  name: string;
  role: string;
  phase: TurnPhase;
  /** ISO of the `agent.started` that opened this turn; "" when the stream never carried one. */
  since: string;
  /** Newest visible output line, trimmed to one row. "" while the agent has said nothing. */
  line: string;
  /** Why the turn ended. "" while it is still running. */
  reason: string;
}

/** How long a failed/cancelled row stays up before the conversation's own note carries it. */
export const TURN_RESOLVE_MS = 12000;

const TURN_END_TYPES = new Set(["agent.idle", "agent.failed", "agent.stopped"]);
/** `cancelAgentRun` publishes agent.stopped with exactly this summary; stopping an agent does not. */
const CANCELLED_RUN = /^cancelled run\b/;

/** A failure summary reads "<name> failed: boom"; the row already prints the name. */
function withoutName(text: string, name: string): string {
  const prefix = `${name} failed: `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

export function turnIndicators(agents: CrewAgent[], events: CrewEvent[], now: number): TurnIndicator[] {
  const managed = agents.filter((agent) => agent.origin === "managed");
  const known = new Set(managed.map((agent) => agent.id));

  // One pass: the last turn-start and the last turn-end per agent. A start clears the end,
  // so an agent that failed and was then woken again is not still wearing its old failure.
  const startedAt: Record<string, string> = {};
  const ended: Record<string, CrewEvent> = {};
  for (const event of events) {
    const id = String(event.agentId ?? "");
    if (!id || !known.has(id)) continue;
    const type = String(event.type ?? "");
    if (type === "agent.started") {
      startedAt[id] = String(event.at ?? "");
      delete ended[id];
    } else if (TURN_END_TYPES.has(type)) {
      ended[id] = event;
    }
  }

  const rows: TurnIndicator[] = [];
  for (const agent of managed) {
    const status = String(agent.status ?? "");
    const role = roleKey(agent.role);

    // Running. Nothing but the daemon's own status puts a spinner on the screen.
    if (status === "working" || status === "starting") {
      rows.push({
        id: agent.id,
        name: agent.name,
        role,
        phase: status as TurnPhase,
        since: startedAt[agent.id] ?? "",
        line: truncateText(latestOutput(events, agent.id), 96),
        reason: "",
      });
      continue;
    }

    // Not running. Only an unhappy ending is worth a row — a successful turn's outcome is the
    // reply, and printing "finished" above it would be the same news twice.
    const end = ended[agent.id];
    if (!end) continue;
    const at = Date.parse(String(end.at ?? ""));
    if (Number.isNaN(at) || now - at > TURN_RESOLVE_MS) continue;
    const type = String(end.type ?? "");
    if (type === "agent.idle") continue;
    const summary = String(end.summary ?? "").trim();
    const phase: TurnPhase =
      type === "agent.failed" ? "failed" : CANCELLED_RUN.test(summary) ? "cancelled" : "stopped";
    rows.push({
      id: agent.id,
      name: agent.name,
      role,
      phase,
      since: "",
      line: "",
      reason: phase === "failed" ? truncateText(withoutName(summary, agent.name), 140) : "",
    });
  }

  // Working agents first, then whatever just ended; stable by name inside each group.
  const rank: Record<TurnPhase, number> = { working: 0, starting: 1, failed: 2, cancelled: 3, stopped: 4 };
  return rows.sort((a, b) => rank[a.phase] - rank[b.phase] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

const PHASE_TEXT: Record<TurnPhase, string> = {
  starting: "starting up",
  working: "working",
  failed: "the turn failed",
  cancelled: "the run was cancelled",
  stopped: "stopped",
};

export function turnPhaseLabel(phase: TurnPhase): string {
  return PHASE_TEXT[phase] ?? "working";
}

/**
 * One row, shaped like the speaker blocks above it — same avatar, same role tint, same hair —
 * so it reads as that agent about to say something rather than as a status bar.
 *
 * `now` is passed in for the same reason it is everywhere else in this file: the row is a pure
 * function of its arguments, and the elapsed label is printed rather than left blank for the
 * first second until app.ts's one-second tick fills it in.
 */
export function turnHtml(turn: TurnIndicator, now: number): string {
  const running = turn.phase === "working" || turn.phase === "starting";
  const detail = turn.reason || turn.line;
  const elapsed = running && turn.since ? elapsedLabel(turn.since, now) : "";
  return `<div class="tw" data-phase="${escapeHtml(turn.phase)}" data-role="${escapeHtml(turn.role)}" data-hair="${hairFor(turn.id)}" data-agent="${safeId(turn.id)}">
  <span class="tw-av" aria-hidden="true">${avatarSvg()}</span>
  <div class="tw-col">
    <div class="tw-head">
      <span class="tw-who">${escapeHtml(turn.name)}</span>
      <span class="tw-state">${escapeHtml(turnPhaseLabel(turn.phase))}</span>
      ${running ? '<span class="tw-dots" aria-hidden="true"><i></i><i></i><i></i></span>' : ""}
      ${
        elapsed || (running && turn.since)
          ? `<span class="tw-since" data-since="${escapeHtml(turn.since)}">${escapeHtml(elapsed)}</span>`
          : ""
      }
    </div>
    ${detail ? `<p class="tw-line">${escapeHtml(detail)}</p>` : ""}
  </div>
</div>`;
}

export function turnsHtml(turns: TurnIndicator[], now: number): string {
  return turns.map((turn) => turnHtml(turn, now)).join("\n");
}

/**
 * What a screen reader is told, and the reason it is a separate string rather than the row's
 * own text: the visible row changes on every streamed output line, and a live region that
 * re-announced each of those would be unusable. This changes only when the *state* changes.
 */
export function turnsAnnouncement(turns: TurnIndicator[]): string {
  if (turns.length === 0) return "";
  const running = turns.filter((turn) => turn.phase === "working" || turn.phase === "starting");
  const parts: string[] = [];
  if (running.length === 1) parts.push(`${running[0].name} is ${turnPhaseLabel(running[0].phase)}.`);
  else if (running.length > 1) parts.push(`${running.map((turn) => turn.name).join(", ")} are working.`);
  for (const turn of turns) {
    if (turn.phase === "working" || turn.phase === "starting") continue;
    parts.push(`${turn.name}: ${turnPhaseLabel(turn.phase)}.`);
  }
  return parts.join(" ");
}
