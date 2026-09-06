/**
 * The Office UI's browser glue: fetch the board, hold the SSE stream open, wire the controls.
 *
 * This module runs in the browser, never in Node. crew/tsconfig.json compiles with
 * `"lib": ["ES2022"]` and no DOM lib (it is a daemon package), so the handful of browser
 * globals used here are declared locally — module-scoped `declare`s, which shadow nothing
 * and are erased at compile. That keeps this file real, type-checked TypeScript instead of
 * a string the compiler cannot see into, without adding a second tsconfig to a file this
 * layer does not own.
 *
 * Everything that produces markup lives in render.ts; this file only decides *when*.
 *
 * Design rule for every control below: `docket crew start` is the last command the user has
 * to type. Once the daemon is up, starting the manager, spawning workers, assigning work,
 * messaging, cancelling, stopping and pausing are all clicks. And every one of them degrades
 * to a *disabled button with a reason* when the daemon doesn't implement the endpoint yet —
 * never a thrown exception, never a button that silently does nothing.
 */

import type { Assignment, CrewAgent, CrewEvent, CrewProfile, CrewState } from "../../types.js";
import {
  addressTargets,
  assignmentsHtml,
  chatBlocks,
  chatHtml,
  chatBlockHtml,
  chatItems,
  boardHtml,
  cabinetHtml,
  cabinetLabel,
  coldStartHtml,
  escapeHtml,
  elapsedLabel,
  feedHtml,
  feedLineHtml,
  ghostsHtml,
  latestOutput,
  openAssignments,
  outputEntries,
  outputHtml,
  parseAddress,
  seedEntries,
  targetOptionsHtml,
  turnIndicators,
  turnsAnnouncement,
  turnsHtml,
  poseFor,
  profilesHtml,
  runtimeLabel,
  safeId,
  screenFor,
  seatAriaLabel,
  statusLabel,
  thoughtFor,
  zoneSeats,
} from "./render.js";
import type { ChatBlock, Slot } from "./render.js";

// --- the browser surface this file uses, and nothing more --------------------------------

interface El {
  innerHTML: string;
  textContent: string | null;
  hidden: boolean;
  value: string;
  disabled: boolean;
  checked: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  dataset: Record<string, string | undefined>;
  className: string;
  open: boolean;
  /** Only `height` is ever written, and only by the composer's autogrow. */
  style: { height: string };
  addEventListener(type: string, handler: (event: UiEvent) => void): void;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  insertAdjacentHTML(position: string, html: string): void;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): El[];
  remove(): void;
  focus(): void;
  scrollIntoView?(options?: unknown): void;
  showModal?(): void;
  close?(): void;
  /** Optional on purpose: an event target is not always an element. */
  closest?(selector: string): El | null;
  matches?(selector: string): boolean;
}

interface UiEvent {
  target: El | null;
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  /**
   * Both halves of the IME guard. `isComposing` is the standard flag; `keyCode === 229` is
   * the older signal some IMEs still send instead, and this user types Ukrainian — sending
   * on the Enter that COMMITS a composition would eat the word being composed.
   */
  isComposing?: boolean;
  keyCode?: number;
  preventDefault(): void;
}

declare const document: {
  documentElement: { dataset: Record<string, string | undefined> };
  body: El;
  hidden: boolean;
  getElementById(id: string): El | null;
  querySelectorAll(selector: string): El[];
  addEventListener(type: string, handler: (event: UiEvent) => void): void;
  readyState: string;
};
declare const localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
declare const location: { reload(): void };
declare const confirm: (message: string) => boolean;
declare const requestAnimationFrame: (callback: () => void) => number;
declare class EventSource {
  constructor(url: string);
  readyState: number;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, handler: (e: { data: string }) => void): void;
  close(): void;
  static readonly CLOSED: number;
}

// --- state --------------------------------------------------------------------------------

const MAX_FEED = 400;

const NO_CONTROL =
  "This daemon doesn't expose Crew's control endpoints yet — the orchestration layer may still be landing.";
const NO_ASSIGN =
  "This daemon has no POST /api/assignments yet, so work can only be handed over through the manager's goal box.";

interface Board {
  state: CrewState | null;
  daemonOk: boolean;
  /** null = not asked yet. [] with `profilesError` set = asked and the daemon said no. */
  profiles: CrewProfile[] | null;
  manager: string;
  profilesError: string;
  /**
   * Whether the frozen control contract exists on this daemon. /api/profiles is the probe:
   * it ships with the rest of the control surface, so a 404 there means every other control
   * would 404 too, and the honest thing is to disable them up front rather than let the user
   * click into a dead end.
   */
  controls: boolean;
  /** Flipped false the first time POST /api/assignments answers 404. */
  assignApi: boolean;
  events: CrewEvent[];
  seen: Set<string>;
  connection: "connecting" | "live" | "down";
  openAgent: string | null;
  /** The output buffer GET /api/agents/:id replayed when the panel opened. */
  openSeed: string[];
  notice: string;
  /** "scene" is the office; "plain" is the same board as a list, for anyone who wants it. */
  view: "scene" | "plain";
  /** Which role the hiring sheet was opened for, so the roster can lead with that role. */
  hireRole: string;
  /** "chat" is the conversation; "log" is the raw event stream, for when you want it. */
  stream: "chat" | "log";
  /** Whether the office band is showing. The chat is the primary surface; this is a choice. */
  office: boolean;
  /** Block signatures currently in the DOM, so only the tail is ever re-rendered. */
  chatSigs: string[];
  /** Who the composer is addressing. "" is the manager, which is the default. */
  target: string;
  /** True while the rename row in the agent panel is open. */
  renaming: boolean;
  /** Flipped false the first time the rename endpoint answers "not found". */
  renameApi: boolean;
}

const board: Board = {
  state: null,
  daemonOk: false,
  profiles: null,
  manager: "",
  profilesError: "",
  controls: true,
  assignApi: true,
  events: [],
  seen: new Set<string>(),
  connection: "connecting",
  openAgent: null,
  openSeed: [],
  notice: "",
  view: "scene",
  hireRole: "worker",
  stream: "chat",
  office: true,
  chatSigs: [],
  target: "",
  renaming: false,
  renameApi: true,
};

function el(id: string): El | null {
  return document.getElementById(id);
}

function agentsMap(): Record<string, CrewAgent> {
  return board.state?.agents ?? {};
}

function agentList(): CrewAgent[] {
  return board.state ? Object.values(board.state.agents) : [];
}

/** A manager is "running" once a managed agent with the manager role exists and isn't stopped. */
function managerAgent(): CrewAgent | null {
  return (
    agentList().find(
      (agent) => agent.origin === "managed" && agent.role === "manager" && agent.status !== "stopped",
    ) ?? null
  );
}

// --- talking to the daemon -----------------------------------------------------------------

/**
 * One request helper for the whole UI, and the only place that knows about the security
 * model: the daemon's guard is the HttpOnly `docket_crew_ui` cookie plus a same-origin check
 * on mutations (crew/src/server.ts). `same-origin` credentials send the first; the browser's
 * own Origin header satisfies the second. There is no token to carry in a body or a header,
 * and inventing one here would be a second, weaker security model beside the real one.
 */
