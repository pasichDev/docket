import { renderMarkdown } from "./markdown.js";
import type { Digest, DigestItem, DigestItemKind, DigestSummary, DigestTone, Todo } from "./types.js";
import { escapeHtml, isOverdue, timeAgo, todayStr } from "./util.js";

/**
 * The dashboard's markup, as pure functions of the data. No DOM, no state, no fetch — the
 * same rule cards.ts follows, and for the same reason: everything a digest carries came from
 * an agent or a peer, so every string here goes through escapeHtml() before it reaches the
 * page, and render.escaping.test.ts can hold that line by importing this module directly.
 */

const KIND_LABEL: Record<DigestItemKind, string> = {
  pr: "PR",
  mr: "MR",
  issue: "Issue",
  ticket: "Ticket",
  commit: "Commit",
  release: "Release",
  todo: "Todo",
  doc: "Doc",
  note: "Note",
};

/** A digest is read as "what is true now", so past this age it says it may not be. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Rows a section shows before folding the rest behind a "show more". */
export const SECTION_FOLD = 8;

function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    return ["http:", "https:"].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}

const TONES: readonly string[] = ["good", "warn", "bad", "info", "neutral"];

/** Lands in an attribute unescaped, so it is checked against the five names, never trusted. */
function tone(t: DigestTone | null | undefined): DigestTone {
  return t && TONES.includes(t) ? t : "neutral";
}

function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function windowLabel(d: Pick<Digest, "windowFrom" | "windowTo">): string {
  const from = shortDate(d.windowFrom);
  const to = shortDate(d.windowTo);
  if (from && to) return from === to ? from : `${from} → ${to}`;
  return from || to;
}

export function attentionItems(d: Pick<Digest, "sections">): DigestItem[] {
  return d.sections.flatMap((s) => s.items.filter((i) => i.attention));
}

function itemCount(d: Pick<Digest, "sections">): number {
  return d.sections.reduce((n, s) => n + s.items.length, 0);
}

function items(n: number): string {
  return n === 1 ? "1 item" : `${n} items`;
}

export function isStale(d: Pick<Digest, "createdAt">, now = Date.now()): boolean {
  return now - new Date(d.createdAt).getTime() > STALE_AFTER_MS;
}

/** What the "→ task" button already knows: an open or done todo pointing at the same link. */
export type LinkedTodos = Map<string, Pick<Todo, "id" | "done">>;

export function linkedTodos(todos: readonly Todo[]): LinkedTodos {
  const map: LinkedTodos = new Map();
  // Open beats done: if both exist, the open one is the one worth pointing at.
  for (const t of todos) if (t.sourceUrl && (!map.has(t.sourceUrl) || !t.done)) map.set(t.sourceUrl, t);
  return map;
}

