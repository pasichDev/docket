#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { diffDetail, formatHistory, pushHistory } from "./history.js";
import { installProcessLogging, log } from "./log.js";
import { CURRENT_FORMAT_VERSION, readStore, withStore } from "./storage.js";
import type { Todo, TodoList, TodoPriority } from "./types.js";

installProcessLogging("mcp");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = z.string().regex(DATE_RE, "Use YYYY-MM-DD");

const server = new McpServer({ name: "todo-mcp", version: "1.0.0" });
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
  const working = todo.workingAgent
    ? ` ▶working:${todo.workingAgent}${todo.workingSession ? `[${todo.workingSession}]` : ""}`
    : "";
  const via = todo.agent ? ` (via ${todo.agent})` : "";
  const suffix = todo.done && todo.completedAt ? ` (done ${todo.completedAt.slice(0, 10)})` : "";
  const desc = todo.description ? `\n      ${todo.description}` : "";
  return `${box} #${todo.id}${cat}${pri}${due}${working} ${todo.title}${via}${suffix}${desc}`;
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
  return sortTodos(todos).map(formatTodo).join("\n");
}

/** When both lists are in scope, render them under separate headers so todo vs backlog stays visually distinct. */
function formatResult(todos: Todo[], filter: string, list: TodoList | "all"): string {
  if (list !== "all") return formatGroup(todos, filter);
  const todoItems = todos.filter((t) => t.list === "todo");
  const backlogItems = todos.filter((t) => t.list === "backlog");
  return `## Todo\n${formatGroup(todoItems, filter)}\n\n## Backlog\n${formatGroup(backlogItems, filter)}`;
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
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ title, description, list, category, priority, dueDate }) => {
    const agent = currentAgent();
    const todo = await withStore((store) => {
      const newTodo: Todo = {
        id: store.nextId,
        title,
        description: description ?? null,
        done: false,
        list,
        category: category ?? null,
        priority: priority ?? null,
        dueDate: dueDate ?? null,
        agent,
        session: sessionToken,
        workingAgent: null,
        workingSince: null,
        workingSession: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
        history: [],
      };
      pushHistory(newTodo, agent, "created", `title: "${title}"`);
      store.nextId += 1;
      store.todos.push(newTodo);
      return newTodo;
    });
    return text(`Added [${todo.list}] ${formatTodo(todo)}${duplicationWarning(todo.title, todo.description)}`);
  },
);