async function api(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const method = init?.method ?? "GET";
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // The built-in 404 is JSON, but a future one might not be.
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Two different things answer 404 here, and confusing them would be a real bug: the daemon's
 * built-in router says exactly `{"error":"not found"}` when no route matched (the endpoint
 * does not exist), while a control route that *did* match answers 404 with its own message
 * for "no agent <id>". Only the first means a capability is missing — treating a stale agent
 * id as a missing endpoint would grey out the entire UI.
 */
function isMissingEndpoint(res: { status: number; body: Record<string, unknown> }): boolean {
  return res.status === 404 && res.body.error === "not found";
}

/**
 * Mutations all report the same way: a toast on success, a specific reason on failure.
 *
 * `okMessage` may be a function of the response body, because "it worked" is not always the
 * same sentence — POST /api/agents/:id/cancel answers `{ok:true, cancelled:false}` when there
 * was nothing running, and telling the user their run was cancelled would be a lie.
 */
async function mutate(
  path: string,
  body?: unknown,
  okMessage?: string | ((body: Record<string, unknown>) => string),
): Promise<boolean> {
  try {
    const res = await api(path, { method: "POST", body: body ?? {} });
    if (res.ok) {
      const message = typeof okMessage === "function" ? okMessage(res.body) : okMessage;
      if (message) notify(message);
      void refreshState();
      return true;
    }
    if (isMissingEndpoint(res)) {
      if (path === "/api/assignments") {
        board.assignApi = false;
        renderAssignForm();
        notify(NO_ASSIGN);
      } else {
        board.controls = false;
        renderAll();
        notify(`${path} isn't available in this daemon yet.`);
      }
    } else if (res.status === 404) {
      notify(String(res.body.error ?? "That agent is no longer on the board."));
      void refreshState();
    } else if (res.status === 403) {
      notify("Rejected by the daemon — reload the page to get a fresh local session.");
    } else {
      notify(String(res.body.error ?? `${path} failed (HTTP ${res.status})`));
    }
  } catch {
    notify("Couldn't reach the crew daemon.");
  }
  return false;
}

async function refreshState(): Promise<void> {
  try {
    const res = await api("/api/state");
    if (!res.ok) {
      board.daemonOk = false;
      board.notice = `The daemon answered HTTP ${res.status} for /api/state.`;
    } else {
      // The SSE backlog is rendered before the first /api/state lands, so those rows were
      // built with no agent map and show ids where names belong. Re-render the feed once,
      // the first time names become available, rather than leaving them wrong forever.
      const first = board.state === null;
      board.state = res.body.state as CrewState;
      board.daemonOk = true;
      board.notice = "";
      // The SSE backlog is rendered before the first /api/state lands, so those blocks were
      // built with no agent map and no mailbox — ids where names belong, and the human's own
      // messages missing entirely. Rebuild once, the first time both become available.
      if (first) {
        board.chatSigs = [];
        if (board.stream === "log") renderFeed();
        // The conversation is built here for the first time with names and the mailbox in
        // hand; land the reader at the newest message rather than at the top of the history.
        firstPaint = true;
      }
    }
  } catch {
    board.daemonOk = false;
    board.notice =
      "The crew daemon isn't answering on this port. Start it with `docket-crew start`, then reload.";
  }
  renderAll();
}

async function refreshProfiles(): Promise<void> {
  try {
    const res = await api("/api/profiles");
    if (res.ok) {
      const list = res.body.profiles;
      board.profiles = Array.isArray(list) ? (list as CrewProfile[]) : [];
      board.manager = typeof res.body.manager === "string" ? res.body.manager : "";
      board.profilesError = "";
      board.controls = true;
    } else {
      board.profiles = [];
      board.controls = false;
      board.profilesError = res.status === 404 ? NO_CONTROL : `/api/profiles answered HTTP ${res.status}.`;
    }
  } catch {
    board.profiles = [];
    board.controls = false;
    board.profilesError = "Couldn't reach the crew daemon.";
  }
  renderAll();
}

// --- the SSE stream -------------------------------------------------------------------------

let stream: EventSource | null = null;
let retryDelay = 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * EventSource reconnects on its own, but only from a *transient* failure — a daemon that was
 * down when the page loaded, or one that closed the socket cleanly, leaves it CLOSED forever.
 * So the reconnect is owned here: a CLOSED stream is torn down and a fresh one scheduled with
 * backoff, and every successful (re)connect re-fetches /api/state.
 *
 * That last part is the reconciliation: the board is derived from state, not from the event
 * log, so a gap in the stream must never leave a stale card on screen. The server replays its
 * recent backlog on every connect and ids already in `board.seen` are dropped, so a reconnect
 * adds no duplicate feed rows either.
 */
function connect(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  try {
    stream?.close();
  } catch {
    // already gone
  }
  board.connection = "connecting";
  renderStatus();

  let source: EventSource;
  try {
    source = new EventSource("/api/events");
  } catch {
    scheduleReconnect();
    return;
  }
  stream = source;

  source.onopen = () => {
    board.connection = "live";
    retryDelay = 1000;
    renderStatus();
    void refreshState();
  };

  source.addEventListener("crew", (message) => {
    let event: CrewEvent;
    try {
      event = JSON.parse(message.data) as CrewEvent;
    } catch {
      return;
    }
    if (!event || typeof event.id !== "string" || board.seen.has(event.id)) return;
    board.seen.add(event.id);
    board.events.push(event);
    if (board.events.length > MAX_FEED) {
      const dropped = board.events.splice(0, board.events.length - MAX_FEED);
      for (const old of dropped) board.seen.delete(old.id);
    }
    if (board.connection !== "live") {
      board.connection = "live";
      renderStatus();
    }
    appendFeedRow(event);
    if (board.openAgent) renderPanelOutput();
    // The cabinet reacts to work moving through Docket, and only to that.
    if (
      event.type === "assignment.created" ||
      event.type === "assignment.started" ||
      event.type === "assignment.completed" ||
      event.type === "assignment.failed"
    ) {
      pulseCabinet(String(event.type));
    }
    // Anything that can move a card is cheap to reconcile against on a loopback socket.
    if (event.type !== "agent.output") void refreshState();
    // An output line changes only what a thought bubble says — no round-trip needed for that.
    else if (board.view === "scene") updateSeats();
  });

  source.onerror = () => {
    // readyState CONNECTING means the browser is already retrying; only take over once it has
    // given up, or the two reconnect loops race each other.
    if (source.readyState === EventSource.CLOSED) scheduleReconnect();
    else {
      board.connection = "connecting";
      renderStatus();
    }
  };
}

function scheduleReconnect(): void {
  board.connection = "down";
  renderStatus();
  if (retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 15000);
}

// --- rendering ---------------------------------------------------------------------------

function renderStatus(): void {
  const dot = el("conn");
  if (!dot) return;
  const text: Record<string, string> = {
    connecting: "connecting…",
    live: "live",
    down: "daemon unreachable — retrying",
  };
  dot.dataset.state = board.connection;
  dot.textContent = text[board.connection] ?? "";
  dot.setAttribute("aria-label", `Crew connection: ${text[board.connection] ?? ""}`);
}

function renderNotice(): void {
  const banner = el("notice");
  if (!banner) return;
  const message =
    board.notice ||
    (board.connection === "down"
      ? "Lost the event stream. The board below is the last state Crew reported."
      : board.controls
        ? ""
        : NO_CONTROL);
  banner.hidden = message === "";
  banner.textContent = message;
}

/** Disable a control and say why, rather than leaving a button that does nothing. */
function setEnabled(node: El | null, enabled: boolean, reason: string): void {
  if (!node) return;
  node.disabled = !enabled;
  if (enabled) {
    node.removeAttribute("title");
    node.removeAttribute("aria-disabled");
  } else {
    node.setAttribute("title", reason);
    node.setAttribute("aria-disabled", "true");
  }
}

function renderHeader(): void {
  const ws = el("workspace");
  if (ws) ws.textContent = board.state?.workspace ?? "—";
  /*
   * One manager control, driven by the manager's state.
   *
   * There used to be three things here — a Start button, a Pause/Resume button and a "manager
   * paused" badge — so a paused, stopped manager showed two competing primary buttons next to
   * a badge that repeated what one of them said. Exactly one action is ever true at a time:
   *
   *   no manager        → Start manager   (primary; the profile it will start is in the title)
   *   running           → Pause manager   (secondary — pausing is not what you came here to do)
   *   running + paused  → Resume manager  (primary, and the label is the paused indicator)
   */
  const paused = board.state?.managerPaused === true;
  const running = managerAgent();
  const action = el("manager-action");
  if (action) {
    const act = running ? "pause" : "start-manager";
    action.dataset.act = act;
    // Primary only when it is the thing to do next: starting a stopped manager, or waking a
    // paused one. Pausing a manager that is working is a secondary act and looks like one.
    action.className = !running || paused ? "btn btn-primary" : "btn";
    action.textContent = running ? (paused ? "Resume manager" : "Pause manager") : "Start manager";
    action.setAttribute(
      "aria-label",
      running
        ? paused
          ? "Resume automatic manager wake-ups"
          : "Pause automatic manager wake-ups"
        : board.manager
          ? `Start the manager, using the ${board.manager} profile`
          : "Start the manager",
    );
    // aria-pressed is a toggle's affordance and only the pause control is one. On the start
    // control the attribute would announce a state that does not exist.
    if (running) action.setAttribute("aria-pressed", paused ? "true" : "false");
    else action.removeAttribute("aria-pressed");
    const reason = board.daemonOk ? NO_CONTROL : "The daemon is not reachable.";
    setEnabled(action, board.controls && board.daemonOk, reason);
    // Which profile it will start belongs in a tooltip, not in the button's face — the label
    // used to read "Start manager (manager-claude)", which is a config value, not an action.
    if (!running && board.manager && !action.disabled) {
      action.setAttribute("title", `profile: ${board.manager}`);
    }
  }
  setEnabled(el("ask-send"), board.controls && board.daemonOk, NO_CONTROL);
}

// --- the office scene ------------------------------------------------------------------------

/**
 * The current assignment for an agent, or null. One helper so the desk, the bubble and the
 * detail panel can never disagree about what somebody is working on.
 */
function assignmentOf(agent: CrewAgent): Assignment | null {
  if (!agent.currentAssignmentId) return null;
  return board.state?.assignments[agent.currentAssignmentId] ?? null;
}

/**
 * What every busy character is thinking, keyed by agent id.
 *
 * The only two sources are the assignment title and the latest `agent.output` summary —
 * exactly what the detail panel's transcript is built from. Crew reads no reasoning channel
 * anywhere, so there is nothing private for a bubble to leak even by accident.
 */
function thoughts(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const agent of agentList()) {
    map[agent.id] = thoughtFor(agent, assignmentOf(agent), latestOutput(board.events, agent.id));
  }
  return map;
}

