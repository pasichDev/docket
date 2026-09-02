#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDeviceId, getDeviceName } from "./device.js";
import { exportToJson, exportToMarkdown, importFromJson, importFromMarkdown } from "./export.js";
import { formatHistory } from "./history.js";
import { installProcessLogging, log } from "./log.js";
import { applyEdits, claimTodo, completeTodo, createTodo, isClaimActive, releaseTodo, tombstoneDelete } from "./mutations.js";
import { CURRENT_FORMAT_VERSION, migrateLegacyFields, readStore, withStore, withTodo } from "./storage.js";
import type { Todo, TodoList } from "./types.js";
import { checkForUpdate, getCurrentVersion, runUpdate } from "./update.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

installProcessLogging("mcp");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = z.string().regex(DATE_RE, "Use YYYY-MM-DD");
// http(s) only — a javascript:/data: URL here would be a stored-XSS click target in the web UI.
// mutations.ts enforces this too (the real boundary, since it's shared by every caller); this
// is just a clearer error at the MCP layer instead of a silent drop-to-null.
const httpUrlSchema = z.string().url().refine((u) => ["http:", "https:"].includes(new URL(u).protocol), {
  message: "must be an http:// or https:// URL",
});

const WEB_PORT = Number(process.env.TODO_MCP_WEB_PORT ?? 8787);
const deviceId = await getDeviceId();
const deviceName = await getDeviceName();

/**
 * Every MCP host spawns its own `node dist/index.js` per session, so this
 * runs on every connection — but the web UI is a single shared HTTP server,
 * not per-session. Probe the port first and only spawn one if nothing is
 * listening yet; the child is detached + unref'd so it outlives this
 * (short-lived) MCP process and the next session's probe finds it already
 * running instead of double-spawning.
 */
async function ensureWebUiRunning(): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/version`, {
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) return; // already running
  } catch {
    // ECONNREFUSED / timeout — nothing listening, fall through to spawn below.
  }
  try {
    const webEntry = fileURLToPath(new URL("./web.js", import.meta.url));
    const child = spawn(process.execPath, [webEntry], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    log(`auto-started web UI (pid ${child.pid}) on port ${WEB_PORT}`);
  } catch (err) {
    log(`failed to auto-start web UI: ${(err as Error).message}`);
  }
}

// Read from package.json rather than a hardcoded literal, so this can't drift out of
// sync with the actual published version the way it silently did before.
const serverVersion = await getCurrentVersion(SCRIPT_PATH).catch(() => "0.0.0-unknown");
const server = new McpServer({ name: "todo-mcp", version: serverVersion });
const startedAt = new Date().toISOString();

// One token per process run — each MCP host (Claude Code, Warp, Codex...)
// spawns its own `node dist/index.js`, so this groups everything created
// during one continuous connection. Not the host's own session id/URL —
// MCP over stdio doesn't expose that to the server.
const sessionToken = randomUUID().slice(0, 8);

function currentAgent(): string | null {
  return server.server.getClientVersion()?.name ?? null;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

/** Edit convention for every optional tool field: omitted leaves it alone, an explicit "" clears it. */
function clearable<T extends string>(value: T | undefined): Exclude<T, ""> | null | undefined {
  if (value === undefined) return undefined;
  if (value === "") return null;
  return value as Exclude<T, "">;
}

/** Catches the classic accidental-paste: description repeats the title verbatim at its start. */
function duplicationWarning(title: string, description: string | null): string {
  if (description && description.startsWith(title)) {
    return " ⚠️ description starts with the same text as title — looks like accidental duplication, not a real description.";
  }
  return "";
}

function formatTodo(todo: Todo): string {
  const box = todo.done ? "[x]" : "[ ]";
  const cat = todo.category ? ` [${todo.category}]` : "";
  const pri = todo.priority ? ` !${todo.priority}` : "";
  const due = todo.dueDate ? ` due:${todo.dueDate}` : "";
  const working = isClaimActive(todo)
    ? ` ▶working:${todo.workingAgent}${todo.workingSession ? `[${todo.workingSession}]` : ""}`
    : "";
  const via = todo.agent ? ` (via ${todo.agent}${todo.deviceName ? ` on ${todo.deviceName}` : ""})` : "";
  const suffix = todo.done && todo.completedAt ? ` (done ${todo.completedAt.slice(0, 10)})` : "";
  const desc = todo.description ? `\n      ${todo.description}` : "";
  const source = todo.sourceUrl ? `\n      🔗 ${todo.sourceUrl}` : "";
  return `${box} #${todo.id}${cat}${pri}${due}${working} ${todo.title}${via}${suffix}${desc}${source}`;
}

