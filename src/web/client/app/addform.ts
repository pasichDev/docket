import { el } from "./dom.js";
import { refresh } from "./list.js";
import { state } from "./state.js";
import { UNFILED } from "./types.js";

/**
 * The "+ Add item" form under the list — the one place the dashboard creates a todo itself
 * rather than watching an agent create one.
 */

const addToggle = el(".add-toggle");
const addForm = el<HTMLFormElement>(".add-form");
let addFormList = "todo";


/** Every listener this module owns. Called once, from main.ts — never at import time. */
export function initAddForm(): void {
  document.querySelectorAll<HTMLElement>(".list-picker button").forEach((btn) => {
    btn.addEventListener("click", () => {
      addFormList = btn.dataset.value ?? "todo";
      document.querySelectorAll<HTMLElement>(".list-picker button").forEach((b) => (b.dataset.active = String(b === btn)));
    });
  });

  addToggle.addEventListener("click", () => {
    addForm.classList.add("open");
    addToggle.style.display = "none";
    el<HTMLInputElement>(".title", addForm).focus();
  });

  function closeAddForm(): void {
    addForm.classList.remove("open");
    addToggle.style.display = "";
    addForm.reset();
    addFormList = "todo";
    document.querySelectorAll<HTMLElement>(".list-picker button").forEach((b) => (b.dataset.active = String(b.dataset.value === "todo")));
  }

  el(".cancel", addForm).addEventListener("click", closeAddForm);

  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = el<HTMLInputElement>(".title", addForm).value.trim();
    if (!title) return;
    const description = el<HTMLTextAreaElement>(".description", addForm).value.trim() || undefined;
    const category = el<HTMLInputElement>(".category", addForm).value.trim() || undefined;
    const priority = el<HTMLSelectElement>(".priority", addForm).value || undefined;
    const dueDate = el<HTMLInputElement>(".due", addForm).value || undefined;
    const sourceUrl = el<HTMLInputElement>(".source-url", addForm).value.trim() || undefined;
    await fetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // File into whichever project the switcher is on. Without this, typing a todo while a
      // project is selected files it Unfiled and it disappears from the list it was typed
      // into. "All" and "Unfiled" both mean "no project", which is what null says.
      body: JSON.stringify({
        title,
        description,
        list: addFormList,
        category,
        priority,
        dueDate,
        sourceUrl,
        workspace: state.activeWorkspace === "*" || state.activeWorkspace === UNFILED ? null : String(state.activeWorkspace),
      }),
    });
    closeAddForm();
    void refresh();
  });
}