/**
 * Replace a container's children only when the *shape* of what belongs in it changed.
 *
 * The signature deliberately excludes status, elapsed time and thought text: those are
 * written straight onto the existing nodes by updateSeats(). Without this the ten-second
 * reconciliation poll would rebuild the whole room every ten seconds and restart every
 * animation in it — including a walk-in that would then play forever.
 */
function syncSlots(host: El | null, slots: Slot[]): void {
  if (!host) return;
  const want = slots.map((slot) => `${slot.key}~${slot.sig}`).join(",");
  if (host.dataset.slots === want) return;
  host.innerHTML = slots.map((slot) => slot.html).join("\n");
  host.dataset.slots = want;
  if (!board.controls) {
    for (const node of host.querySelectorAll("[data-act]")) setEnabled(node, false, NO_CONTROL);
  }
}

function zoneSlots(zone: "lead" | "workers" | "review", now: number, thought: Record<string, string>): Slot[] {
  return zoneSeats(zone, agentList(), board.state?.assignments ?? {}, thought, now, {
    controls: board.controls && board.daemonOk,
  });
}

/** Everything about a seat that can change without changing its shape. */
function updateSeats(thought: Record<string, string> = thoughts()): void {
  const bySafeId: Record<string, CrewAgent> = {};
  for (const agent of agentList()) bySafeId[safeId(agent.id)] = agent;

  for (const node of document.querySelectorAll(".seat[data-agent]")) {
    const agent = bySafeId[node.getAttribute("data-agent") ?? ""];
    if (!agent) continue;
    const task = assignmentOf(agent)?.title ?? "";
    node.dataset.status = agent.status;
    node.dataset.pose = poseFor(agent.status);
    node.dataset.screen = screenFor(agent.status);

    const name = node.querySelector(".plate-name");
    if (name && name.textContent !== agent.name) name.textContent = agent.name;
    const status = node.querySelector(".plate-st");
    const statusText = statusLabel(agent.status);
    if (status && status.textContent !== statusText) status.textContent = statusText;
    const button = node.querySelector(".desk-btn");
    if (button) button.setAttribute("aria-label", seatAriaLabel(agent, task, Date.now()));

    const bubble = node.querySelector(".bubble");
    const text = node.querySelector(".bubble-text");
    const line = thought[agent.id] ?? "";
    if (bubble && text) {
      if (text.textContent !== line) text.textContent = line;
      bubble.hidden = line === "";
    }
  }
}

function renderScene(): void {
  const now = Date.now();
  const thought = thoughts();
  syncSlots(el("seats-lead"), zoneSlots("lead", now, thought));
  syncSlots(el("seats-workers"), zoneSlots("workers", now, thought));
  syncSlots(el("seats-review"), zoneSlots("review", now, thought));
  updateSeats(thought);
  renderGhosts();
  renderCabinet();
  renderFloorSign();
}

/**
 * Observed sessions, at the window. Rendered from the same list as the desks and deliberately
 * through a different function, so there is no code path by which one could pick up a control.
 */
function renderGhosts(): void {
  const host = el("ghosts");
  if (!host) return;
  const html = ghostsHtml(agentList());
  if (host.dataset.html !== html) {
    host.innerHTML = html;
    host.dataset.html = html;
  }
  const empty = el("ghosts-empty");
  if (empty) empty.hidden = html !== "";
  const note = el("ghosts-note");
  if (note) note.hidden = html === "";
}

let cabinetTimer: ReturnType<typeof setTimeout> | null = null;

/** The cabinet is built once and then updated in place, so a drawer animation survives. */
function renderCabinet(): void {
  const host = el("cabinet-slot");
  if (!host) return;
  const list: Assignment[] = board.state ? Object.values(board.state.assignments) : [];
  const open = openAssignments(list);
  if (host.dataset.built !== "1") {
    host.innerHTML = cabinetHtml(open, list.length);
    host.dataset.built = "1";
    host.dataset.count = String(open);
    if (!board.controls) {
      for (const node of host.querySelectorAll("[data-act]")) setEnabled(node, false, NO_CONTROL);
    }
    return;
  }
  if (host.dataset.count === String(open)) return;
  host.dataset.count = String(open);
  const count = host.querySelector(".cab-count");
  if (count) {
    count.textContent = `${open} open`;
    count.dataset.empty = open === 0 ? "true" : "false";
  }
  host.querySelector(".cabinet")?.setAttribute("aria-label", cabinetLabel(open, list.length));
}

/**
 * A drawer opens when a task actually moves — created, claimed or finished — and for no other
 * reason. Three drawers, three moments, so the motion says which one happened.
 */
