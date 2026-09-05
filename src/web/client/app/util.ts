import type { CategoryTint, SortMode, Todo } from "./types.js";

/**
 * The leaf functions: escaping, colour derivation, dates, sort comparators. Everything else
 * in the client calls into here and nothing here calls back out.
 *
 * Only `isDark` touches the DOM, and only when called — never at import time. That is what
 * lets the tests import this module (and markdown.ts, and cards.ts) directly instead of
 * running the whole client in a sandbox with a hand-built fake DOM.
 */

/**
 * The single escaping boundary. The store deliberately does NOT strip markup from free text
 * — a title and a description are legitimate user content, and mangling them would be data
 * loss — so every rendering path depends on this being applied, and applied first.
 *
 * Ampersand goes first, or every other entity below is forgeable.
 */
export function escapeHtml(value: string): string {
  const replacements: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value).replace(/[&<>"']/g, (c) => replacements[c]);
}

export function isDark(): boolean {
  return document.documentElement.dataset.theme !== "light";
}

function hashOf(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash;
}

/** A stable colour per category name — same project, same colour, on every device. */
export function categoryTint(category: string | null): CategoryTint | null {
  if (!category) return null;
  const hash = hashOf(category);
  const hue = hash % 360;
  const dark = isDark();
  return {
    chipBg: `hsl(${hue} ${dark ? "35% 22%" : "65% 85%"})`,
    chipText: `hsl(${hue} ${dark ? "65% 75%" : "55% 32%"})`,
    rot: `${((hash % 3) - 1) * 1.5}deg`,
  };
}

export function agentColor(agent: string | null): string {
  if (!agent) return "#94a3b8";
  return `hsl(${hashOf(agent) % 360} 55% 55%)`;
}

export function sageHex(): string {
  return isDark() ? "#7fc492" : "#3f7a50";
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isOverdue(todo: Pick<Todo, "done" | "dueDate">): boolean {
  return !todo.done && !!todo.dueDate && todo.dueDate < todayStr();
}

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

type Comparator = (a: Todo, b: Todo) => number;

// "\uffff" sorts after any real value, so items missing the sort key land last.
const byId: Comparator = (a, b) => a.id - b.id;

const COMPARATORS: Record<string, Comparator> = {
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
  az: (a, b) => a.title.localeCompare(b.title),
  category: (a, b) => (a.category || "\uffff").localeCompare(b.category || "\uffff") || byId(a, b),
  priority: (a, b) => (PRIORITY_RANK[a.priority ?? ""] ?? 3) - (PRIORITY_RANK[b.priority ?? ""] ?? 3) || byId(a, b),
  due: (a, b) => (a.dueDate || "\uffff").localeCompare(b.dueDate || "\uffff") || byId(a, b),
};

export function sortItems(items: Todo[], mode: SortMode | string): Todo[] {
  const cmp = COMPARATORS[mode] ?? byId;
  // Claimed/in-progress items always come first, regardless of sort mode.
  return [...items].sort((a, b) => Number(!!b.workingAgent) - Number(!!a.workingAgent) || cmp(a, b));
}

/** Coarse "how long ago", for labels that are glanced at rather than read. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
