import type { Todo } from "./types.js";

export interface HistoryEntry {
  at: string;
  agent: string | null;
  /** Which physical device made this change. Null for entries from before device-sync existed. */
  deviceName: string | null;
  /** "synced" is written locally, not by the editing device — see mergeTodoFields in sync.ts: it records which peer's conflicting edit won a field, not a user action. */
  action: "created" | "edited" | "claimed" | "released" | "completed" | "moved" | "synced";
  detail: string;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "∅";
  return String(v);
}

/** Builds a "field: old → new" summary for a todo_edit-style diff. */
export function diffDetail(changes: Record<string, { from: unknown; to: unknown }>): string {
  return Object.entries(changes)
    .map(([field, { from, to }]) => `${field}: ${fmt(from)} → ${fmt(to)}`)
    .join(", ");
}

export function pushHistory(
  item: Todo,
  agent: string | null,
  action: HistoryEntry["action"],
  detail: string,
  deviceName: string | null = null,
): void {
  item.history = item.history ?? [];
  item.history.push({ at: new Date().toISOString(), agent, deviceName, action, detail });
}

export function formatHistory(item: Todo): string {
  if (!item.history || item.history.length === 0) return `No history for #${item.id}.`;
  return item.history
    .map(
      (h) =>
        `${h.at.slice(0, 19).replace("T", " ")}  ${h.action}  (${h.agent ?? "unknown"}${h.deviceName ? ` on ${h.deviceName}` : ""})  ${h.detail}`,
    )
    .join("\n");
}