function pulseCabinet(type: string): void {
  const drawer = type === "assignment.created" ? "0" : type === "assignment.started" ? "1" : "2";
  const cabinet = el("cabinet-slot")?.querySelector(".cabinet");
  if (!cabinet) return;
  // Clear first and set on the next tick, so the same drawer firing twice in a row replays
  // instead of the browser deciding nothing changed.
  cabinet.removeAttribute("data-busy");
  if (cabinetTimer !== null) clearTimeout(cabinetTimer);
  setTimeout(() => {
    cabinet.setAttribute("data-busy", drawer);
    cabinetTimer = setTimeout(() => cabinet.removeAttribute("data-busy"), 900);
  }, 20);
}

/** The sign on the office floor: what to do when the room is empty, or why it cannot be used. */
function renderFloorSign(): void {
  const sign = el("floor-sign");
  if (!sign) return;
  const managed = agentList().filter((agent) => agent.origin === "managed");
  let message = "";
  if (!board.daemonOk) {
    message = "";
  } else if (!board.controls) {
    message = board.profilesError || NO_CONTROL;
  } else if (managed.length === 0) {
    message =
      "Nobody has come in yet. Click the lead desk to start the manager — it hires the rest — or click any free desk to put somebody in it yourself.";
  }
  sign.hidden = message === "";
  sign.textContent = message;
}

// --- plain view ------------------------------------------------------------------------------

/** The same board without the drawing. Identical controls, identical data-act hooks. */
function renderPlain(): void {
  const host = el("board");
  const cold = el("cold");
  if (!host) return;
  const state = board.state;
  const agents = agentList();
  const assignments: Record<string, Assignment> = state ? state.assignments : {};

  // Cold start: a running daemon with nobody in the room shows the roster and a launch
  // button per profile, so the first interaction after `docket crew start` is a click.
  const isCold = board.daemonOk && agents.length === 0;
  if (cold) {
    cold.hidden = !isCold;
    if (isCold) {
      cold.innerHTML = coldStartHtml(board.profiles ?? [], board.manager, board.controls, board.profilesError);
    }
  }
  host.hidden = isCold;
  host.innerHTML = isCold ? "" : boardHtml(agents, assignments, Date.now());
  if (!board.controls) {
    for (const node of host.querySelectorAll("[data-act]")) setEnabled(node, false, NO_CONTROL);
  }
}

/**
 * The scene and the list are two renderings of the same board, and only one is in the
 * accessibility tree at a time — `hidden`, not a CSS class, so a screen reader is never told
 * about both. The scene is itself operable: every desk is a real button with a full label,
 * every ghost a labelled list item. The toggle is for preference, not for access.
 */
function applyView(view: string): void {
  board.view = view === "plain" ? "plain" : "scene";
  const stage = el("stage");
  const plain = el("plain");
  if (stage) stage.hidden = board.view === "plain";
  if (plain) plain.hidden = board.view !== "plain";
  const button = el("view-toggle");
  if (button) {
    button.textContent = board.view === "plain" ? "Office view" : "Plain view";
    button.setAttribute("aria-pressed", board.view === "plain" ? "true" : "false");
    button.setAttribute(
      "aria-label",
      board.view === "plain" ? "Switch back to the illustrated office" : "Switch to a plain list of the same board",
    );
  }
  try {
    localStorage.setItem("docket-crew-view", board.view);
  } catch {
    // private mode
  }
  renderBoard();
}

/** Whichever view is showing gets rendered; both stay correct because both read one state. */
function renderBoard(): void {
  if (board.view === "plain") renderPlain();
  else renderScene();
}

function renderAssignments(): void {
  const host = el("assignments");
  if (!host) return;
  const state = board.state;
  const list: Assignment[] = state ? Object.values(state.assignments) : [];
  list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  host.innerHTML = assignmentsHtml(list, agentsMap());
  renderAssignForm();
}

/** The "hand this specific agent a specific piece of work" form. */
function renderAssignForm(): void {
  const picker = el("assign-to");
  if (picker) {
    const options = agentList()
      .filter((agent) => agent.origin === "managed" && agent.status !== "stopped")
      .map(
        (agent) =>
          `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}${agent.role ? ` · ${escapeHtml(agent.role)}` : ""}</option>`,
      )
      .join("");
    const previous = picker.value;
    picker.innerHTML = options || '<option value="">no managed agents yet</option>';
    if (previous) picker.value = previous;
  }
  const usable = board.controls && board.assignApi && board.daemonOk && agentList().some((a) => a.origin === "managed");
  const reason = !board.controls
    ? NO_CONTROL
    : !board.assignApi
      ? NO_ASSIGN
      : "Spawn an agent first — work is assigned to a specific agent.";
  setEnabled(el("assign-send"), usable, reason);
  const hint = el("assign-hint");
  if (hint) {
    hint.hidden = usable;
    hint.textContent = usable ? "" : reason;
  }
}

// --- the conversation -------------------------------------------------------------------

/**
 * Is the reader parked at the bottom, or have they scrolled up to read something?
 *
 * Everything about autoscroll hangs off this: new messages must follow the conversation down
 * when you are watching it live, and must never yank the view when you are not.
 */
function atBottom(host: El, slack = 60): boolean {
  return host.scrollHeight - host.scrollTop - host.clientHeight < slack;
}

function chatHost(): El | null {
  return el("chat-scroll");
}

/** The conversation as blocks, from the mailbox ledger and the event stream together. */
function buildBlocks(): ChatBlock[] {
  const agents = agentsMap();
  const messages = board.state?.messages ?? [];
  return chatBlocks(chatItems(board.events, messages, agents), agents);
}

/**
 * Render only what changed.
 *
 * Blocks are append-mostly, but the *last* one grows as a turn goes on, so a naive
 * innerHTML rewrite would re-run the markdown renderer over the whole conversation on every
 * streamed line and throw away the reader's expanded "show more" state. Instead: find how
 * far the new signature list agrees with what is on screen, drop the nodes past that point,
 * and append the rest.
 */
function renderChat(): void {
  const list = el("chat");
  const scroll = chatHost();
  if (!list || !scroll) return;

  const blocks = buildBlocks();
  const sigs = blocks.map((block) => `${block.key}~${block.sig}`);
  const previous = board.chatSigs;
  let shared = 0;
  while (shared < sigs.length && shared < previous.length && sigs[shared] === previous[shared]) shared++;
  if (shared === sigs.length && sigs.length === previous.length) return;

  const stick = atBottom(scroll) || previous.length === 0;

  if (shared === 0) {
    list.innerHTML = chatHtml(blocks);
  } else {
    const nodes = list.querySelectorAll("[data-block]");
    for (let i = shared; i < nodes.length; i++) nodes[i].remove();
    const tail = blocks.slice(shared).map(chatBlockHtml).join("\n");
    if (tail) list.insertAdjacentHTML("beforeend", tail);
  }
  board.chatSigs = sigs;

  if (stick) scrollChatToEnd();
  // Always recompute the affordance, never only on the branch that did not scroll: getting
  // this wrong once stranded the reader at the top of the conversation with no way back.
  syncJump();
}

/**
 * The live turn indicator, under the last thing said.
 *
 * `turnIndicators` derives the whole thing from /api/state's agent statuses plus the
 * agent.started / agent.output / agent.idle / agent.failed / agent.stopped events already on
 * the stream. Nothing here starts a timer that shows a spinner: a row exists exactly while
 * the daemon says that agent is working, and an ended turn either resolves into its failure
 * row or disappears because its reply is now in the conversation above.
 *
 * The signature deliberately leaves the elapsed clock out — it changes every second, and
 * rebuilding the row for it would restart the dot animation once a second forever. The clock
 * is written onto the surviving node by tickElapsed(), like every other `data-since` on the page.
 */
