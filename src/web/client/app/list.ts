import { itemHtml } from "./cards.js";
import { el } from "./dom.js";
import { forgetWorkspace, isFromOtherDevice, rememberWorkspace, state, workspaceOf } from "./state.js";
import { UNFILED, type Todo, type WorkspaceKey } from "./types.js";
import { escapeHtml, isDark, sortItems, timeAgo } from "./util.js";

/**
 * The list itself: fetching, the project switcher, tag counts, and the reconciler that
 * swaps only the cards whose rendered HTML actually changed, so a background refresh never
 * flickers or steals focus.
 */

export async function fetchTodos(): Promise<Todo[]> {
  const res = await fetch("/api/todos");
  if (res.status === 403) {
    // This browser's access was revoked (or never granted) — reload straight to the
    // access-request gate rather than sitting on stale data with a silent "disconnected".
    location.reload();
    return new Promise<Todo[]>(() => {}); // never resolves; the reload takes over
  }
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const { todos } = (await res.json()) as { todos: Todo[] };
  state.lastSync = Date.now();
  return todos;
}

function renderWorkspaceSwitcher(todos: Todo[]): void {
  // Counts are of OPEN items — a project finished last month shouldn't shout for attention —
  // but every project that has any item at all still gets an entry, which is what adding zero
  // for a done item buys: the key is created either way.
  const counts = new Map<WorkspaceKey, number>();
  for (const t of todos) {
    const key = workspaceOf(t);
    counts.set(key, (counts.get(key) ?? 0) + (t.done ? 0 : 1));
  }

  const names = [...counts.keys()].sort((a, b) =>
    a === UNFILED ? 1 : b === UNFILED ? -1 : String(a).localeCompare(String(b)),
  );
  // A selection that no longer matches anything is dropped FIRST — before the early return
  // below. Doing it after would leave a remembered project selected with no switcher on
  // screen to change it, and the list filtered down to nothing, permanently.
  if (state.activeWorkspace !== "*" && !names.includes(state.activeWorkspace)) {
    state.activeWorkspace = "*";
    forgetWorkspace();
  }
  const container = el(".workspaces");
  const note = el(".ws-note");
  // One project (or none) is not a choice — don't spend a control on it.
  if (names.length <= 1) {
    container.innerHTML = "";
    note.textContent = "";
    state.wsChoices = [];
    return;
  }

  const openTotal = todos.filter((t) => !t.done).length;
  const text = (key: WorkspaceKey): string => (key === "*" ? "All projects" : key === UNFILED ? "Unfiled" : String(key));
  const count = (key: WorkspaceKey): number => (key === "*" ? openTotal : (counts.get(key) ?? 0));
  // Options are addressed by INDEX. A workspace name never enters markup, so no string a
  // peer can store is able to impersonate another entry, and the Symbol above survives.
  state.wsChoices = ["*", ...names];
  const signature = state.wsChoices.map((key, i) => `${i}:${text(key)}:${count(key)}`).join("|");

  let live = container.querySelector<HTMLSelectElement>(".ws-select");
  // Rebuild only when the option set actually changed — and never under an open dropdown,
  // where it would close mid-choice. Comparing rendered HTML did not work: the template
  // writes a bare selected attribute, innerHTML reads it back as selected="", so the strings
  // always differed and the focus check was doing all the work.
  if (!live || (container.dataset.signature !== signature && document.activeElement !== live)) {
    container.innerHTML = `<select class="ws-select" aria-label="Project">${state.wsChoices
      .map((key, i) => `<option value="${i}">${escapeHtml(text(key))} · ${count(key)}</option>`)
      .join("")}</select>`;
    container.dataset.signature = signature;
    live = container.querySelector<HTMLSelectElement>(".ws-select");
  }
  if (!live) return;
  // Pushed onto the live element rather than baked into the HTML, so the selection and the
  // "you are scoped" tint are correct immediately after a pick, not one refresh later.
  live.value = String(state.wsChoices.indexOf(state.activeWorkspace));
  live.dataset.scoped = String(state.activeWorkspace !== "*");

  const elsewhere = todos.filter((t) => !t.done && workspaceOf(t) !== state.activeWorkspace);
  const shownOpen = state.activeWorkspace === "*" ? openTotal : (counts.get(state.activeWorkspace) ?? 0);
  note.textContent =
    shownOpen === 0 && elsewhere.length > 0
      ? `nothing open here — ${elsewhere.length} open in ${new Set(elsewhere.map(workspaceOf)).size} other project(s)`
      : "";
}

