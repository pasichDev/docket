import { readStore } from "./storage.js";

const GREEN = "\x1b[38;2;52;211;153m"; // Todo — matches web UI's #34d399
const VIOLET = "\x1b[38;2;167;139;250m"; // Backlog — matches web UI's #a78bfa
const AMBER = "\x1b[38;2;245;158;11m"; // in-progress — matches web UI's priority-medium #f59e0b
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

async function main() {
  const store = await readStore();
  const todo = store.todos.filter((t) => t.list === "todo");
  const backlog = store.todos.filter((t) => t.list === "backlog");

  const todoOpen = todo.filter((t) => !t.done).length;
  const backlogOpen = backlog.filter((t) => !t.done).length;

  let out = `${GREEN}Todo ${todoOpen}${RESET}`;
  if (backlogOpen > 0) out += `   ${VIOLET}Backlog ${backlogOpen}${RESET}`;

  const working = store.todos.filter((t) => t.workingAgent && !t.done);
  if (working.length > 0) {
    const label = (t: (typeof working)[number]) => t.category ?? (t.title.length > 30 ? `${t.title.slice(0, 30)}…` : t.title);
    const items = working.map((t) => `${AMBER}▶ ${label(t)}${RESET} ${DIM}(${t.workingAgent})${RESET}`).join(", ");
    out += `\n${items}`;
  }

  process.stdout.write(out + "\n");
}

main().catch((err) => {
  console.error("todo-mcp stats failed:", err);
  process.exit(1);
});