let turnSig = "";
let turnSaid = "";

function renderTurns(): boolean {
  const host = el("turns");
  if (!host) return false;
  const now = Date.now();
  // The raw log is a different object; it is not a conversation and gets no typing row.
  const turns = board.stream === "chat" ? turnIndicators(agentList(), board.events, now) : [];
  const sig = turns.map((turn) => `${turn.id}|${turn.phase}|${turn.name}|${turn.line}|${turn.reason}`).join(";");

  const say = turnsAnnouncement(turns);
  if (say !== turnSaid) {
    turnSaid = say;
    const live = el("turns-live");
    if (live) live.textContent = say;
  }

  if (sig === turnSig) return false;
  turnSig = sig;
  host.innerHTML = turnsHtml(turns, now);
  host.hidden = turns.length === 0;
  return true;
}

/** Rendering the indicator can add height, so it follows the same stick-to-bottom rule. */
function syncTurns(): void {
  const scroll = chatHost();
  const stick = scroll ? atBottom(scroll) : true;
  if (renderTurns() && stick) scrollChatToEnd();
}

/** Show "jump to latest" exactly when the newest message is off-screen below. */
function syncJump(): void {
  const scroll = chatHost();
  if (!scroll) return;
  showJump(board.stream === "chat" && !atBottom(scroll, 80));
}

function scrollChatToEnd(): void {
  const scroll = chatHost();
  if (!scroll) return;
  scroll.scrollTop = scroll.scrollHeight;
  // Twice more, after layout and after paint. A block appended in this same tick has not been
  // measured yet, so the first assignment lands short; and a body whose markdown is still
  // reflowing grows under the scroll after that. Both left the newest message half-cut.
  requestAnimationFrame(() => {
    const first = chatHost();
    if (first) first.scrollTop = first.scrollHeight;
    requestAnimationFrame(() => {
      const second = chatHost();
      if (second) second.scrollTop = second.scrollHeight;
      syncJump();
    });
  });
  showJump(false);
}

function showJump(show: boolean): void {
  const jump = el("jump");
  if (jump) jump.hidden = !show || board.stream !== "chat";
}

/** The raw stream, unchanged — the escape hatch when you want the log itself. */
function renderFeed(): void {
  const host = el("feed");
  if (!host) return;
  host.innerHTML = feedHtml(board.events, agentsMap());
}

/**
 * A new event touches the conversation and, when the raw log is showing, that too. Appending
 * beats re-rendering for the log; the conversation does its own tail diff.
 */
function appendFeedRow(event: CrewEvent): void {
  const host = el("feed");
  if (host && board.stream === "log") {
    const scroll = chatHost();
    const stuck = scroll ? atBottom(scroll) : true;
    if (host.querySelector(".empty")) host.innerHTML = "";
    host.insertAdjacentHTML("beforeend", feedLineHtml(event, agentsMap()));
    while (host.querySelectorAll(".fd-row").length > MAX_FEED) host.querySelector(".fd-row")?.remove();
    if (stuck) scrollChatToEnd();
  }
  renderChat();
  // Every event can move the indicator: agent.output changes the line it shows, and the
  // turn-end events are what resolve it. This is the only path an agent.output takes — those
  // deliberately skip the /api/state round trip — so the indicator must be synced from here.
  syncTurns();
}

/** Conversation or raw log. Only one is in the accessibility tree at a time. */
function applyStream(stream: string): void {
  board.stream = stream === "log" ? "log" : "chat";
  const list = el("chat");
  const feed = el("feed");
  if (list) list.hidden = board.stream === "log";
  if (feed) feed.hidden = board.stream !== "log";
  const button = el("log-toggle");
  if (button) {
    button.textContent = board.stream === "log" ? "Conversation" : "Raw log";
    button.setAttribute("aria-pressed", board.stream === "log" ? "true" : "false");
    button.setAttribute(
      "aria-label",
      board.stream === "log" ? "Back to the conversation" : "Show the raw event stream instead",
    );
  }
  try {
    localStorage.setItem("docket-crew-stream", board.stream);
  } catch {
    // private mode
  }
  if (board.stream === "log") renderFeed();
  else renderChat();
  renderTurns();
  scrollChatToEnd();
}

/** Give the conversation the whole window, or put the office back. */
function applyOffice(shown: boolean): void {
  board.office = shown;
  const stage = el("stage");
  if (stage) stage.dataset.collapsed = shown ? "false" : "true";
  const button = el("office-toggle");
  if (button) {
    button.textContent = shown ? "Hide office" : "Show office";
    button.setAttribute("aria-pressed", shown ? "true" : "false");
    button.setAttribute("aria-label", shown ? "Hide the office scene" : "Show the office scene");
  }
  try {
    localStorage.setItem("docket-crew-office", shown ? "1" : "0");
  } catch {
    // private mode
  }
  if (shown && board.view === "scene") renderScene();
}

const NO_RENAME = "This daemon has no rename endpoint yet, so agents keep the names they were given.";

/**
 * The composer's "to" picker.
 *
 * Empty means the manager — which is both the default and exactly what an absent `to` means
 * to the daemon, so the everyday path sends the identical request it always did.
 */
function renderTargets(): void {
  const picker = el("ask-target");
  if (!picker) return;
  const targets = addressTargets(agentList());
  // A target that has gone away falls back to the manager rather than addressing a ghost.
  if (board.target && !targets.some((target) => target.id === board.target)) board.target = "";
  const html = targetOptionsHtml(targets, board.target);
  if (picker.dataset.html !== html) {
    picker.innerHTML = html;
    picker.dataset.html = html;
  }
  picker.value = board.target;
  setEnabled(picker, board.controls && board.daemonOk, NO_CONTROL);
  renderDirectHint();
}

const ASK_PLACEHOLDER = "Message the team…  (@name to address someone directly)";

/**
 * Saying it out loud, in four places at once: this one is not going through the manager.
 *
 * A `to` selector that looks like a form field is not enough — bypassing the manager is a
 * decision with consequences (its plan goes stale) and it has to be obvious BEFORE the send,
 * not only afterwards in the transcript. So the whole composer changes state: the shell is
 * repainted through `data-direct`, the pill names the agent, the placeholder addresses them
 * by name, and the send button says where it is sending.
 *
 * Every one of those writes a *property* (textContent / setAttribute), never markup, so a
 * hostile self-reported name cannot become an element — and there is no second sanitising
 * path here: the name is displayed exactly as the daemon handed it over.
 */
function renderDirectHint(): void {
  const targets = addressTargets(agentList());
  const chosen = targets.find((target) => target.id === board.target);
  const direct = chosen !== undefined && !chosen.manager;
  const name = chosen?.name ?? "";

  el("ask-wrap")?.setAttribute("data-direct", direct ? "true" : "false");

  const hint = el("ask-direct");
  if (hint) {
    hint.hidden = !direct;
    if (direct) hint.textContent = `direct — ${name} only, the manager is not involved`;
  }

  const box = el("ask");
  if (box) box.setAttribute("placeholder", direct ? `Message ${name} directly…` : ASK_PLACEHOLDER);

  const send = el("ask-send");
  if (send) {
    send.textContent = direct ? "Send direct" : "Send";
    send.setAttribute(
      "aria-label",
      direct ? `Send straight to ${name}, bypassing the manager` : "Send to the manager",
    );
  }
}

