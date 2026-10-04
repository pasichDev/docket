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
  mail: "Mail",
  chat: "Chat",
  decision: "Decide",
  check: "Check",
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

/** What a digest row knows about the task list: which todo, if any, is the same piece of work. */
type LinkedTodo = Pick<Todo, "id" | "done" | "title" | "workingAgent">;

export interface TodoLinks {
  byUrl: Map<string, LinkedTodo>;
  byShortId: Map<string, LinkedTodo>;
}

export function linkedTodos(todos: readonly Todo[]): TodoLinks {
  const byUrl = new Map<string, LinkedTodo>();
  const byShortId = new Map<string, LinkedTodo>();
  for (const t of todos) {
    // Open beats done: if both exist, the open one is the one worth pointing at.
    if (t.sourceUrl && (!byUrl.has(t.sourceUrl) || !t.done)) byUrl.set(t.sourceUrl, t);
    if (t.shortId) byShortId.set(t.shortId.toUpperCase(), t);
  }
  return { byUrl, byShortId };
}

/** A docket todo the row IS (its ref is a T- id) or that was made from it (same link). */
export function todoForItem(item: DigestItem, links: TodoLinks): LinkedTodo | null {
  const ref = item.ref?.trim().toUpperCase();
  if (ref && /^T-[0-9A-Z]{6}$/.test(ref)) {
    const own = links.byShortId.get(ref);
    if (own) return own;
  }
  const href = safeHref(item.url);
  return (href && links.byUrl.get(href)) || null;
}

/** Seen marks as the dashboard holds them: key → the status the item was marked in. */
export type SeenMarks = ReadonlyMap<string, string | null>;

export function isHidden(item: DigestItem, seen: SeenMarks): boolean {
  return !!item.key && seen.has(item.key) && (seen.get(item.key) ?? null) === (item.status ?? null);
}

/** Everything a render needs beyond the digest itself. */
export interface DigestView {
  links: TodoLinks;
  seen: SeenMarks;
  adding: ReadonlySet<string>;
  group: string | null;
  now: number;
  /** "area" groups sections as the agent wrote them; "people" regroups items by owner. */
  mode: "area" | "people";
  /** The digest's short id, for the hand-off handle on each row. */
  shortId: string;
}

const NONE: ReadonlySet<string> = new Set();
const NO_MARKS: SeenMarks = new Map();

export function digestView(links: TodoLinks, overrides: Partial<Omit<DigestView, "links">> = {}): DigestView {
  return { links, seen: NO_MARKS, adding: NONE, group: null, now: Date.now(), mode: "area", shortId: "", ...overrides };
}

const ICON_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12 10 17 19 7"/></svg>`;
const ICON_ALERT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>`;
const ICON_EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-3.1 4.2M6.1 6.1A13 13 0 0 0 2 12c1 2.5 5 7 10 7a9.6 9.6 0 0 0 4-.9"/></svg>`;

/** The row's task action: close the todo it is, open it in Tasks, or make one from it. */
function taskButton(item: DigestItem, key: string, view: DigestView): string {
  const todo = todoForItem(item, view.links);
  if (todo && !todo.done && todo.workingAgent) {
    return `<span class="dg-working" title="An agent is on it">▶ ${escapeHtml(todo.workingAgent)}</span><button type="button" class="dg-task dg-task-close" data-close-todo="${todo.id}" data-close-title="${escapeHtml(todo.title)}" title="Close this task, with a reason">${ICON_CHECK}<span>close</span></button>`;
  }
  if (todo && !todo.done) {
    return `<button type="button" class="dg-task dg-task-close" data-close-todo="${todo.id}" data-close-title="${escapeHtml(todo.title)}" title="Close this task, with a reason">${ICON_CHECK}<span>close</span></button>`;
  }
  if (todo) return `<a class="dg-task dg-task-linked" href="/tasks" data-nav="tasks" title="Already done in Tasks">${ICON_CHECK}<span>done</span></a>`;
  if (view.adding.has(key)) return `<button type="button" class="dg-task" disabled>${ICON_PLUS}<span>adding…</span></button>`;
  return `<button type="button" class="dg-task" data-digest-item="${escapeHtml(key)}" title="Add to Tasks">${ICON_PLUS}<span>task</span></button>`;
}

