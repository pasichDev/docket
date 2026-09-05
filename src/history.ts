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

/**
 * How many entries a card preview shows, and how many are left on the Todo after a flush.
 * Enough for the preview in the web UI and for presence ("what did this agent last do?"),
 * which is all any read on the hot path needs; the full log lives in history.json.enc —
 * see history-store.ts.
 */
export const HISTORY_INLINE_MAX = 5;

/**
 * How many entries may pile up inline before they are moved to the side file.
 *
 * Deliberately much larger than the preview. Flushing is a whole-file rewrite of the audit
 * log, under the store lock — doing it the moment an item exceeds the preview size would
 * mean every single edit to an actively-worked item paid for it, which is the cost the
 * split exists to remove, just moved to a different file. Flushing in batches amortises it
 * to roughly one rewrite per this many writes, and the price is a bounded amount of inline
 * history in the store instead of an unbounded one.
 */
export const HISTORY_FLUSH_THRESHOLD = 40;

/**
 * Merges history from several sources into one ordered log with no repeats. The identity of
 * an entry is its whole content: entries carry no id, and the same event legitimately
 * arrives twice (from the inline copy and the side file, or from two devices that both
 * merged it). Comparing content is what makes those idempotent.
 */
export function dedupeHistory(entries: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const h of entries) {
    const key = `${h.at}|${h.agent}|${h.action}|${h.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
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

/** Renders a log for the CLI/MCP. Takes the entries rather than the Todo so callers can pass the full log from history-store.ts, not just the inline preview. */
export function formatHistoryEntries(entries: HistoryEntry[], id: number | string): string {
  if (!entries || entries.length === 0) return `No history for #${id}.`;
  return entries
    .map(
      (h) =>
        `${h.at.slice(0, 19).replace("T", " ")}  ${h.action}  (${h.agent ?? "unknown"}${h.deviceName ? ` on ${h.deviceName}` : ""})  ${h.detail}`,
    )
    .join("\n");
}

