import { UNFILED, type Todo, type WorkspaceKey } from "./types.js";

/**
 * The client's shared mutable state.
 *
 * It used to be a handful of top-level `let`s in one 1,676-line script, which worked only
 * because everything shared one lexical scope. Real modules do not, so the state that
 * genuinely IS shared lives here, in one object, where it can be typed and where the list
 * of what the dashboard remembers is readable in one screen.
 *
 * Nothing here runs at import time — no DOM, no localStorage. That is what lets the pure
 * rendering modules import this and still be importable by a test in plain Node.
 */
export const state = {
  /** Everything the last fetch returned, unfiltered. Every render derives from this. */
  allTodos: [] as Todo[],

  /** Which list filter is selected: "all" | "todo" | "backlog" | "devices". */
  activeTag: "all",

  /** "*" means every project. */
  activeWorkspace: "*" as WorkspaceKey,
  /** Index → workspace key, parallel to the switcher's <option> list. */
  wsChoices: [] as WorkspaceKey[],

  /** The item the edit dialog holds, if any. Also the flag that suppresses background
   *  refreshes, so an SSE update never lands under someone's cursor. */
  editingId: null as number | null,
  /** The item the detail dialog holds, if any. */
  viewingId: null as number | null,

  /** When the last successful /api/todos fetch landed, for the "synced 4m ago" label. */
  lastSync: null as number | null,
  syncFailed: false,
  /** Set from the server's own SSE "sync" event — the device sync runs in the server
   *  process, and the browser has no other way to know one is in flight. */
  syncingSince: null as number | null,
  syncingWith: 0,

  /** This browser's own device id, once /api/device has answered. Until then, deviceId-tagged
   *  items briefly read as "from another device", because we do not yet know which one is us. */
  thisDeviceId: null as string | null,
  isHostBrowser: false,
};

const WORKSPACE_KEY = "docket-workspace";
/** How the Symbol is written down. localStorage is not markup, so a plain token is safe here. */
const UNFILED_STORED = "~unfiled";

/** Called at boot, not at import: a module that reads localStorage on load cannot be imported by a test. */
export function restoreWorkspace(): void {
  try {
    const stored = localStorage.getItem(WORKSPACE_KEY);
    state.activeWorkspace = stored === UNFILED_STORED ? UNFILED : stored || "*";
  } catch {
    state.activeWorkspace = "*";
  }
}

export function rememberWorkspace(): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, state.activeWorkspace === UNFILED ? UNFILED_STORED : String(state.activeWorkspace));
  } catch {
    // Private window, or site data blocked. The choice simply does not survive a reload.
  }
}

export function forgetWorkspace(): void {
  try {
    localStorage.removeItem(WORKSPACE_KEY);
  } catch {}
}

export function workspaceOf(todo: Pick<Todo, "workspace">): WorkspaceKey {
  return todo.workspace || UNFILED;
}

/**
 * Before /api/device answers, thisDeviceId is null and every deviceId-tagged item reads as
 * "other". That is the safe direction: showing one of your own items with a device badge for
 * a moment is noise, whereas hiding a peer's item would be a lie about where work came from.
 */
export function isFromOtherDevice(todo: Pick<Todo, "deviceId">): boolean {
  return !!todo.deviceId && todo.deviceId !== state.thisDeviceId;
}
