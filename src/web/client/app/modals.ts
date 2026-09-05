import { editFormHtml, historyHtml, itemIdButton, sourceLinkHtml } from "./cards.js";
import { closeOnBackdropClick } from "./devices.js";
import { byId, el } from "./dom.js";
import { refresh } from "./list.js";
import { clampMarkdown, renderMarkdown } from "./markdown.js";
import { isFromOtherDevice, state } from "./state.js";
import type { Todo } from "./types.js";
import { agentColor, categoryTint, escapeHtml, isOverdue } from "./util.js";

/**
 * Item detail and edit dialogs, the markdown editor inside the second one, clipboard
 * handling, and the toast.
 */


/* ---- item detail and edit modals ------------------------------------------------------
 * Both read the item out of allTodos at open time rather than keeping their own copy, so
 * neither can show something the list has already replaced.
 */
const itemPanel = byId<HTMLDialogElement>("item-panel");
const editPanel = byId<HTMLDialogElement>("edit-panel");

const findTodo = (id: number | null): Todo | null => state.allTodos.find((t) => t.id === id) ?? null;

export function openItemModal(id: number | null): void {
  const t = findTodo(id);
  if (!t) return;
  state.viewingId = id;
  // textContent, not innerHTML: the title is the one field shown outside the escaping path.
  byId("item-panel-title").textContent = t.title;

  const tint = categoryTint(t.category);
  const meta = [];
  if (t.category && tint) meta.push(`<span class="badge" style="background:${tint.chipBg}; color:${tint.chipText}">${escapeHtml(t.category)}</span>`);
  meta.push(`<span class="list-badge ${t.list}"><span class="dot"></span>${t.list === "todo" ? "Todo" : "Backlog"}</span>`);
  if (t.priority) meta.push(`<span class="via"><span class="priority-flag ${t.priority}"></span>${escapeHtml(t.priority)} priority</span>`);
  if (t.dueDate) meta.push(`<span class="due ${isOverdue(t) ? "overdue" : ""}">${isOverdue(t) ? "overdue " : ""}${escapeHtml(t.dueDate)}</span>`);
  // Unlike the card, the modal shows "via web" too — here you asked for the whole item.
  if (t.agent) meta.push(`<span class="via"><span class="adot" style="background:${agentColor(t.agent)}"></span>via ${escapeHtml(t.agent)}${t.session ? ` <span class="session">#${escapeHtml(t.session)}</span>` : ""}</span>`);
  if (isFromOtherDevice(t)) meta.push(`<span class="device-badge">📱 ${escapeHtml(t.deviceName || "other device")}</span>`);
  meta.push(itemIdButton(t));
  byId("item-panel-meta").innerHTML = meta.join("");

  byId("item-panel-body").innerHTML = t.description
    ? renderMarkdown(t.description)
    : '<div class="item-panel-empty">No description.</div>';
  byId("item-panel-extra").innerHTML = sourceLinkHtml(t.sourceUrl) + historyHtml(t);
  if (!itemPanel.open) itemPanel.showModal();
}

export function openEditModal(id: number | null): void {
  const t = findTodo(id);
  if (!t) {
    showToast("That item is no longer here.");
    return;
  }
  state.editingId = id;
  byId("edit-panel-subtitle").textContent =
    `#${t.id} · ${t.shortId}` + (t.agent ? ` · created via ${t.agent}` : "");
  byId("edit-panel-form").innerHTML = editFormHtml(t);
  editSnapshot = editFormState();
  if (itemPanel.open) itemPanel.close();
  if (!editPanel.open) editPanel.showModal();
  editPanel.querySelector<HTMLInputElement>("input.title")?.focus();
}

/*
 * Everything typed into this dialog is unsaved until Save, and a dialog is far easier to
 * dismiss by accident than the inline form it replaced: Escape, a backdrop click, or a
 * drag-select that happens to end past the dialog's edge all reach close(). So the exits
 * ask first, and only when there is actually something to lose.
 */
const EDIT_FIELDS = ["title", "description", "category", "priority", "due", "source-url"] as const;
let editSnapshot = "";

function editFormState(): string {
  const form = editPanel.querySelector(".edit-form");
  if (!form) return "";
  return JSON.stringify(EDIT_FIELDS.map((cls) => form.querySelector<HTMLInputElement>("." + cls)?.value ?? ""));
}

const editIsDirty = () => editPanel.open && editFormState() !== editSnapshot;
const confirmDiscard = () => confirm("Discard your changes to this item?");

// One cleanup path for both ways out — the button and Escape — so neither can leave
// editingId set and refreshes suppressed forever.


const toast = byId("toast");
const toastText = byId("toast-text");
const toastUndo = byId("toast-undo");
let toastTimer: number | null = null;
let lastDeleted: Todo | null = null;

export function showToast(text: string, { undo = false }: { undo?: boolean } = {}): void {
  // A dialog opened with showModal() lives in the top layer, which paints above every
  // z-indexed element AND above the toast's own stacking context — so a toast raised from
  // inside a modal (copying an id, "that item is gone") would sit behind the dimmed
  // backdrop, invisible. Moving the node into the open dialog puts it back on top.
  const host = document.querySelector("dialog[open]") || document.body;
  if (toast.parentElement !== host) host.appendChild(toast);

  // A plain toast replacing a pending undo also ends the undo: leaving lastDeleted set
  // behind a hidden button is an undo that exists in state and nowhere on screen.
  if (!undo) lastDeleted = null;
  toastText.textContent = text;
  toastUndo.hidden = !undo;
  toast.classList.add("show");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
    if (!undo) return;
    lastDeleted = null; // the window is over; state and affordance expire together
  }, undo ? 6000 : 2600);
}