function seenButton(item: DigestItem, hidden: boolean): string {
  if (!item.key) return "";
  const attrs = `data-seen-key="${escapeHtml(item.key)}" data-seen-status="${escapeHtml(item.status ?? "")}" data-seen-title="${escapeHtml(item.title)}"`;
  return hidden
    ? `<button type="button" class="dg-seen" ${attrs} data-seen="false" title="Show it again">show</button>`
    : `<button type="button" class="dg-seen" ${attrs} data-seen="true" title="Mark as seen — hidden until its status changes">${ICON_EYE_OFF}</button>`;
}

/**
 * One digest row becomes one task: the ref goes in the category when it looks like a ticket
 * id, so the card picks up the same colour badge any other ACME-123 item has; the link goes in
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

function ownerLabel(owner: string): string {
  if (owner.toLowerCase() === "you") return "You";
  if (owner.toLowerCase() === "agent") return "Agent";
  return owner;
}

/** "#7": a click copies what to tell an agent. Absent on digests from before numbering. */
function handleButton(item: DigestItem, view: DigestView): string {
  if (!item.n || !view.shortId) return "";
  const handle = `${view.shortId}/${item.n}`;
  return `<button type="button" class="dg-n" data-handoff="${escapeHtml(handle)}" title="Copy ${escapeHtml(handle)} — tell any agent to take it">#${item.n}</button>`;
}

function changeBadge(item: DigestItem): string {
  if (item.change === "new") return `<span class="dg-change" data-change="new">new</span>`;
  if (item.change === "changed") return `<span class="dg-change" data-change="changed" title="Status in the previous digest">was ${escapeHtml(item.previousStatus ?? "—")}</span>`;
  return "";
}

export function digestItemHtml(item: DigestItem, key: string, view: DigestView, hidden = false): string {
  const href = safeHref(item.url);
  const title = escapeHtml(item.title);
  const titleHtml = href
    ? `<a class="dg-title" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : `<span class="dg-title">${title}</span>`;
  const meta = [item.repo ? escapeHtml(item.repo) : "", item.updatedAt ? `updated ${escapeHtml(timeAgo(item.updatedAt))}` : ""].filter(Boolean);
  return `<li class="dg-item" data-tone="${tone(item.tone)}"${item.attention && !hidden ? ' data-attention="true"' : ""}${hidden ? ' data-hidden="true"' : ""}>
    <span class="dg-kind" data-kind="${escapeHtml(item.kind)}">${escapeHtml(KIND_LABEL[item.kind] ?? "Note")}</span>
    <div class="dg-main">
      <div class="dg-line">${handleButton(item, view)}${item.ref ? `<span class="dg-ref">${escapeHtml(item.ref)}</span>` : ""}${titleHtml}${changeBadge(item)}</div>
      ${meta.length || item.owner ? `<div class="dg-meta">${item.owner ? `<span class="dg-owner">→ ${escapeHtml(ownerLabel(item.owner))}</span>${meta.length ? " · " : ""}` : ""}${meta.join(" · ")}</div>` : ""}
      ${item.note && !hidden ? `<div class="dg-note">${escapeHtml(item.note)}</div>` : ""}
      ${item.detail && !hidden ? `<details class="dg-detail"><summary>Details</summary><div class="md">${renderMarkdown(item.detail)}</div></details>` : ""}
    </div>
    <div class="dg-side">
      ${item.status ? `<span class="dg-status" data-tone="${tone(item.tone)}">${item.attention ? ICON_ALERT : ""}${escapeHtml(item.status)}</span>` : item.attention ? `<span class="dg-status" data-tone="warn">${ICON_ALERT}needs you</span>` : ""}
      ${hidden ? "" : taskButton(item, key, view)}
      ${seenButton(item, hidden)}
    </div>
  </li>`;
}

function sectionHtml(d: Digest, index: number, view: DigestView): string {
  const section = d.sections[index];
  if (section.items.length === 0) return "";
  const visible: string[] = [];
  const hidden: string[] = [];
  let needs = 0;
  section.items.forEach((item, i) => {
    const key = `${d.uuid}:${index}:${i}`;
    if (isHidden(item, view.seen)) {
      hidden.push(digestItemHtml(item, key, view, true));
    } else {
      visible.push(digestItemHtml(item, key, view));
      if (item.attention) needs += 1;
    }
  });
  const shown = visible.slice(0, SECTION_FOLD).join("");
  const rest = visible.slice(SECTION_FOLD);
  const all = visible.length > 0 && needs === visible.length;
  return `<section class="dg-section"${all ? ' data-attention="true"' : ""}${visible.length === 0 ? ' data-all-seen="true"' : ""}>
    <h3><span>${escapeHtml(section.title)}</span><span class="dg-count">${visible.length}</span>${needs && !all ? `<span class="dg-need">${needs} need you</span>` : ""}</h3>
    ${visible.length ? `<ul class="dg-items">${shown}</ul>` : ""}
    ${rest.length ? `<details class="dg-more"><summary>Show ${rest.length} more</summary><ul class="dg-items">${rest.join("")}</ul></details>` : ""}
    ${hidden.length ? `<details class="dg-seen-list"><summary>${hidden.length} seen</summary><ul class="dg-items">${hidden.join("")}</ul></details>` : ""}
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

export function heroHtml(d: Digest, view: Pick<DigestView, "now" | "seen"> = { now: Date.now(), seen: NO_MARKS }): string {
  const who = [d.agent, d.deviceName].filter(Boolean).join("@");
  const needs = attentionItems(d).filter((i) => !isHidden(i, view.seen)).length;
  const seenCount = d.sections.reduce((n, s) => n + s.items.filter((i) => isHidden(i, view.seen)).length, 0);
  const window = windowLabel(d);
  const chips = [
    window ? `<span class="dg-chip">${escapeHtml(window)}</span>` : "",
    `<span class="dg-chip">${items(itemCount(d) - seenCount)}${seenCount ? ` · ${seenCount} seen` : ""}</span>`,
    needs ? `<a class="dg-chip dg-chip-need" href="#dg-first-attention">${ICON_ALERT}${needs} need you</a>` : "",
    d.workspace ? `<span class="dg-chip">@${escapeHtml(d.workspace)}</span>` : "",
    isStale(d, view.now) ? `<span class="dg-chip dg-chip-stale" title="Ask your agent for a fresh digest">${escapeHtml(timeAgo(d.createdAt))} — may be out of date</span>` : "",
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
  /** Counts leave out seen items, so a group the user has cleared reads as cleared. */
  items: number;
  attention: number;
}

/** Sections grouped by `group`, in order of first appearance. Empty for an ungrouped digest. */
export function groupsOf(d: Pick<Digest, "sections">, seen: SeenMarks = NO_MARKS): DigestGroup[] {
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
    const live = s.items.filter((it) => !isHidden(it, seen));
    g.items += live.length;
    g.attention += live.filter((it) => it.attention).length;
  });
  return [...byName.values()];
}