// --- the composer's size --------------------------------------------------------------------

/**
 * The composer's resting height, and the ceiling it grows to.
 *
 * 60px is exactly two lines of the 14px/1.55 body face plus its padding, and it is measured
 * rather than chosen: at the old 38px the box was one line, everything past it was hidden
 * behind an invisible scroll, and the pane reflowed the moment a second line appeared. At 60
 * the first AND second line cost nothing — the composer does not move at all for the message
 * most people actually type. 190px is eight lines; past that the composer would be eating the
 * conversation it belongs to, so it stops there and scrolls inside itself.
 *
 * Between the two it grows in whole line steps and never shrinks below the resting height, so
 * the pane below moves once per line and never on a keystroke.
 */
const ASK_MIN_H = 60;
const ASK_MAX_H = 190;

function autoGrow(node: El | null): void {
  if (!node) return;
  // Measure against the content, not against whatever height was set last time: without this
  // the box can grow but never shrink back when the text is deleted.
  node.style.height = "auto";
  const wanted = node.scrollHeight;
  node.style.height = `${Math.min(ASK_MAX_H, Math.max(ASK_MIN_H, wanted))}px`;
  // Only a box that has hit the ceiling gets a scrollbar; below it there is nothing to scroll
  // and the bar would be a permanent flicker on the right edge.
  node.dataset.full = wanted > ASK_MAX_H ? "true" : "false";
}

function renderProfiles(): void {
  const host = el("profiles");
  if (!host) return;
  if (board.profiles === null) {
    host.innerHTML = '<p class="empty">Loading profiles…</p>';
    return;
  }
  const ordered = [...board.profiles].sort(
    (a, b) =>
      Number(b.role === board.hireRole) - Number(a.role === board.hireRole) ||
      Number(b.name === board.manager) - Number(a.name === board.manager) ||
      a.name.localeCompare(b.name),
  );
  host.innerHTML = board.profilesError
    ? `<p class="warn">${escapeHtml(board.profilesError)}</p>`
    : profilesHtml(ordered, board.manager);
  if (!board.controls) {
    for (const node of host.querySelectorAll("[data-act]")) setEnabled(node, false, NO_CONTROL);
  }
}

function renderPanelOutput(): void {
  const host = el("panel-output");
  if (!host || !board.openAgent) return;
  const stuck = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
  host.innerHTML = outputHtml(outputEntries(board.openSeed, board.events, board.openAgent));
  if (stuck) host.scrollTop = host.scrollHeight;
}

function renderPanel(): void {
  const panel = el("agent-panel");
  if (!panel || !board.openAgent) return;
  const agent = agentsMap()[board.openAgent];
  if (!agent) {
    closePanel();
    return;
  }
  const observed = agent.origin === "observed";
  const title = el("panel-title");
  if (title) title.textContent = agent.name;

  const meta = el("panel-meta");
  if (meta) {
    const assignment = agent.currentAssignmentId ? board.state?.assignments[agent.currentAssignmentId] : undefined;
    const rows: string[] = [
      `<span class="pill st-${escapeHtml(agent.status)}">${escapeHtml(statusLabel(agent.status))}</span>`,
      `<span class="tag ${observed ? "tag-observed" : "tag-managed"}">${escapeHtml(agent.origin)}</span>`,
    ];
    const spec = runtimeLabel(agent);
    if (spec) rows.push(`<span class="faint">${escapeHtml(spec)}</span>`);
    if (agent.startedAt) {
      rows.push(`<span class="faint" data-since="${escapeHtml(agent.startedAt)}">${escapeHtml(elapsedLabel(agent.startedAt, Date.now()))}</span>`);
    }
    if (agent.nativeSessionId) {
      rows.push(`<span class="mono faint" title="Native runtime session id">${escapeHtml(agent.nativeSessionId)}</span>`);
    }
    if (agent.cwd) rows.push(`<span class="mono faint">${escapeHtml(agent.cwd)}</span>`);
    meta.innerHTML = rows.join("");
    const task = el("panel-task");
    if (task) {
      task.innerHTML = assignment
        ? `<span class="k">current assignment</span> <strong>${escapeHtml(assignment.title)}</strong> <span class="pill as-${escapeHtml(assignment.status)}">${escapeHtml(assignment.status)}</span>` +
          (assignment.docketTodoId ? ` <span class="asg-docket">${escapeHtml(assignment.docketTodoId)}</span>` : "")
        : '<span class="faint">no current assignment</span>';
    }
  }

  // Renaming is a control like any other: Crew names what Crew launched, and an observed
  // session is not that. The button is absent, not disabled.
  const rename = el("panel-rename");
  if (rename) {
    rename.hidden = observed || !board.renameApi;
    setEnabled(rename, board.controls, NO_CONTROL);
  }
  if (observed && board.renaming) toggleRename(false);

  // Observed sessions never get a control strip — spec §17. Crew did not launch them and
  // must not draw anything that implies it can prompt, cancel or kill them.
  const controls = el("panel-controls");
  if (controls) controls.hidden = observed;
  const readonly = el("panel-readonly");
  if (readonly) readonly.hidden = !observed;
  if (!observed && controls) {
    for (const node of controls.querySelectorAll("[data-act]")) {
      setEnabled(node, board.controls, NO_CONTROL);
    }
    setEnabled(el("panel-message"), board.controls, NO_CONTROL);
  }
  renderPanelOutput();
}

/** Set once, the first time /api/state lands, so the opening view is the newest message. */
let firstPaint = false;

function renderAll(): void {
  renderHeader();
  renderNotice();
  renderTargets();
  renderChat();
  syncTurns();
  if (firstPaint) {
    firstPaint = false;
    scrollChatToEnd();
  }
  renderBoard();
  renderAssignments();
  renderProfiles();
  if (board.openAgent) renderPanel();
}

