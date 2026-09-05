import { initAddForm } from "./addform.js";
import { byId, el } from "./dom.js";
import { initDevices, loadDeviceInfo, pollNotifications } from "./devices.js";
import { watchHistoryPanels } from "./history.js";
import { initList, refresh, tickSyncedLabel } from "./list.js";
import { copyShortId, initModals, openEditModal, openItemModal, showUndoToast } from "./modals.js";
import { initPairingUi } from "./pairing-ui.js";
import { restoreWorkspace, state } from "./state.js";

/**
 * The entry point the page loads, and the only module with side effects at import time.
 *
 * Everything else exports an `init…()` that this file calls, so importing any other module
 * — in a test, say — costs nothing and touches nothing. That is the difference between this
 * and the 1,676-line script it replaced, where merely evaluating the code wired up two dozen
 * listeners and started four timers.
 */

/** One delegated handler for the whole list: cards are replaced constantly by the reconciler. */
function initCardActions(): void {
  el(".page").addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const li = target.closest<HTMLElement>("li[data-id]");
    if (!li) return;
    const id = Number(li.dataset.id);

    if (target.matches("button.del")) {
      const found = state.allTodos.find((t) => t.id === id);
      const res = await fetch(`/api/todos/${id}`, { method: "DELETE" });
      if (res.ok && found) showUndoToast(found);
      void refresh();
    } else if (target instanceof HTMLInputElement && target.matches("input[type=checkbox]") && !target.disabled) {
      await fetch(`/api/todos/${id}/complete`, { method: "POST" });
      void refresh();
    } else if (target.closest("button.id")) {
      void copyShortId(target.closest<HTMLElement>("button.id")!);
    } else if (target.matches("button.edit")) {
      openEditModal(id);
    } else if (target.matches(".card-title") || target.matches(".read-more")) {
      openItemModal(id);
    } else if (target.matches(".badge") && target.dataset.category) {
      // Reuse the existing search box as the "browse by project" filter, instead of
      // adding another permanent tag/tab for something with unbounded cardinality.
      const searchInput = el<HTMLInputElement>(".search");
      searchInput.value = target.dataset.category;
      searchInput.dispatchEvent(new Event("input"));
      searchInput.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
}

async function loadVersionFooter(): Promise<void> {
  const footer = byId("version-footer");
  try {
    const v = (await (await fetch("/api/version")).json()) as { formatVersion: number; pid: number; startedAt: string };
    const started = new Date(v.startedAt).toLocaleString();
    footer.textContent = `Docket · format v${v.formatVersion} · pid ${v.pid} · started ${started}`;
  } catch {
    footer.textContent = "version unavailable";
  }
}

interface SyncEventDetail {
  phase: "start" | "end";
  peers?: number;
  ok?: boolean;
}

function setupEvents(): void {
  if (!window.EventSource) return;
  try {
    const es = new EventSource("/api/events");
    es.addEventListener("update", () => {
      if (state.editingId === null) void refresh();
    });
    // The device sync runs on the server's own interval, in the server's process. This is
    // the only signal the browser gets that one is in flight.
    es.addEventListener("sync", (e) => {
      let detail: SyncEventDetail;
      try {
        detail = JSON.parse((e as MessageEvent<string>).data) as SyncEventDetail;
      } catch {
        return;
      }
      if (detail.phase === "start") {
        state.syncingSince = Date.now();
        state.syncingWith = detail.peers || 0;
        tickSyncedLabel();
        return;
      }
      // Hold the spinner briefly: a sync with one nearby peer can finish in under 50ms, and
      // a 50ms flash reads as a glitch rather than as progress.
      const shown = Date.now() - (state.syncingSince || Date.now());
      window.setTimeout(() => {
        state.syncingSince = null;
        if (detail.ok) state.lastSync = Date.now();
        state.syncFailed = !detail.ok;
        tickSyncedLabel();
      }, Math.max(0, 450 - shown));
    });
  } catch {
    // No SSE (a proxy that buffers, an old browser) — the polling fallback below still runs.
  }
}

function start(): void {
  restoreWorkspace();
  initList();
  initModals();
  initDevices();
  initPairingUi();
  initAddForm();
  initCardActions();
  watchHistoryPanels();

  void loadVersionFooter();
  setupEvents();
  void refresh();

  // Fallback for a dropped SSE connection; skipped while a dialog holds unsaved input.
  window.setInterval(() => {
    if (state.editingId === null) void refresh();
  }, 15_000);
  window.setInterval(tickSyncedLabel, 1_000);

  void loadDeviceInfo().then(() => pollNotifications());
  window.setInterval(() => {
    // The open modal runs its own poll, so this one stays out of its way.
    if (!byId<HTMLDialogElement>("devices-panel").open) void pollNotifications();
  }, 8_000);
}

start();
