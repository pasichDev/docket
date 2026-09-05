import { clampMarkdown, DESC_PREVIEW_CHARS, renderMarkdown } from "./markdown.js";
import { isFromOtherDevice, state } from "./state.js";
import type { HistoryEntry, Todo } from "./types.js";
import { agentColor, categoryTint, escapeHtml, isOverdue, sageHex } from "./util.js";

/**
 * One todo in, the markup for one card out. Pure string building: nothing here touches the
 * DOM or the network, which is what lets render.escaping.test.ts import it directly and
 * check that a hostile item cannot become markup.
 */

/**
 * The cross-device id, as a button. It is the string you paste to an agent, and selecting
 * eleven characters by hand on a phone is the reason nobody ever did.
 *
 * Lives here rather than in modals.ts because the card and the detail dialog show the same
 * control, and they had already drifted apart once.
 */
export function itemIdButton(t: Pick<Todo, "id" | "shortId">): string {
  return `<button class="id" type="button" data-copy="${escapeHtml(t.shortId)}" title="Copy ${escapeHtml(t.shortId)} — the cross-device id, identical on every paired device (unlike #${t.id})">#${t.id} · ${escapeHtml(t.shortId)}<svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`;
}


/* ---- what a card is allowed to repeat -------------------------------------------------
 * Both rules have the same shape: a value that reads identically on every visible card is
 * not information, it is furniture. Each is answered against the list's current state, not
 * against the item alone.
 */
// The tag row above the list already says "Todo" or "Backlog" once you have filtered to one.
const showsListBadge = (): boolean => state.activeTag === "all" || state.activeTag === "devices";
// "via web" names the surface you are currently looking at. "via claude-code" is the point.
const showsVia = (t: Todo): boolean => Boolean(t.agent) && t.agent !== "web";