function applyTagCounts(todos: Todo[]): void {
  const counts: Record<string, number> = { all: todos.length, todo: 0, backlog: 0 };
  for (const t of todos) counts[t.list] = (counts[t.list] ?? 0) + 1;
  counts.devices = todos.filter(isFromOtherDevice).length;
  for (const tag of ["all", "todo", "backlog", "devices"]) {
    const slot = document.querySelector(`[data-count="${tag}"]`);
    if (slot) slot.textContent = String(counts[tag] ?? 0);
  }
}

/** A card node remembers the HTML it currently shows, so the next pass can skip it unchanged. */
type CardNode = HTMLElement & { __lastHtml?: string };

function nodeFromHtml(html: string): CardNode {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  const node = tpl.content.firstElementChild as CardNode | null;
  if (!node) throw new Error("itemHtml produced no element");
  node.__lastHtml = html;
  return node;
}

/**
 * Keyed list reconciliation instead of innerHTML replacement — a periodic refresh should
 * never cause a visible flicker or lose in-progress state. Only nodes whose rendered HTML
 * actually changed get touched.
 */
function reconcileList(container: HTMLElement, items: Todo[], itemToHtml: (t: Todo) => string, keyOf: (t: Todo) => number): void {
  const existing = new Map<string, CardNode>();
  for (const child of Array.from(container.children)) {
    const node = child as CardNode;
    if (node.dataset?.id) existing.set(node.dataset.id, node);
  }
  let prevNode: CardNode | null = null;
  for (const item of items) {
    const key = String(keyOf(item));
    const html = itemToHtml(item);
    let node = existing.get(key);
    if (!node) {
      node = nodeFromHtml(html);
    } else {
      existing.delete(key);
      // Cards hold no live inputs any more — editing happens in a dialog — so a changed
      // card can always be swapped outright.
      if (node.__lastHtml !== html) {
        const fresh = nodeFromHtml(html);
        node.replaceWith(fresh);
        node = fresh;
      }
    }
    const desiredNext: ChildNode | null = prevNode ? prevNode.nextSibling : container.firstChild;
    if (desiredNext !== node) container.insertBefore(node, desiredNext);
    prevNode = node;
  }
  for (const leftover of existing.values()) leftover.remove();
}

function setEmptyPlaceholder(container: HTMLElement, show: boolean, text: string): void {
  let placeholder = container.querySelector<HTMLElement>("li.empty");
  if (show && !placeholder) {
    placeholder = document.createElement("li");
    placeholder.className = "empty";
    placeholder.style.cssText = "background:none;border:none;padding:10px 4px";
    placeholder.textContent = text;
    container.prepend(placeholder);
  } else if (!show && placeholder) {
    placeholder.remove();
  }
}