server.registerTool(
  "todo_edit",
  {
    title: "Edit todo",
    description:
      "Edit an existing item's title/description/category/priority/dueDate/list by id. Only fields you pass are changed. Pass an empty string (\"\") for description/category/priority/dueDate to clear that field.",
    inputSchema: {
      id: z.number().int().describe("The todo id, e.g. 3"),
      title: z.string().min(1).optional().describe("New title"),
      description: z.string().optional().describe("New description, or \"\" to clear"),
      category: z.string().optional().describe("New category, or \"\" to clear"),
      priority: z.enum(["low", "medium", "high", ""]).optional().describe("New priority, or \"\" to clear"),
      dueDate: z.union([dateSchema, z.literal("")]).optional().describe("New due date YYYY-MM-DD, or \"\" to clear"),
      list: z.enum(["todo", "backlog"]).optional().describe("Move to this list"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ id, title, description, category, priority, dueDate, list }) => {
    const agent = currentAgent();
    const todo = await withStore((store) => {
      const item = store.todos.find((t) => t.id === id);
      if (!item) return null;
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (title !== undefined && title !== item.title) {
        changes.title = { from: item.title, to: title };
        item.title = title;
      }
      const newDescription = description !== undefined ? (description === "" ? null : description) : undefined;
      if (newDescription !== undefined && newDescription !== item.description) {
        changes.description = { from: item.description, to: newDescription };
        item.description = newDescription;
      }
      const newCategory = category !== undefined ? (category === "" ? null : category) : undefined;
      if (newCategory !== undefined && newCategory !== item.category) {
        changes.category = { from: item.category, to: newCategory };
        item.category = newCategory;
      }
      const newPriority = priority !== undefined ? (priority === "" ? null : (priority as TodoPriority)) : undefined;
      if (newPriority !== undefined && newPriority !== item.priority) {
        changes.priority = { from: item.priority, to: newPriority };
        item.priority = newPriority;
      }
      const newDueDate = dueDate !== undefined ? (dueDate === "" ? null : dueDate) : undefined;
      if (newDueDate !== undefined && newDueDate !== item.dueDate) {
        changes.dueDate = { from: item.dueDate, to: newDueDate };
        item.dueDate = newDueDate;
      }
      if (list !== undefined && list !== item.list) {
        changes.list = { from: item.list, to: list };
        item.list = list;
      }
      if (Object.keys(changes).length > 0) pushHistory(item, agent, "edited", diffDetail(changes));
      return item;
    });
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
    let previousAgent: string | null = null;
    const todo = await withStore((store) => {
      const item = store.todos.find((t) => t.id === id);
      if (!item) return null;
      previousAgent = item.workingAgent;
      item.workingAgent = agent;
      item.workingSince = new Date().toISOString();
      item.workingSession = sessionToken;
      pushHistory(item, agent, "claimed", previousAgent && previousAgent !== agent ? `took over from ${previousAgent}` : "claimed");
      return item;
    });
    if (!todo) return text(`No todo with id #${id}`);
    const warning = previousAgent && previousAgent !== agent ? ` (note: was already claimed by ${previousAgent} — taking over)` : "";
    return text(`Claimed ${formatTodo(todo)}${warning}`);
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
    const todo = await withStore((store) => {
      const item = store.todos.find((t) => t.id === id);
      if (!item) return null;
      item.workingAgent = null;
      item.workingSince = null;
      item.workingSession = null;
      pushHistory(item, agent, "released", "released");
      return item;
    });
    if (!todo) return text(`No todo with id #${id}`);
    return text(`Released ${formatTodo(todo)}`);
  },
);

server.registerTool(
  "todo_list",
  {
    title: "List todos",
    description: "List items from the shared global TODO list, formatted as a checklist.",
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
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ filter, list, category, agent, session, inProgress }) => {
    const store = await readStore();
    const todos = store.todos.filter((todo) => {
      if (filter === "open" && todo.done) return false;
      if (filter === "done" && !todo.done) return false;
      if (list !== "all" && todo.list !== list) return false;
      if (category && todo.category !== category) return false;
      if (agent && todo.agent !== agent) return false;
      if (session && todo.session !== session) return false;
      if (inProgress && !todo.workingAgent) return false;
      return true;
    });
    return text(formatResult(todos, filter, list));
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
    const todo = await withStore((store) => {
      const item = store.todos.find((t) => t.id === id);
      if (!item) return null;
      item.done = true;
      item.completedAt = new Date().toISOString();
      item.workingAgent = null;
      item.workingSince = null;
      item.workingSession = null;
      pushHistory(item, agent, "completed", "marked done");
      return item;
    });
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
  "todo_delete",
  {
    title: "Delete todo",
    description: "Permanently remove a todo by id.",
    inputSchema: { id: z.number().int().describe("The todo id, e.g. 3") },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ id }) => {
    const agent = currentAgent();
    const removed = await withStore((store) => {
      const index = store.todos.findIndex((item) => item.id === id);
      if (index === -1) return null;
      return store.todos.splice(index, 1)[0];
    });
    if (!removed) return text(`No todo with id #${id}`);
    log(`deleted #${removed.id} "${removed.title}" by ${agent ?? "unknown"}`);
    return text(`Deleted #${removed.id} ${removed.title}`);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  log(`mcp failed to start: ${err.stack ?? err.message}`);
  console.error("todo-mcp failed to start:", err);
  process.exit(1);
});