/** Open items first (oldest first), done items after (most recently completed first). */
function sortTodos(todos: Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) return (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
    return a.id - b.id;
  });
}

function formatGroup(todos: Todo[], filter: string): string {
  if (todos.length === 0) return `No ${filter === "all" ? "" : filter + " "}todos.`;
  return todos.map(formatTodo).join("\n");
}

/** When both lists are in scope, render them under separate headers so todo vs backlog stays visually distinct. */
function formatResult(
  todos: Todo[],
  filter: string,
  list: TodoList | "all",
  pagination?: { limit?: number; offset?: number; total: number },
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
    return `${header}${formatGroup(todos, filter)}`;
  }
  const todoItems = todos.filter((t) => t.list === "todo");
  const backlogItems = todos.filter((t) => t.list === "backlog");
  return `${header}## Todo\n${formatGroup(todoItems, filter)}\n\n## Backlog\n${formatGroup(backlogItems, filter)}`;
}

server.registerTool(
  "todo_add",
  {
    title: "Add todo",
    description:
      "Add a new item to the shared global TODO list. Use list=\"backlog\" for things to park and not hold in context (deferred findings, low-priority follow-ups); list=\"todo\" (default) for near-term actionable items.",
    inputSchema: {
      title: z.string().min(1).describe("Short one-line title/summary"),
      description: z.string().optional().describe("Optional longer body text — details, context, links"),
      list: z
        .enum(["todo", "backlog"])
        .default("todo")
        .describe("Which list this item belongs to"),
      category: z
        .string()
        .min(1)
        .optional()
        .describe("Optional free-form category/tag, e.g. a ticket id like \"VPQ-834\""),
      priority: z.enum(["low", "medium", "high"]).optional().describe("Optional priority"),
      dueDate: dateSchema.optional().describe("Optional due date, YYYY-MM-DD"),
      sourceUrl: httpUrlSchema
        .optional()
        .describe(
          "Strongly recommended when this item comes from somewhere with a URL: a GitHub issue/PR, a Notion page, an Obsidian note (if it has a share/publish link), a Slack thread, a doc, etc. Lets a human jump straight back to the source instead of re-finding it.",
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ title, description, list, category, priority, dueDate, sourceUrl }) => {
    const agent = currentAgent();
    const todo = await withStore((store) =>
      createTodo(
        store,
        { title, description, list, category, priority, dueDate, sourceUrl, agent, session: sessionToken },
        deviceId,
        deviceName,
      ),
    );
    return text(`Added [${todo.list}] ${formatTodo(todo)}${duplicationWarning(todo.title, todo.description)}`);
  },
);

server.registerTool(
  "todo_edit",
  {
    title: "Edit todo",
    description:
      "Edit an existing item's title/description/category/priority/dueDate/sourceUrl/list by id. Only fields you pass are changed. Pass an empty string (\"\") for description/category/priority/dueDate/sourceUrl to clear that field.",
    inputSchema: {
      id: z.number().int().describe("The todo id, e.g. 3"),
      title: z.string().min(1).optional().describe("New title"),
      description: z.string().optional().describe("New description, or \"\" to clear"),
      category: z.string().optional().describe("New category, or \"\" to clear"),
      priority: z.enum(["low", "medium", "high", ""]).optional().describe("New priority, or \"\" to clear"),
      dueDate: z.union([dateSchema, z.literal("")]).optional().describe("New due date YYYY-MM-DD, or \"\" to clear"),
      sourceUrl: z.union([httpUrlSchema, z.literal("")]).optional().describe("New source link (GitHub/Notion/Obsidian/etc.), or \"\" to clear"),
      list: z.enum(["todo", "backlog"]).optional().describe("Move to this list"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ id, title, description, category, priority, dueDate, sourceUrl, list }) => {
    const agent = currentAgent();
    const patch = {
      title,
      description: clearable(description),
      category: clearable(category),
      priority: clearable(priority),
      dueDate: clearable(dueDate),
      sourceUrl: clearable(sourceUrl),
      list,
    };
    const todo = await withTodo(id, (item) => applyEdits(item, patch, agent, deviceId, deviceName));
    if (!todo) return text(`No todo with id #${id}`);
    return text(`Updated ${formatTodo(todo)}${duplicationWarning(todo.title, todo.description)}`);
  },
);

server.registerTool(
  "todo_claim",
  {
    title: "Claim todo",
    description:
      "Mark an item as actively being worked on by you (the calling agent). Advisory, not a lock — check todo_list(inProgress: true) before starting new work to avoid duplicating another agent's active item. Call todo_release or todo_complete when you stop.",
    inputSchema: { id: z.number().int().describe("The todo id, e.g. 3") },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ id }) => {
    const agent = currentAgent();
    const claimed = await withStore((store) => {
      const item = store.todos.find((t) => t.id === id);
      if (!item) return null;
      return { item, previousAgent: claimTodo(item, agent, sessionToken, deviceId, deviceName) };
    });
    if (!claimed) return text(`No todo with id #${id}`);
    const { item, previousAgent } = claimed;
    const warning = previousAgent && previousAgent !== agent ? ` (note: was already claimed by ${previousAgent} — taking over)` : "";
    return text(`Claimed ${formatTodo(item)}${warning}`);
  },
);

server.registerTool(
  "todo_release",
  {
    title: "Release todo",
    description: "Clear the in-progress claim on an item without completing it (e.g. you're pausing this work).",
    inputSchema: { id: z.number().int().describe("The todo id, e.g. 3") },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ id }) => {
    const agent = currentAgent();
    const todo = await withTodo(id, (item) => releaseTodo(item, agent, deviceId, deviceName));
    if (!todo) return text(`No todo with id #${id}`);
    return text(`Released ${formatTodo(todo)}`);
  },
);