/** The one thing that must move without a server round-trip. */
function tickElapsed(): void {
  const now = Date.now();
  for (const node of document.querySelectorAll("[data-since]")) {
    node.textContent = elapsedLabel(node.dataset.since, now);
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function notify(message: string): void {
  const toast = el("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.show = "true";
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.dataset.show = "false";
  }, 5000);
}

// --- panel ---------------------------------------------------------------------------------

/**
 * The SSE buffer only holds what happened since the page loaded, so the panel seeds itself
 * from GET /api/agents/:id — the daemon's own recent-output ring for that agent — and lets
 * the live stream take over from there. A daemon without that route simply shows the live
 * tail; it is never an error the user has to see.
 */
function openPanel(agentId: string): void {
  if (!agentsMap()[agentId]) return;
  board.openAgent = agentId;
  board.openSeed = [];
  board.renaming = false;
  renderPanel();
  toggleRename(false);
  el("agent-panel")?.showModal?.();
  void api(`/api/agents/${encodeURIComponent(agentId)}`).then(
    (res) => {
      if (board.openAgent !== agentId || !res.ok) return;
      // Prefer the daemon's full-fidelity entries; fall back to the legacy summary lines.
      board.openSeed = seedEntries(res.body).map((entry) => `${entry.at} ${entry.text}`);
      renderPanelOutput();
    },
    () => undefined,
  );
}

function closePanel(): void {
  toggleRename(false);
  board.openAgent = null;
  board.openSeed = [];
  el("agent-panel")?.close?.();
}

/** The cabinet's drawer: Docket's task list, and the form that files a new one. */
function openDocket(): void {
  renderAssignments();
  el("docket-panel")?.showModal?.();
}

/** A free desk: who should sit here. */
function openHire(role: string): void {
  board.hireRole = role || "worker";
  const note = el("hire-note");
  if (note) {
    note.textContent =
      board.hireRole === "manager"
        ? "The lead desk. A manager profile plans and hands work out; it starts immediately."
        : board.hireRole === "reviewer"
          ? "The review corner. Pick a profile — it starts immediately and walks in."
          : "Pick a profile. It starts immediately and walks in.";
  }
  renderProfiles();
  el("hire-panel")?.showModal?.();
}

// --- actions ---------------------------------------------------------------------------------

async function spawn(profile: string): Promise<void> {
  if (!profile) return;
  notify(`Spawning ${profile}…`);
  const res = await api("/api/agents/spawn", { method: "POST", body: { profile } }).catch(() => null);
  if (!res) return notify("Couldn't reach the crew daemon.");
  if (!res.ok) {
    if (isMissingEndpoint(res)) {
      board.controls = false;
      renderAll();
    }
    return notify(String(res.body.error ?? `Spawn failed (HTTP ${res.status}).`));
  }
  // Optimistic: draw the new card now rather than waiting for the SSE round-trip, then let
  // the authoritative /api/state overwrite it a moment later.
  const agent = res.body.agent as CrewAgent | undefined;
  if (agent && agent.id && board.state) {
    board.state.agents[agent.id] = agent;
    renderAll();
  }
  notify(`${agent?.name ?? profile} is starting.`);
  void refreshState();
}

/**
 * `POST /api/manager/start` rather than spawning the manager profile by hand: it is
 * idempotent on the daemon side and returns the existing manager instead of standing up a
 * second one, which two clicks on a slow machine would otherwise do.
 */
async function startManager(): Promise<void> {
  const res = await api("/api/manager/start", { method: "POST", body: {} }).catch(() => null);
  if (!res) return notify("Couldn't reach the crew daemon.");
  if (!res.ok) {
    if (isMissingEndpoint(res)) {
      // An older daemon without the convenience route: spawn the configured profile instead.
      if (board.manager) return void spawn(board.manager);
      board.controls = false;
      renderAll();
    }
    return notify(String(res.body.error ?? `Couldn't start the manager (HTTP ${res.status}).`));
  }
  const agent = res.body.agent as CrewAgent | undefined;
  if (agent?.id && board.state) {
    board.state.agents[agent.id] = agent;
    renderAll();
  }
  notify(res.body.created === false ? "The manager is already running." : `${agent?.name ?? "Manager"} is starting.`);
  void refreshState();
}

/**
 * Send what is in the composer to whoever it is addressed to.
 *
 * Addressing is resolved from two places that must agree: an "@name" at the front of the
 * text, which wins because it is the most recent thing the human typed, and the picker
 * otherwise. No target at all means the manager, and that case sends the byte-identical
 * request it always sent — `POST /api/ask {goal}` with no `to`.
 *
 * A direct target goes to `POST /api/agents/:id/message`. This used to be forced: `/api/ask`
 * once accepted an unknown `to`, ignored it and answered 200, so "@backend do X" reached the
 * MANAGER while this UI reported it had gone to backend. That hole is closed — `/api/ask`
 * now resolves `to` (404 unknown, 409 ambiguous/observed) and returns `deliveredTo` on every
 * 200 — and both routes hand a worker message to the SAME `Orchestrator.directMessage`, so
 * they take the same mailbox rule and send the manager the same "your plan may be stale" note.
 *
 * The split therefore stays only because it is honest, not because it is required: this route
 * has always meant exactly "hand this to that agent". Either would now be correct; switching
 * buys nothing, so it has not been switched.
 */
async function submitGoal(): Promise<void> {
  const input = el("ask");
  const raw = input?.value ?? "";
  if (!raw.trim()) return;
  const targets = addressTargets(agentList());
  const addressed = parseAddress(raw, targets, board.target);
  if (!addressed.body) return;

  const button = el("ask-send");
  if (button) button.disabled = true;
  let ok = false;
  if (!addressed.to) {
    ok = await mutate("/api/ask", { goal: addressed.body }, "Sent to the manager.");
  } else {
    const name = addressed.toName || "that agent";
    ok = await mutate(
      `/api/agents/${encodeURIComponent(addressed.to)}/message`,
      { body: addressed.body },
      `Sent straight to ${name}.`,
    );
  }
  if (button) button.disabled = false;
  if (ok && input) {
    input.value = "";
    // Emptying the box does not fire `input`, so the height would stay at whatever the sent
    // message grew it to — a composer stuck four lines tall with nothing in it.
    autoGrow(input);
  }
  // An @mention is a one-off; the picker keeps whatever the human chose deliberately.
  if (ok && addressed.mentioned) renderTargets();
  input?.focus();
}

// ---- renaming ------------------------------------------------------------------------------

/** Open or close the rename row. Never offered for an observed session — Crew did not name it. */
function toggleRename(open: boolean): void {
  const agent = board.openAgent ? agentsMap()[board.openAgent] : undefined;
  board.renaming = open && !!agent && agent.origin === "managed" && board.controls;
  const row = el("rename-row");
  const input = el("rename-input");
  if (row) row.hidden = !board.renaming;
  if (board.renaming && input) {
    input.value = agent?.name ?? "";
    input.focus();
  }
}

async function saveRename(): Promise<void> {
  const agentId = board.openAgent ?? "";
  const name = (el("rename-input")?.value ?? "").trim();
  const agent = agentsMap()[agentId];
  if (!agentId || !agent) return;
  if (!name) return notify("A name cannot be empty.");
  if (name === agent.name) return toggleRename(false);

  const res = await api(`/api/agents/${encodeURIComponent(agentId)}/rename`, {
    method: "POST",
    body: { name },
  }).catch(() => null);
  if (!res) return notify("Couldn't reach the crew daemon.");
  if (res.ok) {
    // Paint it now; /api/state confirms a moment later. Every renderer resolves names at
    // render time, so the whole page — desks, conversation, pickers — follows.
    if (board.state?.agents[agentId]) board.state.agents[agentId].name = name;
    board.chatSigs = [];
    toggleRename(false);
    notify(`Renamed to ${name}.`);
    renderAll();
    void refreshState();
    return;
  }
  if (isMissingEndpoint(res)) {
    board.renameApi = false;
    toggleRename(false);
    renderPanel();
    return notify(NO_RENAME);
  }
  // 409 for a duplicate name or an observed session; 400 for a name the daemon rejects.
  notify(String(res.body.error ?? `Rename failed (HTTP ${res.status}).`));
}

async function submitAssignment(): Promise<void> {
  const title = (el("assign-title")?.value ?? "").trim();
  const instructions = (el("assign-body")?.value ?? "").trim();
  const assignedTo = el("assign-to")?.value ?? "";
  const docketTodoId = (el("assign-docket")?.value ?? "").trim();
  const isolate = el("assign-isolate")?.checked === true;
  if (!title || !assignedTo) {
    notify("An assignment needs a title and an assignee.");
    return;
  }
  const ok = await mutate(
    "/api/assignments",
    {
      title,
      instructions: instructions || title,
      assignedTo,
      isolate,
      docketTodoId: docketTodoId || undefined,
    },
    `Assigned "${title}".`,
  );
  if (!ok) return;
  const titleBox = el("assign-title");
  const bodyBox = el("assign-body");
  const docketBox = el("assign-docket");
  if (titleBox) titleBox.value = "";
  if (bodyBox) bodyBox.value = "";
  if (docketBox) docketBox.value = "";
}

async function sendAgentMessage(agentId: string, input: El | null): Promise<void> {
  const body = (input?.value ?? "").trim();
  if (!agentId || !body) return;
  const ok = await mutate(`/api/agents/${encodeURIComponent(agentId)}/message`, { body }, "Message delivered.");
  if (ok && input) input.value = "";
}

// --- wiring ---------------------------------------------------------------------------------

function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  try {
    localStorage.setItem("docket-theme", theme);
  } catch {
    // private mode
  }
}

