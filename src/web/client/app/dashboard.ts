import { getDigest, listDigests } from "./api.js";
import { digestBodyHtml, emptyDashboardHtml, glanceHtml, linkedTodos, timelineHtml, todoFromItem } from "./digest-view.js";
import { byId } from "./dom.js";
import { refresh } from "./list.js";
import { showToast } from "./modals.js";
import { state } from "./state.js";
import { UNFILED, type Digest, type DigestItem, type DigestSummary } from "./types.js";

/**
 * The dashboard view and the two-page routing around it.
 *
 * `/` is the dashboard, `/tasks` is the list that used to be the whole page. Both are the
 * same document — the server answers both paths with it — and switching is a pushState and
 * a `data-view` attribute on <body>, so the list keeps its scroll, filters and open dialogs
 * when you look away and back.
 */

export type View = "dash" | "tasks";

const dash = {
  /** The timeline: one light row per digest, newest first. */
  summaries: [] as DigestSummary[],
  /** Full digests by uuid. A digest never changes once published, so an entry here is
   *  never stale — only ever missing — and is fetched once per page load. */
  full: new Map<string, Digest>(),
  /** Which digest is open; null means "the newest one", so a fresh digest takes over the view. */
  selected: null as string | null,
  loaded: false,
  failed: false,
  /** Delete is two clicks: the first arms the button for a few seconds. */
  armedDelete: null as string | null,
  /** Items whose "+ task" request is in flight, so a re-render can't re-enable the button. */
  adding: new Set<string>(),
  /** What the two columns last held. The page refreshes every 15 seconds and on every SSE
   *  update; rewriting identical markup would collapse an open "show more", drop focus and
   *  text selection, and reset hover — for nothing. */
  lastMain: "",
  lastSide: "",
};

export function viewFromPath(pathname: string): View {
  return pathname.replace(/\/+$/, "") === "/tasks" ? "tasks" : "dash";
}

export function currentView(): View {
  return document.body.dataset.view === "tasks" ? "tasks" : "dash";
}

export function showView(view: View, { push = false }: { push?: boolean } = {}): void {
  document.body.dataset.view = view;
  for (const tab of document.querySelectorAll<HTMLElement>("[data-nav-tab]")) {
    tab.setAttribute("aria-current", String(tab.dataset.navTab === view));
  }
  document.title = view === "tasks" ? "Docket — Tasks" : "Docket";
  if (push) {
    const path = view === "tasks" ? "/tasks" : "/";
    if (location.pathname !== path) history.pushState({ view }, "", path);
    window.scrollTo({ top: 0 });
  }
  if (view === "dash") renderDashboard();
}

function selectedUuid(): string | null {
  if (dash.selected && dash.summaries.some((d) => d.uuid === dash.selected)) return dash.selected;
  return dash.summaries[0]?.uuid ?? null;
}

function paint(element: HTMLElement, html: string, key: "lastMain" | "lastSide"): void {
  if (dash[key] === html) return;
  dash[key] = html;
  element.innerHTML = html;
}

export function renderDashboard(): void {
  const main = byId("dash-main");
  const side = byId("dash-side");
  const uuid = selectedUuid();
  const current = uuid ? dash.full.get(uuid) : undefined;

  let mainHtml: string;
  if (!dash.loaded || (uuid && !current)) {
    mainHtml = dash.failed ? `<p class="dg-empty-note">Couldn't load digests — retrying.</p>` : `<div class="dg-skeleton"></div><div class="dg-skeleton short"></div>`;
  } else if (current) {
    mainHtml = digestBodyHtml(current, linkedTodos(state.allTodos), Date.now(), dash.adding);
  } else {
    mainHtml = emptyDashboardHtml();
  }
  paint(main, mainHtml, "lastMain");
  paint(side, glanceHtml(state.allTodos) + timelineHtml(dash.summaries, uuid), "lastSide");

  if (current && dash.armedDelete === current.uuid) {
    const btn = main.querySelector<HTMLElement>("[data-delete-digest]");
    if (btn) {
      btn.dataset.armed = "true";
      btn.textContent = "Confirm delete";
    }
  } else {
    const btn = main.querySelector<HTMLElement>("[data-delete-digest][data-armed]");
    if (btn) {
      delete btn.dataset.armed;
      btn.textContent = "Delete";
    }
  }
}

/** Fetches the full digest the view needs, if it isn't held yet. */
async function ensureSelectedLoaded(): Promise<void> {
  const uuid = selectedUuid();
  if (!uuid || dash.full.has(uuid)) return;
  const { digest } = await getDigest(uuid);
  dash.full.set(uuid, digest);
}

