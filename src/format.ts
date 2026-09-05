import { formatAgentIdentity, isClaimActive, shortId } from "./mutations.js";
import type { LiveSession } from "./sessions.js";
import { summarizeWorkspaces } from "./workspace.js";
import type { Todo, TodoList, TodoStore } from "./types.js";

/**
 * How docket talks to an agent — every string a tool call puts in a model's context window.
 *
 * Kept in its own module, apart from the MCP server that uses it, for one reason: these are
 * budgeted (see docs/context-budget in the README and budget.test.ts), and a budget you
 * can't test is a wish. index.ts constructs an MCP server and reads device identity at
 * import time, so a test that imported it to check a one-line string would start a server.
 */

/** Catches the classic accidental-paste: description repeats the title verbatim at its start. */
export function duplicationWarning(title: string, description: string | null): string {
  if (description && description.startsWith(title)) {
    return " ⚠️ description starts with the same text as title — looks like accidental duplication, not a real description.";
  }
  return "";
}

export function formatTodo(todo: Todo, currentWorkspace: string | null): string {
  const box = todo.done ? "[x]" : "[ ]";
  const cat = todo.category ? ` [${todo.category}]` : "";
  const pri = todo.priority ? ` !${todo.priority}` : "";
  const due = todo.dueDate ? ` due:${todo.dueDate}` : "";
  const working = isClaimActive(todo)
    ? ` ▶working:${todo.workingAgent}${todo.workingSession ? `[${todo.workingSession}]` : ""}`
    : "";
  // Only shown when it ISN'T this session's own project. An id resolves globally, so an
  // agent can reach an item from another workspace — it just must not be left thinking the
  // item landed in the project it is standing in.
  const elsewhere = todo.workspace && todo.workspace !== currentWorkspace ? ` @${todo.workspace}` : "";
  const via = todo.agent ? ` (via ${formatAgentIdentity(todo.agent, todo.deviceName)})` : "";
  const suffix = todo.done && todo.completedAt ? ` (done ${todo.completedAt.slice(0, 10)})` : "";
  const desc = todo.description ? `\n      ${todo.description}` : "";
  const source = todo.sourceUrl ? `\n      🔗 ${todo.sourceUrl}` : "";
  return `${box} #${todo.id} (${shortId(todo.uuid)})${cat}${pri}${due}${working}${elsewhere} ${todo.title}${via}${suffix}${desc}${source}`;
}

/**
 * One line per item: `T-XK2P9  fix token refresh race  [high]  ← codex`.
 *
 * The default, not an option, because this output is paid for on every list call in every
 * terminal all day. A full record carries description, history, timestamps, device
 * provenance — none of which an agent deciding "what's open here?" reads. `verbose: true`
 * is there for when it genuinely needs the rest.
 */
export function compactTodo(todo: Todo, currentWorkspace: string | null): string {
  const done = todo.done ? "✓ " : "";
  const priority = todo.priority ? `  [${todo.priority}]` : "";
  const holder = isClaimActive(todo) ? `  ← ${todo.workingAgent}` : "";
  const elsewhere = todo.workspace && todo.workspace !== currentWorkspace ? `  @${todo.workspace}` : "";
  return `${done}${shortId(todo.uuid)}  ${todo.title}${priority}${holder}${elsewhere}`;
}

/** Open items first (oldest first), done items after (most recently completed first). */
export function sortTodos(todos: Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) return (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
    return a.id - b.id;
  });
}

function formatGroup(todos: Todo[], filter: string, verbose: boolean, currentWorkspace: string | null): string {
  if (todos.length === 0) return `No ${filter === "all" ? "" : filter + " "}todos.`;
  return todos.map((t) => (verbose ? formatTodo(t, currentWorkspace) : compactTodo(t, currentWorkspace))).join("\n");
}

/**
 * One line, appended only when the results were actually narrowed. Its whole job is to stop
 * an agent concluding "there is nothing open" when it is looking at one project's slice —
 * and to tell it, in the same breath, exactly how to see the rest.
 */
