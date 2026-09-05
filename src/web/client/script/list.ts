/*
 * The list itself — fetching, the project switcher, tag counts, and the reconciler that
 * swaps only the cards whose rendered HTML actually changed, so a background refresh never
 * flickers or steals focus.
 *
 * A TEMPLATE LITERAL, not a module. Everything below is text that becomes the page.
 *
 * Two rules follow from that and there is no compiler to enforce either:
 *  - a literal backtick ends the string. Write \\` , or reword. views.backtick.test.ts
 *    fails with the exact line number when one slips into a comment, which is where it
 *    always happens — a backtick is the natural way to quote an identifier in prose.
 *  - ${...} interpolates. Write \\${ for a dollar-brace that should reach the browser.
 */
export const LIST = `

async function fetchTodos() {
  const res = await fetch("/api/todos");
  if (res.status === 403) {
    // This browser's access was revoked (or never granted) — reload straight to the
    // access-request gate rather than sitting on stale data with a silent "disconnected".
    location.reload();
    return new Promise(() => {}); // never resolves; the reload takes over
  }
  if (!res.ok) throw new Error(\`fetch failed: \${res.status}\`);
  const { todos } = await res.json();
  lastSync = Date.now();
  return todos;
}

let allTodos = [];
let activeTag = "all";
// "*" means every project. Remembered across reloads: with several projects feeding one
// list, re-picking your own on every visit is exactly the friction this tool exists to remove.
/**
 * "No project" is a Symbol, not a string, so nothing a peer or an API caller can put in
 * the workspace field can equal it. Two earlier attempts were strings and both were wrong:
 *
 *  - a NUL prefix, which an HTML parser rewrites to U+FFFD on the way back out, so the
 *    control ended up holding a value no item could match and choosing it did nothing;
 *  - "~unfiled", unreachable only through slugifyWorkspace — which the CLI applies but
 *    the web API and sync do not, so a crafted POST could fold a real project into it.
 *
 * A Symbol has neither problem, and it never reaches markup: the <select> addresses its
 * options by index. localStorage is not markup, so it keeps a plain token.
 */
const UNFILED = Symbol("unfiled");
const UNFILED_STORED = "~unfiled";

let activeWorkspace = (() => {
  try {
    const stored = localStorage.getItem("docket-workspace");
    return stored === UNFILED_STORED ? UNFILED : stored || "*";
  } catch {
    return "*";
  }
})();

function rememberWorkspace() {
  try { localStorage.setItem("docket-workspace", activeWorkspace === UNFILED ? UNFILED_STORED : activeWorkspace); } catch {}
}

function workspaceOf(t) {
  return t.workspace || UNFILED;
}

/** Index → workspace key, parallel to the switcher's <option> list. See below for why. */
let wsChoices = [];

function renderWorkspaceSwitcher(todos) {
  // Counts are of OPEN items — a project finished last month shouldn't shout for attention —
  // but every project that has any item at all still gets a tab, which is what adding zero
  // for a done item buys: the key is created either way.
  const counts = new Map();
  for (const t of todos) {
    const key = workspaceOf(t);
    counts.set(key, (counts.get(key) ?? 0) + (t.done ? 0 : 1));
  }

  const names = [...counts.keys()].sort((a, b) => (a === UNFILED ? 1 : b === UNFILED ? -1 : a.localeCompare(b)));
  // A selection that no longer matches anything is dropped FIRST — before the early return
  // below. Doing it after would leave a remembered project selected with no switcher on
  // screen to change it, and the list filtered down to nothing, permanently.
  if (activeWorkspace !== "*" && !names.includes(activeWorkspace)) {
    activeWorkspace = "*";
    try { localStorage.removeItem("docket-workspace"); } catch {}
  }
  const container = document.querySelector(".workspaces");
  const note = document.querySelector(".ws-note");
  // One project (or none) is not a choice — don't spend a control on it.
  if (names.length <= 1) {
    container.innerHTML = "";
    note.textContent = "";
    wsChoices = [];
    return;
  }

  const openTotal = todos.filter((t) => !t.done).length;
  const text = (key) => (key === "*" ? "All projects" : key === UNFILED ? "Unfiled" : key);
  const count = (key) => (key === "*" ? openTotal : counts.get(key) ?? 0);
  // Options are addressed by INDEX. A workspace name never enters markup, so no string a
  // peer can store is able to impersonate another entry, and the Symbol above survives.
  wsChoices = ["*", ...names];
  const signature = wsChoices.map((key, i) => \`\${i}:\${text(key)}:\${count(key)}\`).join("|");

  let live = container.querySelector(".ws-select");
  // Rebuild only when the option set actually changed — and never under an open dropdown,
  // where it would close mid-choice. Comparing rendered HTML did not work: the template
  // writes a bare selected attribute, innerHTML reads it back as selected="", so the strings
  // always differed and the focus check was doing all the work.
  if (!live || (container.dataset.signature !== signature && document.activeElement !== live)) {
    container.innerHTML = \`<select class="ws-select" aria-label="Project">\${
      wsChoices.map((key, i) => \`<option value="\${i}">\${escapeHtml(text(key))} · \${count(key)}</option>\`).join("")
    }</select>\`;
    container.dataset.signature = signature;
    live = container.querySelector(".ws-select");
  }
  // Pushed onto the live element rather than baked into the HTML, so the selection and the
  // "you are scoped" tint are correct immediately after a pick, not one refresh later.
  live.value = String(wsChoices.indexOf(activeWorkspace));
  live.dataset.scoped = String(activeWorkspace !== "*");

  const elsewhere = todos.filter((t) => !t.done && workspaceOf(t) !== activeWorkspace);
  const shownOpen = activeWorkspace === "*" ? openTotal : (counts.get(activeWorkspace) ?? 0);
  note.textContent =
    shownOpen === 0 && elsewhere.length > 0
      ? \`nothing open here — \${elsewhere.length} open in \${new Set(elsewhere.map(workspaceOf)).size} other project(s)\`
      : "";
}

document.addEventListener("change", (e) => {
  if (!e.target.matches(".ws-select")) return;
  const picked = wsChoices[Number(e.target.value)];
  if (picked === undefined) return;
  activeWorkspace = picked;
  rememberWorkspace();
  render(allTodos);
});

function applyTagCounts(todos) {
  const counts = { all: todos.length, todo: 0, backlog: 0 };
  for (const t of todos) counts[t.list] = (counts[t.list] ?? 0) + 1;
  counts.devices = todos.filter(isFromOtherDevice).length;
  for (const tag of ["all", "todo", "backlog", "devices"]) {
    document.querySelector(\`[data-count="\${tag}"]\`).textContent = counts[tag] ?? 0;
  }
}

// Before loadDeviceInfo() resolves, thisDeviceId is still null — deviceId-tagged items
// briefly show as "other" until then, since we don't yet know which one is "us".
function isFromOtherDevice(t) {
  return !!t.deviceId && t.deviceId !== thisDeviceId;
}

/**
 * Keyed list reconciliation instead of innerHTML replacement — a periodic
 * refresh (every 3s, more often once device-sync is pulling in background
 * changes) should never cause a visible flicker or lose in-progress state.
 * Only nodes whose rendered HTML actually changed get touched; unchanged
 * items are left alone, and a card mid-edit is never overwritten regardless
 * of what the freshly-computed HTML would say.
 */
function nodeFromHtml(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  const node = tpl.content.firstElementChild;
  node.__lastHtml = html; // what this node currently shows, so the next pass can skip it unchanged
  return node;
}

function reconcileList(container, items, itemToHtml, keyOf) {
  const existing = new Map();
  for (const child of Array.from(container.children)) {
    if (child.dataset.id) existing.set(child.dataset.id, child);
  }
  let prevNode = null;
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
    const desiredNext = prevNode ? prevNode.nextSibling : container.firstChild;
    if (desiredNext !== node) container.insertBefore(node, desiredNext);
    prevNode = node;
  }
  for (const leftover of existing.values()) leftover.remove();
}

function setEmptyPlaceholder(container, show, text) {
  let placeholder = container.querySelector("li.empty");
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

function render(todos) {
  allTodos = todos;
  renderWorkspaceSwitcher(todos);
  // Project scope is applied FIRST, so every count below it — tags, open, done — describes
  // the project you're actually looking at rather than the whole machine.
  const scoped = activeWorkspace === "*" ? todos : todos.filter((t) => workspaceOf(t) === activeWorkspace);
  applyTagCounts(scoped);

  const search = document.querySelector(".search").value.trim().toLowerCase();
  const sortMode = document.querySelector(".sort").value;

  let items =
    activeTag === "all" ? scoped : activeTag === "devices" ? scoped.filter(isFromOtherDevice) : scoped.filter((t) => t.list === activeTag);
  if (search) {
    items = items.filter(
      (t) =>
        t.title.toLowerCase().includes(search) ||
        (t.description || "").toLowerCase().includes(search) ||
        (t.category || "").toLowerCase().includes(search) ||
        (t.agent || "").toLowerCase().includes(search)
    );
  }

  const open = sortItems(items.filter((t) => !t.done), sortMode);
  const done = sortItems(items.filter((t) => t.done), sortMode === "default" ? "newest" : sortMode);

  const openListEl = document.querySelector(".open-list");
  const doneListEl = document.querySelector(".done-list");

  // Names the scope in prose. The switcher is one control among three in the toolbar now,
  // so the count line is what tells you at a glance that you are not seeing everything.
  const scope = activeWorkspace === "*" ? "" : \` in \${activeWorkspace === UNFILED ? "Unfiled" : activeWorkspace}\`;
  document.querySelector(".open-count").textContent = \`\${open.length} open\${scope}\`;
  setEmptyPlaceholder(openListEl, open.length === 0, "Nothing open.");
  reconcileList(openListEl, open, itemHtml, (t) => t.id);
  reconcileList(doneListEl, done, itemHtml, (t) => t.id);
  document.querySelector(".done-count").textContent = \`(\${done.length})\`;
}

let syncFailed = false;
/*
 * Set from the server's own SSE "sync" event, not guessed from our polling — the device
 * sync runs in the server process on its own interval, and the browser has no other way to
 * know it is happening. syncingSince also gates a minimum on-screen time, so a sync that
 * finishes in 40ms does not strobe the header.
 */
let syncingSince = null;
let syncingWith = 0;

async function refresh() {
  try {
    render(await fetchTodos());
    syncFailed = false;
  } catch (err) {
    console.error("refresh failed", err);
    syncFailed = true;
  }
}

// Quiet by default — the dot alone is enough while things are working. Text only
// shows up once it's actually worth knowing: a real fetch failure (immediately), or
// no successful sync in the last 30s (normal polling is every 3s, so that gap means
// something's actually stuck, not just between polls).
function tickSyncedLabel() {
  const wrap = document.querySelector(".synced");
  const dot = document.querySelector(".synced .dot");
  const el = document.getElementById("synced-text");
  if (syncingSince) {
    wrap.dataset.state = "syncing";
    el.hidden = false;
    el.textContent = syncingWith === 1 ? "syncing with 1 device…" : \`syncing with \${syncingWith} devices…\`;
    return;
  }
  wrap.dataset.state = syncFailed ? "failed" : "idle";
  if (syncFailed) {
    dot.classList.add("fail");
    el.hidden = false;
    el.textContent = "disconnected";
    return;
  }
  dot.classList.remove("fail");
  if (!lastSync) {
    el.hidden = false;
    el.textContent = "syncing…";
    return;
  }
  const s = Math.round((Date.now() - lastSync) / 1000);
  if (s < 30) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = timeAgo(new Date(lastSync).toISOString());
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("docket-theme", theme); } catch {}
}

(function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem("docket-theme"); } catch {}
  applyTheme(stored === "light" ? "light" : "dark");
})();

document.getElementById("theme-toggle").addEventListener("click", () => {
  applyTheme(isDark() ? "light" : "dark");
  refresh();
});

document.querySelectorAll(".tag").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTag = btn.dataset.tag;
    document.querySelectorAll(".tag").forEach((b) => (b.dataset.active = String(b === btn)));
    render(allTodos);
  });
});

`;
