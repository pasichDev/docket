import type { HistoryEntry } from "./history.js";

export type TodoList = "todo" | "backlog";
export type TodoPriority = "low" | "medium" | "high";

export interface Todo {
  id: number;
  title: string;
  description: string | null;
  done: boolean;
  list: TodoList;
  category: string | null;
  priority: TodoPriority | null;
  /** ISO date only, e.g. "2026-09-15" — no time component. */
  dueDate: string | null;
  /** MCP client name self-reported at connect time (clientInfo.name), or "web" for the HTTP UI. */
  agent: string | null;
  /** Per-connection token — one per MCP server process run (roughly one host session). Not a claude.ai session URL; that isn't exposed over MCP. */
  session: string | null;
  /** Set by todo_claim: which agent is actively working on this right now. Advisory, not a lock. */
  workingAgent: string | null;
  workingSince: string | null;
  /** Set by todo_claim: the claiming connection's session token (see `session` above) — lets two claims from the same agent name but different host sessions be told apart in the display. */
  workingSession: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Append-only audit log: every create/edit/claim/release/complete, by whom (agent, including "web" for manual UI edits). */
  history: HistoryEntry[];
}

export interface TodoStore {
  /** Data shape version. Missing/0 means pre-versioning data. A file version newer than
   * the running code understands is a hard error, not a silent guess. */
  formatVersion: number;
  nextId: number;
  todos: Todo[];
}