/**
 * The line that stops "scoped" from reading as "gone".
 *
 * This is the scariest failure of the whole workspace feature, and it isn't a bug — it's
 * what the feature does. A host starts with an unexpected cwd, the project resolves to
 * something else, the list comes back empty, and the honest conclusion from where the user
 * is sitting is "my data is gone". Nobody reads documentation in that moment; they
 * uninstall. So whenever the result is empty and the STORE is not, say both numbers and
 * name the way out.
 */
export function emptyScopeNotice(scope: string, allTodos: Todo[], remedy = 'workspace:"*" for all'): string {
  if (scope === "*") return "";
  const elsewhere = allTodos.filter((t) => !t.done && t.workspace !== scope && t.workspace !== null);
  if (elsewhere.length === 0) return ""; // genuinely nothing open anywhere — an empty list is the truth
  const workspaces = new Set(elsewhere.map((t) => t.workspace)).size;
  return `\n\n_0 open in ${scope} — ${elsewhere.length} open across ${workspaces} other workspace${workspaces === 1 ? "" : "s"} (${remedy})_`;
}

export function scopeNotice(scope: string, remedy = 'workspace:"*" for all'): string {
  if (scope === "*") return "";
  return `\n\n_(scoped to ${scope} — pass ${remedy})_`;
}

/** When both lists are in scope, render them under separate headers so todo vs backlog stays visually distinct. */
export function formatResult(
  todos: Todo[],
  filter: string,
  list: TodoList | "all",
  pagination?: { limit?: number; offset?: number; total: number },
  verbose = false,
  currentWorkspace: string | null = null,
): string {
  let header = "";
  if (pagination && (pagination.limit !== undefined || pagination.offset !== undefined)) {
    const offset = pagination.offset ?? 0;
    const limit = pagination.limit ?? todos.length;
    const start = pagination.total > 0 ? offset + 1 : 0;
    const end = Math.min(offset + limit, pagination.total);
    header = `_Showing ${start}-${end} of ${pagination.total} items (offset: ${offset}, limit: ${limit})_\n\n`;
  }

  if (list !== "all") {
    return `${header}${formatGroup(todos, filter, verbose, currentWorkspace)}`;
  }
  const todoItems = todos.filter((t) => t.list === "todo");
  const backlogItems = todos.filter((t) => t.list === "backlog");
  return `${header}## Todo\n${formatGroup(todoItems, filter, verbose, currentWorkspace)}\n\n## Backlog\n${formatGroup(backlogItems, filter, verbose, currentWorkspace)}`;
}

/**
 * Maximum items injected at session start. Seven is not a round number for its own sake: it
 * is about as many lines as a person actually reads before scrolling, and it keeps the whole
 * block inside SESSION_START_TOKEN_BUDGET even with long titles.
 */
export const SESSION_START_MAX_ITEMS = 7;

/**
 * Ceiling for the SessionStart injection, in tokens. This text is paid for at the start of
 * every session in every terminal, forever, so the budget is a requirement rather than a
 * guideline — budget.test.ts enforces it. Tokens are approximated at 4 characters, which
 * over-counts for prose and roughly matches for identifier-heavy lines like these.
 */
export const SESSION_START_TOKEN_BUDGET = 120;

/** Deliberately crude, and deliberately pessimistic: a budget that needs a tokenizer dependency to check is a budget nobody checks. */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * What an agent sees when a session opens: what is already in flight in THIS project.
 *
 * With leases and blocking deferred, continuity is the hook's entire job — you come back to
 * a terminal and the thread is already there. Empty output when the project has nothing
 * open, because "no open items" is not worth a line at the top of every session.
 */