export function render(todos: Todo[]): void {
  state.allTodos = todos;
  renderWorkspaceSwitcher(todos);
  // Project scope is applied FIRST, so every count below it — tags, open, done — describes
  // the project you're actually looking at rather than the whole machine.
  const scoped =
    state.activeWorkspace === "*" ? todos : todos.filter((t) => workspaceOf(t) === state.activeWorkspace);
  applyTagCounts(scoped);

  const search = el<HTMLInputElement>(".search").value.trim().toLowerCase();
  const sortMode = el<HTMLSelectElement>(".sort").value;

  let items =
    state.activeTag === "all"
      ? scoped
      : state.activeTag === "devices"
        ? scoped.filter(isFromOtherDevice)
        : scoped.filter((t) => t.list === state.activeTag);
  if (search) {
    items = items.filter(
      (t) =>
        t.title.toLowerCase().includes(search) ||
        (t.description || "").toLowerCase().includes(search) ||
        (t.category || "").toLowerCase().includes(search) ||
        (t.agent || "").toLowerCase().includes(search),
    );
  }

  const open = sortItems(items.filter((t) => !t.done), sortMode);
  const done = sortItems(items.filter((t) => t.done), sortMode === "default" ? "newest" : sortMode);

  // Names the scope in prose. The switcher is one control among three in the toolbar now,
  // so the count line is what tells you at a glance that you are not seeing everything.
  const scope =
    state.activeWorkspace === "*" ? "" : ` in ${state.activeWorkspace === UNFILED ? "Unfiled" : String(state.activeWorkspace)}`;
  el(".open-count").textContent = `${open.length} open${scope}`;

  const openListEl = el(".open-list");
  setEmptyPlaceholder(openListEl, open.length === 0, "Nothing open.");
  reconcileList(openListEl, open, itemHtml, (t) => t.id);
  reconcileList(el(".done-list"), done, itemHtml, (t) => t.id);
  el(".done-count").textContent = `(${done.length})`;
}

export async function refresh(): Promise<void> {
  try {
    render(await fetchTodos());
    state.syncFailed = false;
  } catch (err) {
    console.error("refresh failed", err);
    state.syncFailed = true;
  }
}

/**
 * Quiet by default — the dot alone is enough while things are working. Text only shows up
 * once it is worth knowing: a device sync in flight, a real fetch failure, or no successful
 * poll in the last 30 seconds.
 */
export function tickSyncedLabel(): void {
  const wrap = el(".synced");
  const dot = el(".synced .dot");
  const text = document.getElementById("synced-text");
  if (!text) return;

  if (state.syncingSince) {
    wrap.dataset.state = "syncing";
    text.hidden = false;
    text.textContent =
      state.syncingWith === 1 ? "syncing with 1 device…" : `syncing with ${state.syncingWith} devices…`;
    return;
  }
  wrap.dataset.state = state.syncFailed ? "failed" : "idle";
  if (state.syncFailed) {
    dot.classList.add("fail");
    text.hidden = false;
    text.textContent = "disconnected";
    return;
  }
  dot.classList.remove("fail");
  if (!state.lastSync) {
    text.hidden = false;
    text.textContent = "syncing…";
    return;
  }
  const seconds = Math.round((Date.now() - state.lastSync) / 1000);
  if (seconds < 30) {
    text.hidden = true;
    return;
  }
  text.hidden = false;
  text.textContent = timeAgo(new Date(state.lastSync).toISOString());
}

export function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("docket-theme", theme);
  } catch {}
}

/** Every listener this module owns. Called once, from main.ts — never at import time. */
export function initList(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("docket-theme");
  } catch {}
  applyTheme(stored === "light" ? "light" : "dark");

  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    applyTheme(isDark() ? "light" : "dark");
    void refresh();
  });

  document.addEventListener("change", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLSelectElement) || !target.matches(".ws-select")) return;
    const picked = state.wsChoices[Number(target.value)];
    if (picked === undefined) return;
    state.activeWorkspace = picked;
    rememberWorkspace();
    render(state.allTodos);
  });

  for (const btn of document.querySelectorAll<HTMLElement>(".tag")) {
    btn.addEventListener("click", () => {
      state.activeTag = btn.dataset.tag ?? "all";
      for (const other of document.querySelectorAll<HTMLElement>(".tag")) {
        other.dataset.active = String(other === btn);
      }
      render(state.allTodos);
    });
  }

  el(".sort").addEventListener("change", () => void refresh());
  el(".search").addEventListener("input", () => void refresh());
}
