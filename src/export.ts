import { createTodo } from "./mutations.js";
import type { Todo, TodoList, TodoPriority, TodoStore } from "./types.js";

export interface ExportData {
  version: number;
  exportedAt: string;
  count: number;
  todos: Array<{
    title: string;
    description: string | null;
    done: boolean;
    list: TodoList;
    category: string | null;
    priority: TodoPriority | null;
    dueDate: string | null;
    sourceUrl: string | null;
    createdAt: string;
    completedAt: string | null;
  }>;
}

export function exportToJson(store: TodoStore): string {
  const data: ExportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    count: store.todos.length,
    todos: store.todos.map((t) => ({
      title: t.title,
      description: t.description,
      done: t.done,
      list: t.list,
      category: t.category,
      priority: t.priority,
      dueDate: t.dueDate,
      sourceUrl: t.sourceUrl,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    })),
  };
  return JSON.stringify(data, null, 2);
}

export function exportToMarkdown(store: TodoStore): string {
  const lines: string[] = [
    "# Todo Export",
    "",
    `Exported on ${new Date().toISOString().slice(0, 10)} (${store.todos.length} items)`,
    "",
  ];

  const todoItems = store.todos.filter((t) => t.list === "todo");
  const backlogItems = store.todos.filter((t) => t.list === "backlog");

  function renderGroup(todos: Todo[], heading: string) {
    lines.push(`## ${heading}`, "");
    if (todos.length === 0) {
      lines.push("*(empty)*", "");
      return;
    }
    for (const t of todos) {
      const box = t.done ? "[x]" : "[ ]";
      const cat = t.category ? ` [${t.category}]` : "";
      const pri = t.priority ? ` !${t.priority}` : "";
      const due = t.dueDate ? ` due:${t.dueDate}` : "";
      lines.push(`- ${box} ${t.title}${cat}${pri}${due}`);
      if (t.description) {
        for (const descLine of t.description.split("\n")) {
          lines.push(`  > ${descLine}`);
        }
      }
      if (t.sourceUrl) {
        lines.push(`  🔗 ${t.sourceUrl}`);
      }
    }
    lines.push("");
  }

  renderGroup(todoItems, "Todo");
  renderGroup(backlogItems, "Backlog");

  return lines.join("\n");
}

export function importFromJson(
  store: TodoStore,
  jsonStr: string,
  deviceId: string,
  deviceName: string,
): { added: number; skipped: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Invalid JSON format: ${(err as Error).message}`);
  }

  const rawList: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "todos" in parsed && Array.isArray((parsed as { todos: unknown[] }).todos)
      ? (parsed as { todos: unknown[] }).todos
      : [];

  if (rawList.length === 0 && !Array.isArray(parsed)) {
    throw new Error("JSON must contain an array of todo objects or an object with a 'todos' array property.");
  }

  let added = 0;
  let skipped = 0;

  for (const item of rawList) {
    if (!item || typeof item !== "object") {
      skipped++;
      continue;
    }
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) {
      skipped++;
      continue;
    }

    const description = typeof record.description === "string" && record.description.trim() ? record.description.trim() : null;
    const list = record.list === "backlog" ? "backlog" : "todo";
    const category = typeof record.category === "string" && record.category.trim() ? record.category.trim() : null;
    const priority = ["low", "medium", "high"].includes(String(record.priority)) ? (record.priority as TodoPriority) : null;
    const dueDate = typeof record.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.dueDate) ? record.dueDate : null;
    const sourceUrl = typeof record.sourceUrl === "string" && /^https?:\/\//i.test(record.sourceUrl) ? record.sourceUrl : null;

    const todo = createTodo(
      store,
      {
        title,
        description,
        list,
        category,
        priority,
        dueDate,
        sourceUrl,
        agent: "import-cli",
        session: null,
      },
      deviceId,
      deviceName,
    );

    if (record.done === true) {
      todo.done = true;
      todo.completedAt = typeof record.completedAt === "string" ? record.completedAt : new Date().toISOString();
    }

    added++;
  }

  return { added, skipped };
}

export function importFromMarkdown(
  store: TodoStore,
  mdStr: string,
  deviceId: string,
  deviceName: string,
): { added: number } {
  const lines = mdStr.split("\n");
  let currentList: TodoList = "todo";
  let added = 0;
  let currentTodo: Todo | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (/^##\s+backlog/i.test(line)) {
      currentList = "backlog";
      currentTodo = null;
      continue;
    }
    if (/^##\s+todo/i.test(line)) {
      currentList = "todo";
      currentTodo = null;
      continue;
    }

    // Match checkbox line: - [ ] or - [x] or * [ ] etc.
    const match = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (match) {
      const isDone = match[1].toLowerCase() === "x";
      let text = match[2];

      // Extract metadata like [category], !priority, due:YYYY-MM-DD
      let category: string | null = null;
      const catMatch = text.match(/\[([a-zA-Z0-9_-]+)\]/);
      if (catMatch) {
        category = catMatch[1];
        text = text.replace(catMatch[0], "").trim();
      }

      let priority: TodoPriority | null = null;
      const priMatch = text.match(/!(low|medium|high)\b/i);
      if (priMatch) {
        priority = priMatch[1].toLowerCase() as TodoPriority;
        text = text.replace(priMatch[0], "").trim();
      }

      let dueDate: string | null = null;
      const dueMatch = text.match(/\bdue:(\d{4}-\d{2}-\d{2})\b/i);
      if (dueMatch) {
        dueDate = dueMatch[1];
        text = text.replace(dueMatch[0], "").trim();
      }

      const title = text.trim();
      if (!title) continue;

      currentTodo = createTodo(
        store,
        {
          title,
          list: currentList,
          category,
          priority,
          dueDate,
          agent: "import-cli",
          session: null,
        },
        deviceId,
        deviceName,
      );

      if (isDone) {
        currentTodo.done = true;
        currentTodo.completedAt = new Date().toISOString();
      }

      added++;
      continue;
    }

    // Handle nested description or link lines for the current todo
    if (currentTodo) {
      if (line.startsWith(">")) {
        const descText = line.replace(/^>\s*/, "");
        currentTodo.description = currentTodo.description ? `${currentTodo.description}\n${descText}` : descText;
      } else if (line.startsWith("🔗")) {
        const link = line.replace(/^🔗\s*/, "").trim();
        if (/^https?:\/\//i.test(link)) {
          currentTodo.sourceUrl = link;
        }
      }
    }
  }

  return { added };
}