const ICON_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12 10 17 19 7"/></svg>`;
const ICON_ALERT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>`;

function taskButton(item: DigestItem, key: string, linked: LinkedTodos, adding: ReadonlySet<string>): string {
  const href = safeHref(item.url);
  const existing = href ? linked.get(href) : undefined;
  if (existing) {
    return `<a class="dg-task dg-task-linked" href="/tasks" data-nav="tasks" title="${existing.done ? "Already done in Tasks" : "Already in Tasks"}">${ICON_CHECK}<span>${existing.done ? "done" : "in tasks"}</span></a>`;
  }
  if (adding.has(key)) return `<button type="button" class="dg-task" disabled>${ICON_PLUS}<span>adding…</span></button>`;
  return `<button type="button" class="dg-task" data-digest-item="${escapeHtml(key)}" title="Add to Tasks">${ICON_PLUS}<span>task</span></button>`;
}

/**
 * One digest row becomes one task: the ref goes in the category when it looks like a ticket
 * id, so the card picks up the same colour badge any other VPQ-123 item has; the link goes in
 * sourceUrl, which is also how the button knows next time that the task already exists.
 */
export function todoFromItem(item: DigestItem, digest: Pick<Digest, "shortId">, workspace: string | null = null): Record<string, unknown> {
  const ticketLike = item.ref && /^[A-Z][A-Z0-9]+-\d+$/.test(item.ref);
  const title = !ticketLike && item.ref ? `${item.ref} ${item.title}` : item.title;
  const lines = [item.note, item.repo ? `Repo: ${item.repo}` : null, item.status ? `Status when captured: ${item.status}` : null, `From digest ${digest.shortId}`];
  return {
    title: title.slice(0, 300),
    description: lines.filter(Boolean).join("\n\n"),
    category: ticketLike ? item.ref : (item.repo ?? undefined),
    sourceUrl: item.url ?? undefined,
    priority: item.attention ? "high" : undefined,
    list: "todo",
    // The project the Tasks switcher is on, as the add form does — otherwise the new task is
    // filed Unfiled and is missing from the very list the user goes to look for it in.
    workspace,
  };
}

const NONE: ReadonlySet<string> = new Set();

export function digestItemHtml(item: DigestItem, key: string, linked: LinkedTodos, adding: ReadonlySet<string> = NONE): string {
  const href = safeHref(item.url);
  const title = escapeHtml(item.title);
  const titleHtml = href
    ? `<a class="dg-title" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : `<span class="dg-title">${title}</span>`;
  const meta = [item.repo ? escapeHtml(item.repo) : "", item.updatedAt ? `updated ${escapeHtml(timeAgo(item.updatedAt))}` : ""].filter(Boolean);
  return `<li class="dg-item" data-tone="${tone(item.tone)}"${item.attention ? ' data-attention="true"' : ""}>
    <span class="dg-kind" data-kind="${escapeHtml(item.kind)}">${escapeHtml(KIND_LABEL[item.kind] ?? "Note")}</span>
    <div class="dg-main">
      <div class="dg-line">${item.ref ? `<span class="dg-ref">${escapeHtml(item.ref)}</span>` : ""}${titleHtml}</div>
      ${meta.length ? `<div class="dg-meta">${meta.join(" · ")}</div>` : ""}
      ${item.note ? `<div class="dg-note">${escapeHtml(item.note)}</div>` : ""}
    </div>
    <div class="dg-side">
      ${item.status ? `<span class="dg-status" data-tone="${tone(item.tone)}">${item.attention ? ICON_ALERT : ""}${escapeHtml(item.status)}</span>` : item.attention ? `<span class="dg-status" data-tone="warn">${ICON_ALERT}needs you</span>` : ""}
      ${taskButton(item, key, linked, adding)}
    </div>
  </li>`;
}

function sectionHtml(d: Digest, index: number, linked: LinkedTodos, adding: ReadonlySet<string>): string {
  const section = d.sections[index];
  if (section.items.length === 0) return "";
  const rows = section.items.map((item, i) => digestItemHtml(item, `${d.uuid}:${index}:${i}`, linked, adding));
  const shown = rows.slice(0, SECTION_FOLD).join("");
  const rest = rows.slice(SECTION_FOLD);
  const needs = section.items.filter((i) => i.attention).length;
  return `<section class="dg-section"${needs === section.items.length ? ' data-attention="true"' : ""}>
    <h3><span>${escapeHtml(section.title)}</span><span class="dg-count">${section.items.length}</span>${needs && needs < section.items.length ? `<span class="dg-need">${needs} need you</span>` : ""}</h3>
    <ul class="dg-items">${shown}</ul>
    ${rest.length ? `<details class="dg-more"><summary>Show ${rest.length} more</summary><ul class="dg-items">${rest.join("")}</ul></details>` : ""}
  </section>`;
}

export function metricsHtml(d: Digest): string {
  if (d.metrics.length === 0) return "";
  return `<div class="dg-metrics">${d.metrics
    .map((m) => `<div class="dg-metric" data-tone="${tone(m.tone)}"><div class="dg-metric-value">${escapeHtml(m.value)}</div><div class="dg-metric-label">${escapeHtml(m.label)}</div></div>`)
    .join("")}</div>`;
}

function sourcesHtml(d: Digest): string {
  if (d.sources.length === 0) return "";
  return `<div class="dg-sources">${d.sources
    .map(
      (s) =>
        `<span class="dg-source" data-ok="${s.ok}" title="${escapeHtml(s.detail ?? (s.ok ? "read" : "could not be read"))}"><span class="dot"></span>${escapeHtml(s.name)}${!s.ok ? " failed" : ""}</span>`,
    )
    .join("")}</div>`;
}