function groupChipsHtml(groups: readonly DigestGroup[], active: string | null): string {
  const chip = (name: string | null, label: string, n: number, need: number) =>
    `<button type="button" class="dg-group-chip" data-digest-group="${escapeHtml(name ?? "")}" data-active="${(active ?? "") === (name ?? "")}">${escapeHtml(label)} <span class="n">${n}</span>${need ? `<span class="need">${need}</span>` : ""}</button>`;
  const total = groups.reduce((n, g) => n + g.items, 0);
  const need = groups.reduce((n, g) => n + g.attention, 0);
  return `<div class="dg-groups" role="toolbar" aria-label="Filter by area">${chip(null, "All", total, need)}${groups.map((g) => chip(g.name, g.name, g.items, g.attention)).join("")}</div>`;
}

export function changesHtml(d: Digest): string {
  const c = d.changes;
  if (!c) return "";
  const moved = d.sections.flatMap((s) => s.items.filter((i) => i.change === "changed"));
  if (c.added === 0 && moved.length === 0 && c.gone.length === 0) {
    return `<section class="dg-changes"><h3>Since the previous digest</h3><p class="dg-empty-note">Nothing moved.</p></section>`;
  }
  const line = (ref: string | null, title: string, rest: string) =>
    `<li>${ref ? `<span class="dg-ref">${escapeHtml(ref)}</span>` : ""}<span>${escapeHtml(title)}</span>${rest}</li>`;
  return `<section class="dg-changes">
    <h3>Since the previous digest <span class="dg-count">${c.added} new · ${c.changed} changed · ${c.gone.length} gone</span></h3>
    ${moved.length ? `<ul class="dg-change-list">${moved.map((i) => line(i.ref, i.title, `<span class="dg-arrow">${escapeHtml(i.previousStatus ?? "—")} → ${escapeHtml(i.status ?? "—")}</span>`)).join("")}</ul>` : ""}
    ${c.gone.length ? `<details class="dg-more"><summary>${c.gone.length} no longer listed</summary><ul class="dg-change-list">${c.gone.map((g) => line(g.ref, g.title, g.status ? `<span class="dg-arrow">last: ${escapeHtml(g.status)}</span>` : "")).join("")}</ul></details>` : ""}
  </section>`;
}

