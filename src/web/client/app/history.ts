import { historyRowsHtml } from "./cards.js";

/**
 * The full audit log for one item, fetched when its panel is opened.
 *
 * An item carries only its last few entries inline (the rest live in history.json.enc, off
 * the write hot path). Those render immediately so the panel is never blank, and are then
 * replaced once the whole log arrives — fetched on open rather than with the list, because
 * history is the unbounded part of an item and the list has to stay cheap.
 */
export async function loadFullHistory(details: HTMLDetailsElement): Promise<void> {
  if (details.dataset.historyLoaded) return;
  details.dataset.historyLoaded = "1";
  try {
    const res = await fetch(`/api/todos/${encodeURIComponent(details.dataset.historyUuid ?? "")}/history`);
    if (!res.ok) return; // keep the inline preview; a missing audit log is not worth an error banner
    const { history } = (await res.json()) as { history?: unknown };
    const rows = details.querySelector(".history-rows");
    if (rows && Array.isArray(history)) rows.innerHTML = historyRowsHtml(history);
  } catch {
    // Offline or mid-reload — the preview is still on screen and still accurate.
    delete details.dataset.historyLoaded;
  }
}

/** Capture phase: `toggle` does not bubble, so a listener on document only sees it here. */
export function watchHistoryPanels(): void {
  document.addEventListener(
    "toggle",
    (e) => {
      const details = e.target;
      if (details instanceof HTMLDetailsElement && details.open && details.dataset.historyUuid) void loadFullHistory(details);
    },
    true,
  );
}