export function showUndoToast(deletedTodo: Todo): void {
  lastDeleted = deletedTodo;
  const shown = deletedTodo.title.slice(0, 40) + (deletedTodo.title.length > 40 ? "…" : "");
  showToast(`Deleted "${shown}"`, { undo: true });
}


/**
 * navigator.clipboard exists only on a secure origin. localhost is one; a phone reaching
 * http://192.168.x.x is not — and that is a first-class way to use Docket, so the old
 * execCommand path is the fallback rather than an afterthought.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.cssText = "position:fixed;top:0;left:-9999px";
    // Inside the open dialog, not on <body>: showModal() makes everything outside the
    // dialog inert, so a scratch node on the body cannot be selected and the copy silently
    // fails — on exactly the non-secure origin (a phone on the LAN) this path exists for.
    (document.querySelector("dialog[open]") || document.body).appendChild(scratch);
    scratch.select();
    const copied = document.execCommand("copy");
    scratch.remove();
    return copied;
  } catch {
    return false;
  }
}

export async function copyShortId(button: HTMLElement): Promise<void> {
  const value = button.dataset.copy ?? "";
  const copied = await copyText(value);
  showToast(copied ? `Copied ${value}` : `Couldn't copy — the id is ${value}`);
}

/** Every listener this module owns. Called once, from main.ts — never at import time. */
export function initModals(): void {
  itemPanel.addEventListener("close", () => { state.viewingId = null; });
  // Cancel, Escape and a backdrop click all land here. The refresh is for THOSE paths: the
  // list may have moved on while the dialog held the screen, and refreshes were suppressed
  // the whole time it was open. The save path refreshes itself, above.
  editPanel.addEventListener("close", () => {
    state.editingId = null;
    byId("edit-panel-form").innerHTML = "";
    void refresh();
  });
  const closeItemModal = () => { if (itemPanel.open) itemPanel.close(); };
  // force: the save path, which has already persisted the very changes the guard asks about.
  const closeEditModal = ({ force = false } = {}) => {
    if (!editPanel.open) return;
    if (!force && editIsDirty() && !confirmDiscard()) return;
    editSnapshot = editFormState(); // the cancel handler must not ask a second time
    editPanel.close();
  };

  // Escape reaches the dialog directly, so it gets the same guard — "cancel" is preventable,
  // "close" is not.
  editPanel.addEventListener("cancel", (e) => {
    if (editIsDirty() && !confirmDiscard()) e.preventDefault();
  });

  byId("item-modal-close").addEventListener("click", closeItemModal);
  byId("item-panel-dismiss").addEventListener("click", closeItemModal);
  byId("item-panel-edit").addEventListener("click", () => openEditModal(state.viewingId));
  byId("edit-modal-close").addEventListener("click", () => closeEditModal());
  closeOnBackdropClick(itemPanel, closeItemModal);
  closeOnBackdropClick(editPanel, () => closeEditModal());

  /* ---- markdown editor ------------------------------------------------------------------ */
  const MD_WRAP: Record<string, { before: string; after: string; sample: string } | undefined> = {
    bold: { before: "**", after: "**", sample: "bold text" },
    italic: { before: "*", after: "*", sample: "italic text" },
    code: { before: "`", after: "`", sample: "code" },
    link: { before: "[", after: "](https://)", sample: "text" },
  };
  const MD_PREFIX: Record<string, string | undefined> = { bullet: "- ", heading: "## " };

  function applyMarkdown(textarea: HTMLTextAreaElement | null, kind: string): void {
    if (!textarea) return;
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const prefix = MD_PREFIX[kind];
    if (prefix) {
      // Line prefixes apply to every selected line, and toggle off if they are already there.
      const from = value.lastIndexOf("\n", start - 1) + 1;
      const nextBreak = value.indexOf("\n", end);
      const to = nextBreak === -1 ? value.length : nextBreak;
      const block = value.slice(from, to).split("\n")
        .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : prefix + line))
        .join("\n");
      textarea.value = value.slice(0, from) + block + value.slice(to);
      textarea.setSelectionRange(from, from + block.length);
    } else {
      const wrap = MD_WRAP[kind];
      if (!wrap) return;
      const selected = value.slice(start, end) || wrap.sample;
      textarea.value = value.slice(0, start) + wrap.before + selected + wrap.after + value.slice(end);
      // Leave the caret on the text rather than past the closing marker: typing is what comes next.
      textarea.setSelectionRange(start + wrap.before.length, start + wrap.before.length + selected.length);
    }
    textarea.focus();
  }

  function setEditorMode(editor: HTMLElement, mode: string): void {
    editor.dataset.mode = mode;
    for (const tab of editor.querySelectorAll<HTMLElement>(".md-tab")) tab.dataset.active = String(tab.dataset.mode === mode);
    if (mode !== "preview") return;
    const source = el<HTMLTextAreaElement>("textarea.description", editor).value;
    el(".md-preview", editor).innerHTML = source.trim()
      ? renderMarkdown(source)
      : '<div class="item-panel-empty">Nothing to preview yet.</div>';
  }

  editPanel.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const tab = target.closest<HTMLElement>(".md-tab");
    if (tab) {
      const editor = tab.closest<HTMLElement>(".md-editor");
      if (editor) setEditorMode(editor, tab.dataset.mode ?? "write");
      return;
    }
    const apply = target.closest<HTMLElement>(".md-apply");
    if (apply) {
      applyMarkdown(editPanel.querySelector<HTMLTextAreaElement>("textarea.description"), apply.dataset.md ?? "");
      return;
    }
    if (target.closest("button.cancel-edit")) closeEditModal();
  });

  editPanel.addEventListener("keydown", (e) => {
    if (!e.metaKey && !e.ctrlKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      editPanel.querySelector<HTMLFormElement>(".edit-form")?.requestSubmit();
      return;
    }
    const target = e.target;
    if (!(target instanceof HTMLTextAreaElement) || !target.matches("textarea.description")) return;
    const kind: string | undefined = { b: "bold", i: "italic", k: "link" }[e.key.toLowerCase() as "b" | "i" | "k"];
    if (!kind) return;
    e.preventDefault();
    applyMarkdown(target, kind);
  });

  editPanel.addEventListener("submit", async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.matches(".edit-form")) return;
    e.preventDefault();
    const id = Number(form.dataset.id);
    const title = el<HTMLInputElement>(".title", form).value.trim();
    if (!title) return;
    await fetch(`/api/todos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: el<HTMLTextAreaElement>(".description", form).value.trim(),
        category: el<HTMLInputElement>(".category", form).value.trim(),
        priority: el<HTMLSelectElement>(".priority", form).value,
        dueDate: el<HTMLInputElement>(".due", form).value,
        sourceUrl: el<HTMLInputElement>(".source-url", form).value.trim(),
      }),
    });
    // Refresh explicitly rather than leaning on the dialog's close event. The list has to
    // show what was just saved, and making that a side effect of "the dialog happened to
    // close" is one indirection too many for the one path where it actually matters.
    closeEditModal({ force: true });
    void refresh();
  });

  itemPanel.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const idButton = target.closest<HTMLElement>("button.id");
    if (idButton) void copyShortId(idButton);
  });


  toastUndo.addEventListener("click", async () => {
    if (!lastDeleted) return;
    toast.classList.remove("show");
    if (toastTimer !== null) clearTimeout(toastTimer);
    const t = lastDeleted;
    lastDeleted = null;
    await fetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: t.title,
        description: t.description || undefined,
        list: t.list,
        category: t.category || undefined,
        priority: t.priority || undefined,
        dueDate: t.dueDate || undefined,
        sourceUrl: t.sourceUrl || undefined,
      }),
    });
    refresh();
  });
}