export function itemHtml(t: Todo): string {
  const tint = categoryTint(t.category);
  const cardStyle = t.workingAgent ? ` style="--work-glow:${agentColor(t.workingAgent)};"` : "";
  const badge = t.category && tint
    ? `<span class="badge" title="Filter to ${escapeHtml(t.category)}" data-category="${escapeHtml(t.category)}" style="background:${tint.chipBg}; color:${tint.chipText}; --badge-rot:${tint.rot}; cursor:pointer;">${escapeHtml(t.category)}</span>`
    : "";
  const listBadge = showsListBadge()
    ? `<span class="list-badge ${t.list}"><span class="dot"></span>${t.list === "todo" ? "Todo" : "Backlog"}</span>`
    : "";
  const priorityFlag = t.priority ? `<span class="priority-flag ${t.priority}" title="${t.priority} priority"></span>` : "";
  // Done items show a static tick (no un-completing from the UI); open ones a live checkbox.
  const checkbox = t.done
    ? `<span style="display:flex"><svg viewBox="0 0 18 18" width="18" height="18"><rect x="1.5" y="1.5" width="15" height="15" rx="6" fill="${sageHex()}"/><path d="M5 9.2 7.6 11.8 13 6" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`
    : '<input type="checkbox" />';
  const due = t.dueDate
    ? `<span class="due ${isOverdue(t) ? "overdue" : ""}">${isOverdue(t) ? "overdue " : ""}${escapeHtml(t.dueDate)}</span>`
    : "";
  const via = showsVia(t) && t.agent
    ? `<span class="via" title="${t.session ? `session ${escapeHtml(t.session)}` : "no session"}"><span class="adot" style="background:${agentColor(t.agent)}"></span>via ${escapeHtml(t.agent)}${t.session ? ` <span class="session">#${escapeHtml(t.session)}</span>` : ""}</span>`
    : "";
  // Only for items from OTHER devices — this device's own items stay uncluttered, "via"
  // (agent) already covers the common case.
  const deviceBadge = isFromOtherDevice(t) ? `<span class="device-badge" title="Synced from another device">📱 ${escapeHtml(t.deviceName || "other device")}</span>` : "";
  const workingPill = t.workingAgent
    ? `<span class="working-pill" style="background:${agentColor(t.workingAgent)}"><span class="pulse"></span>working — ${escapeHtml(t.workingAgent)}</span>`
    : "";
  const idButton = itemIdButton(t); // shared with the detail modal, which shows the same control
  // The preview is a real render of the first 300 characters of the SOURCE, so what you
  // read on the card is what you read in the modal — only less of it.
  const preview = clampMarkdown(t.description, DESC_PREVIEW_CHARS);
  const meta = [badge, listBadge, via, deviceBadge].filter(Boolean).join('<span class="sep">·</span>');
  return `
    <li class="${t.done ? "done" : ""} ${t.workingAgent ? "working-card" : ""}" data-id="${t.id}"${cardStyle}>
      ${workingPill}
      <div class="card-main">
        ${checkbox}${priorityFlag}
        <button class="card-title" type="button" title="Open">${escapeHtml(t.title)}</button>
        ${due}
        <span class="card-actions">
          <button class="edit" title="Edit">✎</button>
          <button class="del" title="Delete">✕</button>
        </span>
      </div>
      ${t.description ? `<div class="card-desc md">${renderMarkdown(preview.text)}</div>` : ""}
      ${preview.truncated ? '<button class="read-more" type="button">Read more →</button>' : ""}
      ${sourceLinkHtml(t.sourceUrl)}
      <div class="card-meta">${meta}${idButton}</div>
    </li>`;
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

export function sourceLinkHtml(url: string | null): string {
  if (!url) return "";
  // Escaping is not enough here: "javascript:alert(1)" contains nothing escapeHtml touches
  // and would still execute on click. mutations.ts already refuses to STORE such a URL, and
  // sanitizeRemoteTodo refuses to accept one from a peer — this is the last line, and the
  // one that has to hold if either of those ever regresses or a store is edited by hand.
  try {
    if (!["http:", "https:"].includes(new URL(url).protocol)) return "";
  } catch {
    return "";
  }
  return `<a class="source-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(url)}">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
    ${escapeHtml(sourceHost(url))}
  </a>`;
}

export function historyRowsHtml(entries: HistoryEntry[]): string {
  return [...entries]
    .reverse()
    .map(
      (h: HistoryEntry) => `
        <div class="history-row">
          <span class="history-when">${escapeHtml(h.at.slice(0, 16).replace("T", " "))}</span>
          <span class="history-agent" style="color:${agentColor(h.agent)}">${escapeHtml(h.agent || "unknown")}</span>
          <span class="history-action">${escapeHtml(h.action)}</span>
          <span class="history-detail">${escapeHtml(h.detail)}</span>
        </div>`
    )
    .join("");
}

// The item carries only the last few entries (the rest live in history.json.enc, off the
// write hot path — see history-store.ts). Render those immediately so opening the panel is
// never blank, then replace them with the full log once it arrives. Fetched on open rather
// than with the list: history is the unbounded part of an item, and the list is the thing
// that has to stay cheap.
export function historyHtml(t: Pick<Todo, "uuid" | "history">): string {
  if (!t.history || t.history.length === 0) return "";
  return `
    <details class="history-section" data-history-uuid="${escapeHtml(t.uuid)}">
      <summary>History</summary>
      <div class="history-rows">${historyRowsHtml(t.history.slice(-5))}</div>
    </details>`;
}

export function editFormHtml(t: Todo): string {
  const priorityOptions = ["", "low", "medium", "high"]
    .map((p) => `<option value="${p}" ${(t.priority || "") === p ? "selected" : ""}>${p ? p[0].toUpperCase() + p.slice(1) : "No priority"}</option>`)
    .join("");
  return `
      <form class="edit-form" data-id="${t.id}">
        <div class="edit-body">
          <div>
            <div class="edit-field-label">Title</div>
            <input type="text" class="title" value="${escapeHtml(t.title)}" required />
          </div>
          <div class="md-editor" data-mode="write">
            <div class="md-bar">
              <button type="button" class="md-apply" data-md="bold" title="Bold — Ctrl/⌘B"><b>B</b></button>
              <button type="button" class="md-apply" data-md="italic" title="Italic — Ctrl/⌘I"><i>I</i></button>
              <button type="button" class="md-apply" data-md="code" title="Inline code">&lt;/&gt;</button>
              <button type="button" class="md-apply" data-md="link" title="Link — Ctrl/⌘K">🔗</button>
              <button type="button" class="md-apply" data-md="bullet" title="Bullet list">• —</button>
              <button type="button" class="md-apply" data-md="heading" title="Heading">H</button>
              <span class="md-gap"></span>
              <button type="button" class="md-tab" data-mode="write" data-active="true">Write</button>
              <button type="button" class="md-tab" data-mode="preview" data-active="false">Preview</button>
            </div>
            <textarea class="description" placeholder="Description — markdown works here…">${escapeHtml(t.description || "")}</textarea>
            <div class="md-preview md"></div>
            <!-- &#96; is a literal backtick: writing one here would close the template literal
                 this whole page is built from. -->
            <div class="md-hint">Markdown: **bold** · *italic* · &#96;code&#96; · # heading · - list · &gt; quote · [text](https://…)</div>
          </div>
          <div>
            <div class="edit-field-label">Source link</div>
            <input type="url" class="source-url" placeholder="https://github.com/… , Notion, Obsidian, etc." value="${escapeHtml(t.sourceUrl || "")}" />
          </div>
          <div class="row">
            <div>
              <div class="edit-field-label">Category</div>
              <input type="text" class="category" placeholder="category" value="${escapeHtml(t.category || "")}" />
            </div>
            <div>
              <div class="edit-field-label">Priority</div>
              <select class="priority">${priorityOptions}</select>
            </div>
            <div>
              <div class="edit-field-label">Due date</div>
              <input type="date" class="due" value="${t.dueDate || ""}" />
            </div>
          </div>
        </div>
        <div class="edit-form-actions">
          <button class="cancel-edit" type="button">Cancel</button>
          <button class="save" type="submit">Save changes</button>
        </div>
      </form>`;
}
