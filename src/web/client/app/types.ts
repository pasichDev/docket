/**
 * The wire shapes, as the browser receives them from /api/todos.
 *
 * Deliberately declared here rather than imported from ../../../types.ts: those are the
 * SERVER's types, and the two are only equal until someone adds a field the API does not
 * serialise. This file is the contract the dashboard actually depends on, and if it drifts
 * from what the API sends, that is a bug worth seeing as a type error rather than inheriting
 * silently.
 */

export type TodoList = "todo" | "backlog";
export type TodoPriority = "low" | "medium" | "high";

export interface HistoryEntry {
  at: string;
  agent: string | null;
  deviceName?: string | null;
  action: string;
  detail: string;
}

export interface Todo {
  id: number;
  uuid: string;
  shortId: string;
  title: string;
  description: string | null;
  done: boolean;
  list: TodoList;
  category: string | null;
  priority: TodoPriority | null;
  dueDate: string | null;
  sourceUrl: string | null;
  agent: string | null;
  session: string | null;
  workspace?: string | null;
  workingAgent: string | null;
  workingSince: string | null;
  workingSession: string | null;
  workingLeaseExpiresAt: string | null;
  workingDeviceId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  revision: number;
  localSeq?: number;
  deviceId: string | null;
  deviceName: string | null;
  history: HistoryEntry[];
}

/** What a card needs. Loosened from Todo so tests can build one without every field. */
export type TodoLike = Todo;

export interface CategoryTint {
  chipBg: string;
  chipText: string;
  rot: string;
}

export type SortMode = "default" | "newest" | "oldest" | "az" | "category" | "priority" | "due";

/** "No project" — a Symbol so nothing a peer can store in `workspace` can impersonate it. */
export const UNFILED: unique symbol = Symbol("unfiled");
export type WorkspaceKey = string | typeof UNFILED;