/** Refreshes the data only; the caller renders, so one refresh is one paint. */
export async function refreshDigests(): Promise<void> {
  try {
    const { digests } = await listDigests();
    dash.summaries = digests;
    const live = new Set(digests.map((d) => d.uuid));
    for (const uuid of dash.full.keys()) if (!live.has(uuid)) dash.full.delete(uuid);
    await ensureSelectedLoaded();
    dash.loaded = true;
    dash.failed = false;
  } catch (err) {
    console.error("digests refresh failed", err);
    dash.failed = true;
  }
}

function findItem(key: string): { digest: Digest; item: DigestItem } | null {
  const [uuid, s, i] = key.split(":");
  const digest = dash.full.get(uuid);
  const item = digest?.sections[Number(s)]?.items[Number(i)];
  return digest && item ? { digest, item } : null;
}

function activeWorkspace(): string | null {
  return state.activeWorkspace === "*" || state.activeWorkspace === UNFILED ? null : String(state.activeWorkspace);
}

async function addTask(key: string): Promise<void> {
  const found = findItem(key);
  if (!found || dash.adding.has(key)) return;
  dash.adding.add(key);
  renderDashboard();
  const res = await fetch("/api/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(todoFromItem(found.item, found.digest, activeWorkspace())),
  }).catch(() => null);
  if (!res || !res.ok) {
    dash.adding.delete(key);
    renderDashboard();
    showToast("Couldn't add the task.");
    return;
  }
  showToast(`Added to Tasks: ${found.item.title}`);
  await refresh();
  // Only now: until the list holds the new task, the row cannot show "in tasks", and
  // releasing the key earlier would put a live "+ task" button back for a moment.
  dash.adding.delete(key);
  renderDashboard();
}

async function deleteSelected(uuid: string): Promise<void> {
  if (dash.armedDelete !== uuid) {
    dash.armedDelete = uuid;
    renderDashboard();
    window.setTimeout(() => {
      if (dash.armedDelete !== uuid) return;
      dash.armedDelete = null;
      renderDashboard();
    }, 4000);
    return;
  }
  dash.armedDelete = null;
  const res = await fetch(`/api/digests/${encodeURIComponent(uuid)}`, { method: "DELETE" }).catch(() => null);
  if (!res || !res.ok) {
    renderDashboard();
    showToast("Couldn't delete the digest.");
    return;
  }
  if (dash.selected === uuid) dash.selected = null;
  showToast("Digest deleted on every synced device.");
  await refreshDigests();
  renderDashboard();
}

async function select(uuid: string): Promise<void> {
  dash.selected = uuid;
  dash.armedDelete = null;
  renderDashboard(); // the timeline highlight moves at once; the body follows when loaded
  try {
    await ensureSelectedLoaded();
  } catch (err) {
    console.error("digest load failed", err);
    showToast("Couldn't load that digest.");
  }
  renderDashboard();
  byId("dash-main").scrollIntoView({ block: "start", behavior: "smooth" });
}

export function initDashboard(): void {
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    // Internal navigation: the two pages are one document.
    const nav = target.closest<HTMLAnchorElement>("a[data-nav]");
    if (nav && !(e instanceof MouseEvent && (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0))) {
      e.preventDefault();
      showView(nav.dataset.nav === "tasks" ? "tasks" : "dash", { push: true });
      return;
    }

    const pick = target.closest<HTMLElement>("[data-digest]");
    if (pick?.dataset.digest) {
      void select(pick.dataset.digest);
      return;
    }

    const add = target.closest<HTMLButtonElement>("button[data-digest-item]");
    if (add?.dataset.digestItem) {
      void addTask(add.dataset.digestItem);
      return;
    }

    const del = target.closest<HTMLElement>("[data-delete-digest]");
    if (del?.dataset.deleteDigest) {
      void deleteSelected(del.dataset.deleteDigest);
      return;
    }

    const copy = target.closest<HTMLElement>("button[data-copy]");
    if (copy && copy.closest(".dg-hero")) {
      void navigator.clipboard?.writeText(copy.dataset.copy ?? "").then(() => showToast(`Copied ${copy.dataset.copy}`));
    }
  });

  // Fires for the hero's "N need you" anchor too, which changes only the hash. Re-showing
  // the same view there would be a pointless re-render under the scroll it just did.
  window.addEventListener("popstate", () => {
    const view = viewFromPath(location.pathname);
    if (view !== currentView()) showView(view);
  });
}