export function renderSessionStart(todos: Todo[], currentWorkspace: string | null): string {
  const open = sortTodos(todos.filter((t) => !t.done));
  if (open.length === 0) return "";
  const heading = `Docket — open in ${currentWorkspace ?? "this session"}:`;
  const lines = open.slice(0, SESSION_START_MAX_ITEMS).map((t) => compactTodo(t, currentWorkspace));

  const build = (count: number) => {
    const more = open.length > count ? `\n(+${open.length - count} more — todo_list for the rest)` : "";
    return `${heading}\n${lines.slice(0, count).join("\n")}${more}`;
  };
  // Long titles can blow the budget before the item cap does. Items are dropped whole
  // rather than truncated mid-word: half a title is worse than one fewer line.
  for (let count = lines.length; count > 0; count--) {
    const block = build(count);
    if (approximateTokens(block) <= SESSION_START_TOKEN_BUDGET) return block;
  }
  return heading;
}

/** "active" under a minute, then "idle 4m" / "idle 2h" — the same vocabulary presence.ts already uses. */
export function formatIdle(lastSeenAt: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(lastSeenAt));
  if (ms < 60_000) return "active";
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `idle ${minutes}m` : `idle ${Math.floor(minutes / 60)}h`;
}

/**
 * One line, or nothing at all: "→ codex is live in acme/backend (idle 2m)".
 *
 * This is the honest version of "hand this to another agent". Pushing work into an already-
 * open terminal is not possible over stdio MCP — the server cannot wake an agent, and an
 * agent only acts inside a turn a human starts. What IS possible is telling you that a
 * terminal already has this project open, so you switch to it instead of starting a third
 * one. Anything more would be a queue wearing a router's clothes.
 *
 * Silent when the only session in that workspace is the caller's own: a hint about yourself
 * is pure noise, and this text is paid for on every single capture.
 */
export function routingHint(sessions: LiveSession[], workspace: string | null, currentSession: string): string {
  if (!workspace) return ""; // unfiled items belong to no project, so there is nowhere to point
  const others = sessions.filter((s) => s.workspace === workspace && s.session !== currentSession);
  if (others.length === 0) return "";
  const [first] = others;
  const more = others.length > 1 ? ` +${others.length - 1} more` : "";
  return `\n→ ${first.agent ?? "another agent"} is live in ${workspace} (${formatIdle(first.lastSeenAt)})${more}`;
}

const GREEN = "\x1b[38;2;52;211;153m"; // Todo — matches web UI's #34d399
const VIOLET = "\x1b[38;2;167;139;250m"; // Backlog — matches web UI's #a78bfa
const AMBER = "\x1b[38;2;245;158;11m"; // in-progress — matches web UI's priority-medium #f59e0b
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * The one-line terminal widget, rendered once for both entry points that show it —
 * `docket stats` (via src/index.ts) and the standalone `dist/stats.js` used by shell
 * prompts. They were separate copies, and had already drifted: only one of them grew the
 * per-project counts.
 */
export function renderStatsWidget(store: TodoStore): string {
  const open = (list: TodoList) => store.todos.filter((t) => t.list === list && !t.done).length;
  let out = `${GREEN}Todo ${open("todo")}${RESET}`;
  const backlogOpen = open("backlog");
  if (backlogOpen > 0) out += `   ${VIOLET}Backlog ${backlogOpen}${RESET}`;

  // With three projects feeding one list, a single total says nothing about where the work
  // actually is. Shown only when there is more than one project to distinguish.
  const byWorkspace = summarizeWorkspaces(store.todos);
  if (byWorkspace.length > 1) {
    out += `\n${byWorkspace.map(({ name, open: count }) => `${DIM}${name}${RESET} ${count}`).join("   ")}`;
  }

  const working = store.todos.filter((t) => t.workingAgent && !t.done && isClaimActive(t));
  if (working.length > 0) {
    const label = (t: Todo) => t.category ?? (t.title.length > 30 ? `${t.title.slice(0, 30)}…` : t.title);
    out += `\n${working.map((t) => `${AMBER}▶ ${label(t)}${RESET} ${DIM}(${t.workingAgent})${RESET}`).join(", ")}`;
  }
  return out;
}