export function heroHtml(d: Digest, now = Date.now()): string {
  const who = [d.agent, d.deviceName].filter(Boolean).join("@");
  const needs = attentionItems(d).length;
  const window = windowLabel(d);
  const chips = [
    window ? `<span class="dg-chip">${escapeHtml(window)}</span>` : "",
    `<span class="dg-chip">${items(itemCount(d))}</span>`,
    needs ? `<a class="dg-chip dg-chip-need" href="#dg-first-attention">${ICON_ALERT}${needs} need you</a>` : "",
    d.workspace ? `<span class="dg-chip">@${escapeHtml(d.workspace)}</span>` : "",
    isStale(d, now) ? `<span class="dg-chip dg-chip-stale" title="Ask your agent for a fresh digest">${escapeHtml(timeAgo(d.createdAt))} — may be out of date</span>` : "",
  ].join("");
  return `<article class="dg-hero">
    <div class="dg-eyebrow">
      <span>Digest · ${escapeHtml(shortDate(d.createdAt))} ${escapeHtml(clock(d.createdAt))}</span>
      ${who ? `<span>by ${escapeHtml(who)}</span>` : ""}
      <button type="button" class="dg-id" data-copy="${escapeHtml(d.shortId)}" title="Copy id">${escapeHtml(d.shortId)}</button>
    </div>
    <h2>${escapeHtml(d.title)}</h2>
    <div class="dg-chips">${chips}</div>
    ${d.summary ? `<div class="dg-summary md">${renderMarkdown(d.summary)}</div>` : ""}
    ${d.highlights.length ? `<ul class="dg-highlights">${d.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>` : ""}
    <div class="dg-hero-foot">
      ${sourcesHtml(d)}
      <button type="button" class="dg-delete" data-delete-digest="${escapeHtml(d.uuid)}">Delete</button>
    </div>
  </article>`;
}

export interface DigestGroup {
  name: string;
  /** Indexes into digest.sections, in order — the indexes also key each "+ task" button. */
  sections: number[];
  items: number;
  attention: number;
}

/** Sections grouped by `group`, in order of first appearance. Empty for an ungrouped digest. */
export function groupsOf(d: Pick<Digest, "sections">): DigestGroup[] {
  if (!d.sections.some((s) => s.group)) return [];
  const byName = new Map<string, DigestGroup>();
  d.sections.forEach((s, i) => {
    const name = s.group || "Other";
    let g = byName.get(name);
    if (!g) {
      g = { name, sections: [], items: 0, attention: 0 };
      byName.set(name, g);
    }
    g.sections.push(i);
    g.items += s.items.length;
    g.attention += s.items.filter((it) => it.attention).length;
  });
  return [...byName.values()];
}

function groupChipsHtml(groups: readonly DigestGroup[], active: string | null, total: number): string {
  const chip = (name: string | null, label: string, n: number, need: number) =>
    `<button type="button" class="dg-group-chip" data-digest-group="${escapeHtml(name ?? "")}" data-active="${(active ?? "") === (name ?? "")}">${escapeHtml(label)} <span class="n">${n}</span>${need ? `<span class="need">${need}</span>` : ""}</button>`;
  const need = groups.reduce((n, g) => n + g.attention, 0);
  return `<div class="dg-groups" role="toolbar" aria-label="Filter by area">${chip(null, "All", total, need)}${groups.map((g) => chip(g.name, g.name, g.items, g.attention)).join("")}</div>`;
}

/**
 * `group` filters the body to one area; null shows every group, each under its own heading.
 * An unknown group (the digest changed under a remembered filter) falls back to all.
 */
export function digestBodyHtml(d: Digest, linked: LinkedTodos, now = Date.now(), adding: ReadonlySet<string> = NONE, group: string | null = null): string {
  const groups = groupsOf(d);
  let body: string;
  if (groups.length === 0) {
    body = d.sections.map((_, i) => sectionHtml(d, i, linked, adding)).join("");
  } else {
    const shown = groups.filter((g) => g.name === group);
    const visible = shown.length ? shown : groups;
    body =
      groupChipsHtml(groups, shown.length ? group : null, itemCount(d)) +
      visible
        .map(
          (g) => `<div class="dg-group">
        <h2 class="dg-group-head"><span>${escapeHtml(g.name)}</span><span class="dg-count">${items(g.items)}</span>${g.attention ? `<span class="dg-need">${g.attention} need you</span>` : ""}</h2>
        ${g.sections.map((i) => sectionHtml(d, i, linked, adding)).join("")}
      </div>`,
        )
        .join("");
  }
  // The hero's "N need you" chip jumps here.
  const anchored = body.replace('data-attention="true"', 'id="dg-first-attention" data-attention="true"');
  return `${heroHtml(d, now)}${metricsHtml(d)}${anchored || `<p class="dg-empty-note">This digest has no items.</p>`}`;
}

export function timelineHtml(digests: readonly DigestSummary[], selected: string | null): string {
  if (digests.length === 0) return "";
  return `<section class="dg-side-card">
    <h3>Digests <span class="dg-count">${digests.length}</span></h3>
    <ol class="dg-timeline">${digests
      .map(
        (d) => `<li><button type="button" data-digest="${escapeHtml(d.uuid)}" data-active="${d.uuid === selected}">
          <span class="dg-tl-date">${escapeHtml(shortDate(d.createdAt))} · ${escapeHtml(clock(d.createdAt))}</span>
          <span class="dg-tl-title">${escapeHtml(d.title)}</span>
          <span class="dg-tl-meta">${items(d.itemCount)}${d.attentionCount ? ` · <b>${d.attentionCount} need you</b>` : ""}</span>
        </button></li>`,
      )
      .join("")}</ol>
  </section>`;
}

/** The task list in four numbers and its five most pressing items — the bridge to /tasks. */
export function glanceHtml(todos: readonly Todo[]): string {
  const open = todos.filter((t) => !t.done);
  const working = open.filter((t) => t.workingAgent);
  const overdue = open.filter((t) => isOverdue(t));
  const today = todayStr();
  const weekAhead = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const dueSoon = open.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= weekAhead);
  const rank = (t: Todo) => (t.workingAgent ? 0 : isOverdue(t) ? 1 : t.priority === "high" ? 2 : t.dueDate ? 3 : 4);
  const top = [...open].sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  const stat = (n: number, label: string, toneName: string) => `<div class="dg-glance-stat" data-tone="${toneName}"><b>${n}</b><span>${label}</span></div>`;
  return `<section class="dg-side-card">
    <h3>Tasks <a class="dg-link" href="/tasks" data-nav="tasks">open list →</a></h3>
    <div class="dg-glance">
      ${stat(open.length, "open", "neutral")}${stat(working.length, "in progress", "info")}${stat(overdue.length, "overdue", overdue.length ? "bad" : "neutral")}${stat(dueSoon.length, "due in 7d", dueSoon.length ? "warn" : "neutral")}
    </div>
    ${
      top.length
        ? `<ul class="dg-glance-list">${top
            .map((t) => {
              const flag = t.workingAgent ? `<span class="dg-flag" data-tone="info">${escapeHtml(t.workingAgent)}</span>` : isOverdue(t) ? `<span class="dg-flag" data-tone="bad">overdue</span>` : t.priority === "high" ? `<span class="dg-flag" data-tone="warn">high</span>` : "";
              return `<li><a href="/tasks" data-nav="tasks">${t.category ? `<span class="dg-ref">${escapeHtml(t.category)}</span>` : ""}${escapeHtml(t.title)}</a>${flag}</li>`;
            })
            .join("")}</ul>`
        : `<p class="dg-empty-note">Nothing open.</p>`
    }
  </section>`;
}

export function emptyDashboardHtml(): string {
  return `<article class="dg-hero dg-hero-empty">
    <div class="dg-eyebrow"><span>No digests yet</span></div>
    <h2>Your work, in one place</h2>
    <p class="dg-lede">Ask your agent for a digest — <code>make a digest</code>, <code>зроби дайджест</code> — and it reads your merge requests, pull requests and tickets, then lays them out here: what shipped, what is waiting on you, and what is stuck.</p>
    <ul class="dg-highlights">
      <li>Every item links straight back to GitLab, GitHub or Notion.</li>
      <li>Anything that needs you is flagged, and one click turns it into a task.</li>
      <li>Digests sync to your paired devices, like the task list.</li>
    </ul>
    <p class="dg-hint">First time? The agent's <code>docket:digest-setup</code> skill asks which sources to read.</p>
  </article>`;
}