/** Owners in reading order: the user first, people by name, the agent's own follow-ups last. */
function ownerOrder(a: string, b: string): number {
  const rank = (o: string) => (o.toLowerCase() === "you" ? 0 : o.toLowerCase() === "agent" ? 2 : 1);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** "Who does what": every owned item, under its owner, in digest order — numbered steps. */
export function peopleHtml(d: Digest, view: DigestView): string {
  const byOwner = new Map<string, Array<{ item: DigestItem; key: string }>>();
  let unowned = 0;
  d.sections.forEach((s, si) =>
    s.items.forEach((item, ii) => {
      if (isHidden(item, view.seen)) return;
      if (!item.owner) {
        unowned += 1;
        return;
      }
      const list = byOwner.get(item.owner) ?? [];
      list.push({ item, key: `${d.uuid}:${si}:${ii}` });
      byOwner.set(item.owner, list);
    }),
  );
  const owners = [...byOwner.keys()].sort(ownerOrder);
  const cards = owners.map((owner) => {
    const rows = byOwner.get(owner)!;
    return `<section class="dg-section dg-person"${owner.toLowerCase() === "you" ? ' data-attention="true"' : ""}>
      <h3><span>${escapeHtml(ownerLabel(owner))}</span><span class="dg-count">${rows.length}</span></h3>
      <ol class="dg-items dg-steps">${rows.map(({ item, key }) => digestItemHtml(item, key, view)).join("")}</ol>
    </section>`;
  });
  const note = unowned ? `<p class="dg-empty-note">${unowned} item${unowned === 1 ? "" : "s"} without an owner — "By area" shows them.</p>` : "";
  return `<div class="dg-group">${cards.join("") || `<p class="dg-empty-note">No item names an owner.</p>`}</div>${note}`;
}

function modeSwitchHtml(d: Digest, mode: DigestView["mode"]): string {
  if (!d.sections.some((s) => s.items.some((i) => i.owner))) return "";
  const btn = (m: DigestView["mode"], label: string) => `<button type="button" data-digest-mode="${m}" data-active="${mode === m}">${label}</button>`;
  return `<div class="dg-mode" role="toolbar" aria-label="Arrange by">${btn("area", "By area")}${btn("people", "By person")}</div>`;
}

/**
 * `view.group` filters the body to one area; null shows every group, each under its own
 * heading. An unknown group (the digest changed under a remembered filter) falls back to all.
 */
export function digestBodyHtml(d: Digest, view: DigestView): string {
  const groups = groupsOf(d, view.seen);
  const people = view.mode === "people" && d.sections.some((s) => s.items.some((i) => i.owner));
  let body: string;
  if (people) {
    body = peopleHtml(d, view);
  } else if (groups.length === 0) {
    // Wrapped like a group without a heading, so the grid layouts apply to it as well.
    const sections = d.sections.map((_, i) => sectionHtml(d, i, view)).join("");
    body = sections ? `<div class="dg-group">${sections}</div>` : "";
  } else {
    const shown = groups.filter((g) => g.name === view.group);
    const visible = shown.length ? shown : groups;
    body =
      groupChipsHtml(groups, shown.length ? view.group : null) +
      visible
        .map(
          (g) => `<div class="dg-group">
        <h2 class="dg-group-head"><span>${escapeHtml(g.name)}</span><span class="dg-count">${items(g.items)}</span>${g.attention ? `<span class="dg-need">${g.attention} need you</span>` : ""}</h2>
        ${g.sections.map((i) => sectionHtml(d, i, view)).join("")}
      </div>`,
        )
        .join("");
  }
  // The hero's "N need you" chip jumps here.
  const anchored = body.replace('data-attention="true"', 'id="dg-first-attention" data-attention="true"');
  return `${heroHtml(d, view)}${changesHtml(d)}${metricsHtml(d)}${modeSwitchHtml(d, view.mode)}${anchored || `<p class="dg-empty-note">This digest has no items.</p>`}`;
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
