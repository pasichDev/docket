/*
 * Item detail and edit dialogs, the markdown editor that lives in the second one, clipboard
 * handling, the toast, the add form — and the bootstrap lines at the very bottom that start
 * everything polling.
 *
 * A TEMPLATE LITERAL, not a module. Everything below is text that becomes the page.
 *
 * Two rules follow from that and there is no compiler to enforce either:
 *  - a literal backtick ends the string. Write \\` , or reword. views.backtick.test.ts
 *    fails with the exact line number when one slips into a comment, which is where it
 *    always happens — a backtick is the natural way to quote an identifier in prose.
 *  - ${...} interpolates. Write \\${ for a dollar-brace that should reach the browser.
 */
export const MODALS = `
/* ---- item detail and edit modals ------------------------------------------------------
 * Both read the item out of allTodos at open time rather than keeping their own copy, so
 * neither can show something the list has already replaced.
 */
const itemPanel = document.getElementById("item-panel");
const editPanel = document.getElementById("edit-panel");
let viewingId = null;

const findTodo = (id) => allTodos.find((t) => t.id === id) || null;

function itemIdButton(t) {
  return \`<button class="id" type="button" data-copy="\${escapeHtml(t.shortId)}" title="Copy \${escapeHtml(t.shortId)} — the cross-device id, identical on every paired device (unlike #\${t.id})">#\${t.id} · \${escapeHtml(t.shortId)}<svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>\`;
}

function openItemModal(id) {
  const t = findTodo(id);
  if (!t) return;
  viewingId = id;
  // textContent, not innerHTML: the title is the one field shown outside the escaping path.
  document.getElementById("item-panel-title").textContent = t.title;

  const tint = categoryTint(t.category);
  const meta = [];
  if (t.category) meta.push(\`<span class="badge" style="background:\${tint.chipBg}; color:\${tint.chipText}">\${escapeHtml(t.category)}</span>\`);
  meta.push(\`<span class="list-badge \${t.list}"><span class="dot"></span>\${t.list === "todo" ? "Todo" : "Backlog"}</span>\`);
  if (t.priority) meta.push(\`<span class="via"><span class="priority-flag \${t.priority}"></span>\${escapeHtml(t.priority)} priority</span>\`);
  if (t.dueDate) meta.push(\`<span class="due \${isOverdue(t) ? "overdue" : ""}">\${isOverdue(t) ? "overdue " : ""}\${escapeHtml(t.dueDate)}</span>\`);
  // Unlike the card, the modal shows "via web" too — here you asked for the whole item.
  if (t.agent) meta.push(\`<span class="via"><span class="adot" style="background:\${agentColor(t.agent)}"></span>via \${escapeHtml(t.agent)}\${t.session ? \` <span class="session">#\${escapeHtml(t.session)}</span>\` : ""}</span>\`);
  if (isFromOtherDevice(t)) meta.push(\`<span class="device-badge">📱 \${escapeHtml(t.deviceName || "other device")}</span>\`);
  meta.push(itemIdButton(t));
  document.getElementById("item-panel-meta").innerHTML = meta.join("");

  document.getElementById("item-panel-body").innerHTML = t.description
    ? renderMarkdown(t.description)
    : '<div class="item-panel-empty">No description.</div>';
  document.getElementById("item-panel-extra").innerHTML = sourceLinkHtml(t.sourceUrl) + historyHtml(t);
  if (!itemPanel.open) itemPanel.showModal();
}

function openEditModal(id) {
  const t = findTodo(id);
  if (!t) {
    showToast("That item is no longer here.");
    return;
  }
  editingId = id;
  document.getElementById("edit-panel-subtitle").textContent =
    \`#\${t.id} · \${t.shortId}\` + (t.agent ? \` · created via \${t.agent}\` : "");
  document.getElementById("edit-panel-form").innerHTML = editFormHtml(t);
  editSnapshot = editFormState();
  if (itemPanel.open) itemPanel.close();
  if (!editPanel.open) editPanel.showModal();
  editPanel.querySelector("input.title")?.focus();
}

/*
 * Everything typed into this dialog is unsaved until Save, and a dialog is far easier to
 * dismiss by accident than the inline form it replaced: Escape, a backdrop click, or a
 * drag-select that happens to end past the dialog's edge all reach close(). So the exits
 * ask first, and only when there is actually something to lose.
 */
const EDIT_FIELDS = ["title", "description", "category", "priority", "due", "source-url"];
let editSnapshot = "";

function editFormState() {
  const form = editPanel.querySelector(".edit-form");
  if (!form) return "";
  return JSON.stringify(EDIT_FIELDS.map((cls) => form.querySelector("." + cls)?.value ?? ""));
}

const editIsDirty = () => editPanel.open && editFormState() !== editSnapshot;
const confirmDiscard = () => confirm("Discard your changes to this item?");

// One cleanup path for both ways out — the button and Escape — so neither can leave
// editingId set and refreshes suppressed forever.
itemPanel.addEventListener("close", () => { viewingId = null; });
editPanel.addEventListener("close", () => {
  editingId = null;
  document.getElementById("edit-panel-form").innerHTML = "";
  refresh();
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

document.getElementById("item-modal-close").addEventListener("click", closeItemModal);
document.getElementById("item-panel-dismiss").addEventListener("click", closeItemModal);
document.getElementById("item-panel-edit").addEventListener("click", () => openEditModal(viewingId));
document.getElementById("edit-modal-close").addEventListener("click", () => closeEditModal());
closeOnBackdropClick(itemPanel, closeItemModal);
closeOnBackdropClick(editPanel, () => closeEditModal());

/* ---- markdown editor ------------------------------------------------------------------ */
const MD_WRAP = {
  bold: { before: "**", after: "**", sample: "bold text" },
  italic: { before: "*", after: "*", sample: "italic text" },
  code: { before: "\`", after: "\`", sample: "code" },
  link: { before: "[", after: "](https://)", sample: "text" },
};
const MD_PREFIX = { bullet: "- ", heading: "## " };

function applyMarkdown(textarea, kind) {
  if (!textarea) return;
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const prefix = MD_PREFIX[kind];
  if (prefix) {
    // Line prefixes apply to every selected line, and toggle off if they are already there.
    const from = value.lastIndexOf("\\n", start - 1) + 1;
    const nextBreak = value.indexOf("\\n", end);
    const to = nextBreak === -1 ? value.length : nextBreak;
    const block = value.slice(from, to).split("\\n")
      .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : prefix + line))
      .join("\\n");
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

function setEditorMode(editor, mode) {
  editor.dataset.mode = mode;
  for (const tab of editor.querySelectorAll(".md-tab")) tab.dataset.active = String(tab.dataset.mode === mode);
  if (mode !== "preview") return;
  const source = editor.querySelector("textarea.description").value;
  editor.querySelector(".md-preview").innerHTML = source.trim()
    ? renderMarkdown(source)
    : '<div class="item-panel-empty">Nothing to preview yet.</div>';
}

editPanel.addEventListener("click", (e) => {
  const tab = e.target.closest(".md-tab");
  if (tab) return setEditorMode(tab.closest(".md-editor"), tab.dataset.mode);
  const apply = e.target.closest(".md-apply");
  if (apply) return applyMarkdown(editPanel.querySelector("textarea.description"), apply.dataset.md);
  if (e.target.closest("button.cancel-edit")) closeEditModal();
});

editPanel.addEventListener("keydown", (e) => {
  if (!e.metaKey && !e.ctrlKey) return;
  if (e.key === "Enter") {
    e.preventDefault();
    editPanel.querySelector(".edit-form")?.requestSubmit();
    return;
  }
  if (!e.target.matches("textarea.description")) return;
  const kind = { b: "bold", i: "italic", k: "link" }[e.key.toLowerCase()];
  if (!kind) return;
  e.preventDefault();
  applyMarkdown(e.target, kind);
});

editPanel.addEventListener("submit", async (e) => {
  if (!e.target.matches(".edit-form")) return;
  e.preventDefault();
  const id = Number(e.target.dataset.id);
  const title = e.target.querySelector(".title").value.trim();
  if (!title) return;
  await fetch(\`/api/todos/\${id}\`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      description: e.target.querySelector(".description").value.trim(),
      category: e.target.querySelector(".category").value.trim(),
      priority: e.target.querySelector(".priority").value,
      dueDate: e.target.querySelector(".due").value,
      sourceUrl: e.target.querySelector(".source-url").value.trim(),
    }),
  });
  closeEditModal({ force: true }); // its close handler clears the form and refreshes
});

/**
 * navigator.clipboard exists only on a secure origin. localhost is one; a phone reaching
 * http://192.168.x.x is not — and that is a first-class way to use Docket, so the old
 * execCommand path is the fallback rather than an afterthought.
 */
async function copyText(text) {
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

async function copyShortId(button) {
  const value = button.dataset.copy;
  const copied = await copyText(value);
  showToast(copied ? \`Copied \${value}\` : \`Couldn't copy — the id is \${value}\`);
}

itemPanel.addEventListener("click", (e) => {
  const idButton = e.target.closest("button.id");
  if (idButton) copyShortId(idButton);
});

document.getElementById("import-file-btn").addEventListener("click", () => {
  document.getElementById("import-file-input").click();
});
document.getElementById("import-file-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const statusEl = document.getElementById("import-status");
  statusEl.textContent = "Importing…";
  try {
    const text = await file.text();
    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, filename: file.name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Import failed");
    statusEl.textContent = \`Imported \${data.added} items!\`;
    refresh();
  } catch (err) {
    statusEl.textContent = \`Error: \${(err && err.message) || err}\`;
  }
  e.target.value = "";
});

document.querySelectorAll(".modal-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".modal-tab").forEach((b) => (b.dataset.active = String(b === btn)));
    document
      .querySelectorAll(".modal-pane")
      .forEach((p) => (p.hidden = p.dataset.modalTab !== btn.dataset.modalTab));
  });
});

document.querySelectorAll(".pair-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".pair-tab").forEach((b) => (b.dataset.active = String(b === btn)));
    document.querySelectorAll(".devices-pair-pane").forEach((p) => (p.hidden = p.dataset.tab !== btn.dataset.tab));
  });
});

document.getElementById("devices-list").addEventListener("click", async (e) => {
  if (e.target.matches(".unpair")) {
    const id = e.target.dataset.id;
    e.target.disabled = true;
    await fetch(\`/api/peers/\${id}\`, { method: "DELETE" });
    refreshDevicesPanel();
    return;
  }
  if (e.target.matches(".peer-revoke")) {
    const id = e.target.dataset.id;
    const action = e.target.dataset.action; // "revoke" or "restore"
    e.target.disabled = true;
    await fetch(\`/api/peers/\${id}/\${action}\`, { method: "POST" });
    refreshDevicesPanel();
    return;
  }
  if (e.target.matches(".peer-update-address")) {
    const id = e.target.dataset.id;
    const name = e.target.dataset.name;
    const newUrl = prompt(\`New address for \${name} (e.g. http://192.168.1.42:8787) — its identity will be re-verified before this device trusts it:\`);
    if (!newUrl) return;
    e.target.disabled = true;
    e.target.textContent = "Verifying…";
    try {
      const res = await fetch(\`/api/peers/\${id}/address\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: newUrl }),
      });
      const data = await res.json();
      if (!res.ok) alert(data.error || "Couldn't update the address.");
    } catch {
      alert("Couldn't reach that address.");
    }
    refreshDevicesPanel();
  }
});

async function handleIncomingAction(e, kind) {
  const id = e.target.dataset.id;
  if (!id || pendingRequestActions.has(id)) return; // already mid-flight — ignore a second click
  const action = e.target.matches(".approve") ? "approve" : e.target.matches(".deny") ? "deny" : null;
  if (!action) return;
  pendingRequestActions.set(id, action);
  // Toggle the existing buttons directly rather than re-rendering the row from its own
  // .textContent — the name/meta text came from another device over the network, and
  // round-tripping it back through innerHTML without re-escaping would be a stored-XSS
  // hole. incomingRowHtml() (used by refreshDevicesPanel) is the only place that builds
  // this markup from scratch, always straight from freshly-escaped server JSON.
  const row = e.target.closest(".incoming-row");
  if (row) {
    const approve = row.querySelector(".approve");
    const deny = row.querySelector(".deny");
    approve.disabled = true;
    deny.disabled = true;
    (action === "approve" ? approve : deny).textContent = action === "approve" ? "Approving…" : "Denying…";
  }
  try {
    await fetch(\`/api/\${kind}/\${action}/\${id}\`, { method: "POST" });
  } finally {
    pendingRequestActions.delete(id);
  }
  refreshDevicesPanel();
}

document.getElementById("devices-incoming").addEventListener("click", (e) => handleIncomingAction(e, "pair"));
document.getElementById("access-incoming").addEventListener("click", (e) => handleIncomingAction(e, "access"));

document.getElementById("access-viewers-list").addEventListener("click", async (e) => {
  if (!e.target.matches(".unpair")) return;
  const id = e.target.dataset.id;
  e.target.disabled = true;
  await fetch(\`/api/access/viewers/\${id}\`, { method: "DELETE" });
  refreshDevicesPanel();
});

/**
 * An address with no port is the commonest way a pairing attempt fails, and the failure is
 * opaque: the browser turns "192.168.1.42" into http://192.168.1.42, which is port 80,
 * which nothing is listening on — so the server answers 502 "couldn't reach that device"
 * and the reason is nowhere on screen. Nobody runs docket on port 80; an address typed
 * without one means "the docket on that machine".
 */
const DEFAULT_PEER_PORT = "8787";

function peerUrlFrom(host) {
  const raw = /^https?:\\/\\//.test(host) ? host : \`http://\${host}\`;
  try {
    const parsed = new URL(raw);
    // URL.port is "" both when absent and when it is the protocol default, which is why
    // this only fills in for http: an https peer on 443 is a deliberate setup, not an omission.
    if (!parsed.port && parsed.protocol === "http:") parsed.port = DEFAULT_PEER_PORT;
    return parsed.origin;
  } catch {
    return raw; // let the server report what is wrong with it
  }
}

function sasLine(sas) {
  return sas ? \`Verify code: \${sas.slice(0, 3)} \${sas.slice(3)} — must match on both screens\` : "";
}

document.getElementById("pair-redeem-btn").addEventListener("click", async () => {
  const hostInput = document.getElementById("pair-host-input");
  const codeInput = document.getElementById("pair-code-input");
  const status = document.getElementById("pair-status-text");
  let host = hostInput.value.trim();
  let token = codeInput.value.trim().toUpperCase();
  let publicKeyX = null;
  // Someone pasting the full "host?pair=CODE&pk=..." line into the host field still works —
  // pk is what lets this device verify the host's identity out-of-band (see generateInvite).
  if (host.includes("?pair=")) {
    const [h, rest] = host.split("?pair=");
    host = h.trim();
    const params = new URLSearchParams(rest.includes("&") ? rest.slice(rest.indexOf("&")) : "");
    const c = rest.split("&")[0];
    if (!token) token = c.trim().toUpperCase();
    publicKeyX = params.get("pk");
  }
  if (!host || !token) {
    status.textContent = "Enter both the host address and the code.";
    return;
  }
  const peerUrl = peerUrlFrom(host);
  status.textContent = "Connecting…";
  try {
    const res = await fetch("/api/pair/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerUrl, token, publicKeyX: publicKeyX || undefined }),
    });
    const body = await res.json();
    if (!res.ok) {
      status.textContent = body.error || "Couldn't connect.";
      return;
    }
    status.textContent = \`Waiting for approval on the other device… \${sasLine(body.sas)}\`;
    clearInterval(outgoingPollTimer);
    let attempts = 0;
    outgoingPollTimer = setInterval(async () => {
      attempts += 1;
      if (attempts > 90) {
        clearInterval(outgoingPollTimer);
        status.textContent = "Timed out waiting for approval.";
        return;
      }
      const s = await (await fetch(\`/api/pair/outgoing/\${body.requestId}\`)).json();
      if (s.status === "confirmed") {
        clearInterval(outgoingPollTimer);
        status.textContent = \`Paired with \${s.deviceName}!\`;
        hostInput.value = "";
        codeInput.value = "";
        refreshDevicesPanel();
      } else if (s.status === "denied") {
        clearInterval(outgoingPollTimer);
        status.textContent = "The other device declined the request.";
      } else {
        status.textContent = \`Waiting for approval on the other device… \${sasLine(s.sas || body.sas)}\`;
      }
    }, 2000);
  } catch {
    status.textContent = "Couldn't reach that device.";
  }
});

const addToggle = document.querySelector(".add-toggle");
const addForm = document.querySelector(".add-form");
let addFormList = "todo";

document.querySelectorAll(".list-picker button").forEach((btn) => {
  btn.addEventListener("click", () => {
    addFormList = btn.dataset.value;
    document.querySelectorAll(".list-picker button").forEach((b) => (b.dataset.active = String(b === btn)));
  });
});

addToggle.addEventListener("click", () => {
  addForm.classList.add("open");
  addToggle.style.display = "none";
  addForm.querySelector(".title").focus();
});

function closeAddForm() {
  addForm.classList.remove("open");
  addToggle.style.display = "";
  addForm.reset();
  addFormList = "todo";
  document.querySelectorAll(".list-picker button").forEach((b) => (b.dataset.active = String(b.dataset.value === "todo")));
}

addForm.querySelector(".cancel").addEventListener("click", closeAddForm);

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const titleInput = addForm.querySelector(".title");
  const descInput = addForm.querySelector(".description");
  const catInput = addForm.querySelector(".category");
  const priorityInput = addForm.querySelector(".priority");
  const dueInput = addForm.querySelector(".due");
  const sourceUrlInput = addForm.querySelector(".source-url");
  const title = titleInput.value.trim();
  if (!title) return;
  const description = descInput.value.trim() || undefined;
  const category = catInput.value.trim() || undefined;
  const priority = priorityInput.value || undefined;
  const dueDate = dueInput.value || undefined;
  const sourceUrl = sourceUrlInput.value.trim() || undefined;
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
      workspace: activeWorkspace === "*" || activeWorkspace === UNFILED ? null : activeWorkspace,
    }),
  });
  closeAddForm();
  refresh();
});

const toast = document.getElementById("toast");
const toastText = document.getElementById("toast-text");
const toastUndo = document.getElementById("toast-undo");
let toastTimer = null;
let lastDeleted = null;

function showToast(text, { undo = false } = {}) {
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
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
    if (!undo) return;
    lastDeleted = null; // the window is over; state and affordance expire together
  }, undo ? 6000 : 2600);
}

function showUndoToast(deletedTodo) {
  lastDeleted = deletedTodo;
  const shown = deletedTodo.title.slice(0, 40) + (deletedTodo.title.length > 40 ? "…" : "");
  showToast(\`Deleted "\${shown}"\`, { undo: true });
}

toastUndo.addEventListener("click", async () => {
  if (!lastDeleted) return;
  toast.classList.remove("show");
  clearTimeout(toastTimer);
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

document.querySelector(".page").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  const id = Number(li.dataset.id);

  if (e.target.matches("button.del")) {
    const found = allTodos.find((t) => t.id === id);
    const res = await fetch(\`/api/todos/\${id}\`, { method: "DELETE" });
    if (res.ok && found) showUndoToast(found);
    refresh();
  } else if (e.target.matches('input[type=checkbox]') && !e.target.disabled) {
    await fetch(\`/api/todos/\${id}/complete\`, { method: "POST" });
    refresh();
  } else if (e.target.closest("button.id")) {
    copyShortId(e.target.closest("button.id"));
  } else if (e.target.matches("button.edit")) {
    openEditModal(id);
  } else if (e.target.matches(".card-title") || e.target.matches(".read-more")) {
    openItemModal(id);
  } else if (e.target.matches(".badge") && e.target.dataset.category) {
    // Reuse the existing search box as the "browse by project" filter, instead of
    // adding another permanent tag/tab for something with unbounded cardinality.
    const searchInput = document.querySelector(".search");
    searchInput.value = e.target.dataset.category;
    searchInput.dispatchEvent(new Event("input"));
    searchInput.scrollIntoView({ block: "center", behavior: "smooth" });
  }
});

document.querySelector(".sort").addEventListener("change", refresh);
document.querySelector(".search").addEventListener("input", refresh);

async function loadVersionFooter() {
  try {
    const res = await fetch("/api/version");
    const v = await res.json();
    const started = new Date(v.startedAt).toLocaleString();
    document.getElementById("version-footer").textContent =
      \`Docket · format v\${v.formatVersion} · pid \${v.pid} · started \${started}\`;
  } catch (err) {
    document.getElementById("version-footer").textContent = "version unavailable";
  }
}
loadVersionFooter();

function setupEvents() {
  if (!window.EventSource) return;
  try {
    const es = new EventSource("/api/events");
    es.addEventListener("update", () => {
      if (editingId === null) refresh();
    });
    // The device sync runs on the server's own interval, in the server's process. This is
    // the only signal the browser gets that one is in flight.
    es.addEventListener("sync", (e) => {
      let detail;
      try {
        detail = JSON.parse(e.data);
      } catch {
        return;
      }
      if (detail.phase === "start") {
        syncingSince = Date.now();
        syncingWith = detail.peers || 0;
        tickSyncedLabel();
        return;
      }
      // Hold the spinner briefly: a sync with one nearby peer can finish in under 50ms, and
      // a 50ms flash reads as a glitch rather than as progress.
      const shown = Date.now() - (syncingSince || Date.now());
      setTimeout(() => {
        syncingSince = null;
        if (detail.ok) lastSync = Date.now();
        syncFailed = !detail.ok;
        tickSyncedLabel();
      }, Math.max(0, 450 - shown));
    });
  } catch (err) {}
}
setupEvents();

refresh();
setInterval(() => {
  // Fallback sync interval: skip while a card is mid-edit
  if (editingId === null) refresh();
}, 15000);
setInterval(tickSyncedLabel, 1000);

loadDeviceInfo().then(() => pollNotifications());
setInterval(() => {
  if (!document.getElementById("devices-panel").open) pollNotifications(); // open modal's own poll already covers this
}, 8000);
`;