server.registerTool(
  "todo_list",
  {
    title: "List todos",
    description: "List items from the shared global TODO list, formatted as a checklist with optional pagination.",
    inputSchema: {
      filter: z
        .enum(["open", "done", "all"])
        .default("open")
        .describe("Which todos to return"),
      list: z
        .enum(["todo", "backlog", "all"])
        .default("all")
        .describe("Restrict to the todo list, the backlog, or both (default)"),
      category: z.string().optional().describe("Restrict to items with this exact category/tag"),
      agent: z.string().optional().describe("Restrict to items added by this MCP client name, e.g. \"claude-code\""),
      session: z.string().optional().describe("Restrict to items added during this connection's session token (see the 'via' suffix on listed items)"),
      inProgress: z.boolean().optional().describe("If true, restrict to items currently claimed via todo_claim (see the '▶working' suffix)"),
      limit: z.number().int().min(1).max(500).optional().describe("Max number of items to return (for token efficiency / pagination)"),
      offset: z.number().int().min(0).optional().describe("Number of items to skip (for pagination)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ filter, list, category, agent, session, inProgress, limit, offset }) => {
    const store = await readStore();
    const matched = store.todos.filter((todo) => {
      if (filter === "open" && todo.done) return false;
      if (filter === "done" && !todo.done) return false;
      if (list !== "all" && todo.list !== list) return false;
      if (category && todo.category !== category) return false;
      if (agent && todo.agent !== agent) return false;
      if (session && todo.session !== session) return false;
      if (inProgress && !isClaimActive(todo)) return false;
      return true;
    });

    const sorted = sortTodos(matched);
    const total = sorted.length;
    const start = offset ?? 0;
    const paginated = limit !== undefined || offset !== undefined ? sorted.slice(start, limit !== undefined ? start + limit : undefined) : sorted;

    return text(formatResult(paginated, filter, list, { limit, offset, total }));
  },
);

server.registerTool(
  "todo_complete",
  {
    title: "Complete todo",
    description: "Mark a todo as done by id.",
    inputSchema: { id: z.number().int().describe("The todo id, e.g. 3") },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ id }) => {
    const agent = currentAgent();
    const todo = await withTodo(id, (item) => completeTodo(item, agent, deviceId, deviceName));
    if (!todo) return text(`No todo with id #${id}`);
    return text(`Completed ${formatTodo(todo)}`);
  },
);

server.registerTool(
  "todo_history",
  {
    title: "Todo history",
    description: "Show the change history (create/edit/claim/release/complete) for one item, who made each change and when.",
    inputSchema: { id: z.number().int().describe("The todo id, e.g. 3") },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ id }) => {
    const store = await readStore();
    const item = store.todos.find((t) => t.id === id);
    if (!item) return text(`No todo with id #${id}`);
    return text(formatHistory(item));
  },
);

