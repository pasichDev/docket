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

/** The wire shape of /api/digests — see src/digests.ts on the server. */
export type DigestTone = "good" | "warn" | "bad" | "info" | "neutral";
export type DigestItemKind = "pr" | "mr" | "issue" | "ticket" | "commit" | "release" | "todo" | "doc" | "mail" | "chat" | "decision" | "check" | "note";

export interface DigestItem {
  /** Identity for seen marks, computed by the server (seenKey in src/digests.ts). */
  key?: string;
  kind: DigestItemKind;
  title: string;
  url: string | null;
  ref: string | null;
  repo: string | null;
  status: string | null;
  tone: DigestTone | null;
  attention: boolean;
  note: string | null;
  detail?: string | null;
  owner?: string | null;
  updatedAt: string | null;
  /** 1-based position; "D-XXXXXX/n" hands the item to an agent. 0 on digests from before numbering. */
  n?: number;
  change?: "new" | "changed" | null;
  previousStatus?: string | null;
}

export interface DigestChanges {
  since: string;
  added: number;
  changed: number;
  gone: Array<{ title: string; ref: string | null; url: string | null; status: string | null }>;
}

export interface Digest {
  uuid: string;
  shortId: string;
  title: string;
  summary: string;
  highlights: string[];
  metrics: Array<{ label: string; value: string; tone: DigestTone | null }>;
  sections: Array<{ group?: string | null; title: string; items: DigestItem[] }>;
  sources: Array<{ name: string; ok: boolean; detail: string | null }>;
  changes?: DigestChanges | null;
  windowFrom: string | null;
  windowTo: string | null;
  workspace: string | null;
  agent: string | null;
  deviceId: string | null;
  deviceName: string | null;
  createdAt: string;
}

/** One row of GET /api/digests — the timeline's needs; the full digest is fetched by id. */
export interface DigestSummary {
  uuid: string;
  shortId: string;
  title: string;
  createdAt: string;
  agent: string | null;
  deviceName: string | null;
  itemCount: number;
  attentionCount: number;
}