function init(): void {
  let stored: string | null = null;
  let storedView: string | null = null;
  let storedStream: string | null = null;
  let storedOffice: string | null = null;
  try {
    stored = localStorage.getItem("docket-theme");
    storedView = localStorage.getItem("docket-crew-view");
    storedStream = localStorage.getItem("docket-crew-stream");
    storedOffice = localStorage.getItem("docket-crew-office");
  } catch {
    // private mode
  }
  applyTheme(stored === "light" ? "light" : "dark");
  applyView(storedView === "plain" ? "plain" : "scene");
  applyStream(storedStream === "log" ? "log" : "chat");
  applyOffice(storedOffice !== "0");

  // A room full of looping keyframes in a tab nobody is looking at is pure waste. One
  // attribute pauses every animation in the scene; the browser does the rest.
  const setIdle = () => {
    document.body.dataset.idle = document.hidden ? "true" : "false";
  };
  setIdle();
  document.addEventListener("visibilitychange", setIdle);

  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-act]");
    if (!button || button.disabled) return;
    const act = button.getAttribute("data-act") ?? "";
    const agentId = button.getAttribute("data-agent") ?? board.openAgent ?? "";

    switch (act) {
      case "theme":
        applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
        return;
      case "view":
        applyView(board.view === "plain" ? "scene" : "plain");
        return;
      case "log":
        applyStream(board.stream === "log" ? "chat" : "log");
        return;
      case "office":
        applyOffice(!board.office);
        return;
      case "jump":
        scrollChatToEnd();
        return;
      case "rename":
        toggleRename(!board.renaming);
        return;
      case "rename-save":
        void saveRename();
        return;
      case "rename-cancel":
        toggleRename(false);
        return;
      case "acts": {
        // Nothing is deleted, only folded: this is the fold opening.
        const wrap = button.closest?.(".cm-acts");
        const list = wrap?.querySelector(".cm-acts-list");
        if (!list) return;
        const open = list.hidden;
        list.hidden = !open;
        button.setAttribute("aria-expanded", open ? "true" : "false");
        return;
      }
      case "more": {
        const say = button.closest?.(".cm-say");
        if (!say) return;
        const open = say.dataset.open !== "true";
        say.dataset.open = open ? "true" : "false";
        button.textContent = open ? "Show less" : "Show more";
        button.setAttribute("aria-expanded", open ? "true" : "false");
        return;
      }
      case "open":
        return openPanel(agentId);
      case "close-panel":
        return closePanel();
      case "docket":
        return openDocket();
      case "close-docket":
        el("docket-panel")?.close?.();
        return;
      case "hire":
        return openHire(button.getAttribute("data-role") ?? "worker");
      case "close-hire":
        el("hire-panel")?.close?.();
        return;
      case "message":
        openPanel(agentId);
        el("panel-message")?.focus();
        return;
      case "send-message":
        void sendAgentMessage(agentId, el("panel-message"));
        return;
      case "cancel":
        if (!agentId) return;
        if (!confirm(`Cancel the current run of ${agentsMap()[agentId]?.name ?? agentId}?`)) return;
        void mutate(`/api/agents/${encodeURIComponent(agentId)}/cancel`, {}, (result) =>
          result.cancelled === false ? "Nothing was running — there was no turn to cancel." : "Run cancelled.",
        );
        return;
      case "stop":
        if (!agentId) return;
        if (!confirm(`Stop ${agentsMap()[agentId]?.name ?? agentId}? Its process is shut down and the agent leaves the board.`))
          return;
        void mutate(`/api/agents/${encodeURIComponent(agentId)}/stop`, {}, "Stop requested.").then(() => closePanel());
        return;
      case "spawn":
        void spawn(button.getAttribute("data-profile") ?? "");
        return;
      case "start-manager":
        void startManager();
        return;
      case "pause": {
        const paused = board.state?.managerPaused === true;
        void mutate(
          paused ? "/api/manager/resume" : "/api/manager/pause",
          {},
          paused ? "Manager resumed — auto-wake is on." : "Manager paused — auto-wake is off.",
        );
        return;
      }
      case "ask":
        void submitGoal();
        return;
      case "assign":
        void submitAssignment();
        return;
      case "reload":
        location.reload();
        return;
      default:
        return;
    }
  });

  /*
   * Enter sends. Shift+Enter is the newline.
   *
   * That is the shape every chat has, and it is what this is: a conversation, not a form. The
   * old Cmd/Ctrl+Enter is kept as a harmless alias because muscle memory exists and nothing
   * else wants that chord.
   *
   * The IME guard is the reason this is not a one-liner. While an input method is composing —
   * Ukrainian, Japanese, anything with a candidate window — Enter is how you COMMIT the word,
   * and a send bound to it swallows the word instead of typing it. `isComposing` is the
   * standard signal and `keyCode === 229` is what some IMEs send in its place; both must be
   * checked, and when either is true this handler does nothing at all and lets the IME have
   * its key back.
   */
  document.addEventListener("keydown", (event) => {
    const focus = event.target;
    const composing = event.isComposing === true || event.keyCode === 229;

    // A one-line name box submits on plain Enter, and it is not a composer.
    if (event.key === "Enter" && !composing && focus?.matches?.("#rename-input")) {
      event.preventDefault();
      void saveRename();
      return;
    }
    if (event.key === "Escape" && board.renaming) {
      toggleRename(false);
      return;
    }
    if (event.key !== "Enter" || composing || !focus) return;

    // Shift+Enter is the newline, so it must reach the textarea untouched.
    if (event.shiftKey && !(event.metaKey || event.ctrlKey)) return;

    if (focus.matches?.("#ask")) {
      event.preventDefault();
      void submitGoal();
    } else if (focus.matches?.("#panel-message")) {
      event.preventDefault();
      void sendAgentMessage(board.openAgent ?? "", focus);
    }
  });

  // The composer's height is content-driven, so it has to be measured on every change the
  // browser can make to the value — typing, pasting, cutting, undo — which is what `input` is.
  const ask = el("ask");
  ask?.addEventListener("input", () => autoGrow(ask));
  autoGrow(ask);

  el("ask-target")?.addEventListener("change", () => {
    board.target = el("ask-target")?.value ?? "";
    renderDirectHint();
    el("ask")?.focus();
  });

  el("agent-panel")?.addEventListener("close", () => {
    toggleRename(false);
    board.openAgent = null;
  });

  // The conversation follows the newest message only while the reader is at the bottom of it.
  chatHost()?.addEventListener("scroll", () => syncJump());

  renderStatus();
  renderChat();
  renderTargets();
  renderProfiles();
  void refreshState();
  void refreshProfiles();
  connect();
  setInterval(() => {
    tickElapsed();
    // The only thing this moves on its own is a resolved row ageing out of TURN_RESOLVE_MS.
    // A running row is held up by the daemon's status, and nothing here can invent one.
    syncTurns();
  }, 1000);
  // Belt-and-braces reconciliation: a socket can stay open and still be useless (a proxy
  // buffering it, a suspended laptop). Polling loopback every 10s costs nothing and
  // guarantees the board is never more than ten seconds stale.
  setInterval(() => void refreshState(), 10000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => init());
else init();