server.registerTool(
  "todo_version",
  {
    title: "Server version",
    description:
      "Report this todo-mcp process's data format version and start time. Use to sanity-check whether your MCP connection is running stale code (e.g. right after an update) — if todo_list output looks wrong (missing/undefined fields), check this first and reconnect if the process looks old.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => text(`todo-mcp formatVersion=${CURRENT_FORMAT_VERSION}, process started ${startedAt}, pid ${process.pid}`),
);

server.registerTool(
  "todo_check_update",
  {
    title: "Check for todo-mcp update",
    description:
      "Check whether a newer version of todo-mcp is published on npm. Read-only — never installs anything. If one is available, tell the user and let THEM decide whether to run `todo-mcp update` in their own terminal (it asks for confirmation before installing).",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    try {
      const result = await checkForUpdate(SCRIPT_PATH);
      if (result.installKind === "dev-clone") return text("This is a local git clone, not an npm install — use `git pull` to update.");
      if (result.installKind === "npx") return text("Running via npx — always gets the latest published version automatically, nothing to check.");
      if (result.updateAvailable) {
        return text(`Update available: ${result.currentVersion} → ${result.latestVersion}. The user can run \`todo-mcp update\` in a terminal to install it.`);
      }
      return text(`Already up to date (${result.currentVersion}).`);
    } catch (err) {
      return text(`Couldn't check for updates: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "todo_delete",
  {
    title: "Delete todo",
    description: "Permanently remove a todo by id.",
    inputSchema: { id: z.number().int().describe("The todo id, e.g. 3") },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ id }) => {
    const agent = currentAgent();
    const removed = await withTodo(id, (item, store) => tombstoneDelete(store, item, deviceId));
    if (!removed) return text(`No todo with id #${id}`);
    log(`deleted #${removed.id} "${removed.title}" by ${agent ?? "unknown"}`);
    return text(`Deleted #${removed.id} ${removed.title}`);
  },
);

function printHelp() {
  console.log(`
todo-mcp - Shared TODO/backlog MCP server & task manager

Usage:
  todo-mcp [command] [options]

Commands:
  (no args)             Start MCP server over stdio (when spawned by AI host)
  list [filter]         List todos (filter: open | done | all, default: open)
  stats                 Display terminal statistics widget with active claims
  web                   Ensure web UI dashboard is running and print its URL
  export [options]      Export todos to stdout or a file (--format json|markdown)
  import <file>         Import todos from a JSON or Markdown file
  check-update          Check npm for a newer version without installing anything
  update                Check, confirm, install, self-test, and roll back on failure
  help, --help, -h      Show this help message

Export options:
  --format, -f <fmt>    Export format: "json" (default) or "markdown" / "md"
  --out, -o <file>      Write export output directly to file

Environment variables:
  TODO_MCP_WEB_PORT     Port for the local web UI (default: 8787)

Examples:
  todo-mcp stats
  todo-mcp list all
  todo-mcp export --format markdown > backup.md
  todo-mcp import backup.md
`);
}

async function handleCli(args: string[]): Promise<boolean> {
  const cmd = args[0]?.toLowerCase();

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return true;
  }

  if (cmd === "stats") {
    const store = await readStore();
    const todo = store.todos.filter((t) => t.list === "todo");
    const backlog = store.todos.filter((t) => t.list === "backlog");
    const todoOpen = todo.filter((t) => !t.done).length;
    const backlogOpen = backlog.filter((t) => !t.done).length;
    const GREEN = "\x1b[38;2;52;211;153m";
    const VIOLET = "\x1b[38;2;167;139;250m";
    const AMBER = "\x1b[38;2;245;158;11m";
    const DIM = "\x1b[2m";
    const RESET = "\x1b[0m";

    let out = `${GREEN}Todo ${todoOpen}${RESET}`;
    if (backlogOpen > 0) out += `   ${VIOLET}Backlog ${backlogOpen}${RESET}`;
    const working = store.todos.filter((t) => t.workingAgent && !t.done && isClaimActive(t));
    if (working.length > 0) {
      const label = (t: (typeof working)[number]) => t.category ?? (t.title.length > 30 ? `${t.title.slice(0, 30)}…` : t.title);
      const items = working.map((t) => `${AMBER}▶ ${label(t)}${RESET} ${DIM}(${t.workingAgent})${RESET}`).join(", ");
      out += `\n${items}`;
    }
    console.log(out);
    return true;
  }

  if (cmd === "list" || cmd === "ls") {
    const filter = (args[1]?.toLowerCase() as "open" | "done" | "all") || "open";
    const store = await readStore();
    const todos = store.todos.filter((t) => {
      if (filter === "open") return !t.done;
      if (filter === "done") return t.done;
      return true;
    });
    console.log(formatResult(todos, filter, "all"));
    return true;
  }

  if (cmd === "web") {
    await ensureWebUiRunning();
    console.log(`Web UI available at: http://localhost:${WEB_PORT}`);
    return true;
  }

  if (cmd === "check-update") {
    const result = await checkForUpdate(SCRIPT_PATH);
    if (result.installKind === "dev-clone") console.log("Local git clone — run `git pull` and `npm run build` to update.");
    else if (result.installKind === "npx") console.log("Running via npx — always latest, nothing to check.");
    else if (result.updateAvailable) console.log(`Update available: ${result.currentVersion} → ${result.latestVersion}. Run \`todo-mcp update\`.`);
    else console.log(`Up to date (${result.currentVersion}).`);
    return true;
  }

  if (cmd === "update") {
    await runUpdate(SCRIPT_PATH, {
      confirm: async (message) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await rl.question(`${message} [y/N] `);
          return /^y(es)?$/i.test(answer.trim());
        } finally {
          rl.close();
        }
      },
    });
    return true;
  }

  if (cmd === "export") {
    const formatIdx = args.findIndex((a) => a === "--format" || a === "-f");
    const outIdx = args.findIndex((a) => a === "--out" || a === "-o");
    const format = (formatIdx !== -1 ? args[formatIdx + 1]?.toLowerCase() : "json") ?? "json";
    const outFile = outIdx !== -1 ? args[outIdx + 1] : null;

    const store = await readStore();
    const content = format === "markdown" || format === "md" ? exportToMarkdown(store) : exportToJson(store);

    if (outFile) {
      await writeFile(outFile, content, "utf8");
      console.log(`Exported ${store.todos.length} items to ${outFile}`);
    } else {
      process.stdout.write(content + "\n");
    }
    return true;
  }

  if (cmd === "import") {
    const file = args[1];
    if (!file) {
      console.error("Error: Please provide a file to import. Example: todo-mcp import ./tasks.json");
      process.exit(1);
    }
    const raw = await readFile(file, "utf8");
    const isJson = file.endsWith(".json") || raw.trim().startsWith("{") || raw.trim().startsWith("[");
    const result = await withStore((store) => {
      if (isJson) {
        return importFromJson(store, raw, deviceId, deviceName);
      }
      return importFromMarkdown(store, raw, deviceId, deviceName);
    });
    console.log(`Successfully imported ${result.added} items into todo store.`);
    return true;
  }

  return false;
}

// Graceful shutdown handlers
process.on("SIGINT", () => {
  log("mcp process received SIGINT, exiting cleanly");
  process.exit(0);
});
process.on("SIGTERM", () => {
  log("mcp process received SIGTERM, exiting cleanly");
  process.exit(0);
});

async function main() {
  const args = process.argv.slice(2);
  const isCli = args.length > 0 || process.stdin.isTTY;

  if (isCli) {
    const handled = await handleCli(args);
    if (handled) return;
    if (process.stdin.isTTY && args.length === 0) {
      printHelp();
      return;
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  await migrateLegacyFields();
  await ensureWebUiRunning();
}

main().catch((err) => {
  log(`mcp failed to start: ${err.stack ?? err.message}`);
  console.error("todo-mcp failed to start:", err);
  process.exit(1);
});
