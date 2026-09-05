/*
 * A TEMPLATE LITERAL, not a module. Everything below is text that becomes the page's <body>.
 *
 * Two rules follow from that and there is no compiler to enforce either:
 *  - a literal backtick ends the string. Write \\` , or reword. views.backtick.test.ts
 *    fails with the exact line number when one slips into a comment, which is where it
 *    always happens — a backtick is the natural way to quote an identifier in prose.
 *  - ${...} interpolates. Write \\${ for a dollar-brace that should reach the browser.
 */
export const MARKUP = `
  <header>
    <h1>Docket</h1>
    <div class="header-right">
      <div class="synced" data-state="idle"><span class="dot"></span><span class="spinner"></span><span id="synced-text">syncing…</span></div>
      <button class="theme-toggle" id="export-toggle" title="Export & Import" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
      <button class="theme-toggle" id="devices-toggle" title="Devices" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="12" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        <span class="devices-badge" id="notif-badge" hidden>0</span>
      </button>
      <button class="theme-toggle" id="theme-toggle" title="Toggle theme" type="button">
        <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>
        <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      </button>
    </div>
  </header>
  <dialog class="devices-panel" id="devices-panel">
    <div class="modal-head">
      <div>
        <div class="devices-title">Devices</div>
        <div class="devices-subtitle">This device: <strong id="this-device-name">…</strong></div>
      </div>
      <button type="button" class="modal-close" id="devices-modal-close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>

    <div class="devices-requests" id="devices-requests">
      <div class="devices-incoming" id="devices-incoming" hidden></div>
      <div class="devices-incoming" id="access-incoming" hidden></div>
      <div class="activity-log" id="activity-log" hidden></div>
    </div>

    <div class="modal-tabs">
      <button type="button" class="modal-tab" data-modal-tab="connect" data-active="true">Connect</button>
      <button type="button" class="modal-tab" data-modal-tab="devices" data-active="false">
        Devices <span class="tab-badge" id="devices-tab-badge" hidden>0</span>
      </button>
    </div>

    <div class="modal-pane" data-modal-tab="connect">
      <p class="devices-explainer">
        Pair another computer running Docket to share this list between them, or
        approve a browser that just wants to view/edit it. Nothing connects until
        <strong>both sides explicitly approve</strong> — never automatically or silently.
      </p>

      <p class="devices-explainer" id="guest-note" hidden>
        This device joined an existing group via someone else's invite, so it's a
        <strong>guest</strong> — it stays in sync, but only the device that invited
        it can invite or approve further devices. Unpair to leave and become a
        host again.
      </p>

      <div class="devices-pair" id="devices-pair-section">
        <div class="devices-pair-tabs">
          <button type="button" class="pair-tab" data-tab="show" data-active="true">Show my code</button>
          <button type="button" class="pair-tab" data-tab="enter" data-active="false">I have a code</button>
        </div>

        <div class="devices-pair-pane" data-tab="show">
          <div class="devices-pair-row">
            <div class="qr-wrap">
              <div class="qr-loading" id="pair-qr-loading">
                <span class="qr-dot"></span><span class="qr-dot"></span><span class="qr-dot"></span>
                <span class="qr-dot"></span><span class="qr-dot"></span><span class="qr-dot"></span>
                <span class="qr-dot"></span><span class="qr-dot"></span><span class="qr-dot"></span>
              </div>
              <img id="pair-qr" alt="QR code with this device's pairing invite" width="164" height="164" hidden />
            </div>
            <div class="devices-pair-text">
              <div class="phone-panel-title">Scan, or type this code</div>
              <div class="pair-short-code" id="pair-short-code">······</div>
              <textarea class="devices-pair-code" id="pair-invite-text" readonly rows="2">Generating…</textarea>
              <div class="phone-panel-hint">Paste the full line above, or just the 6-character code, into the other device's "I have a code" tab. Expires in 5 minutes, works once.</div>
            </div>
          </div>
        </div>

        <div class="devices-pair-pane" data-tab="enter" hidden>
          <div class="edit-field-label">Host address (shown on the other device's screen)</div>
          <input type="text" class="devices-pair-input" id="pair-host-input" placeholder="192.168.1.42 (port 8787 assumed)" autocomplete="off" />
          <div class="edit-field-label" style="margin-top:12px;">Code</div>
          <input type="text" class="devices-pair-input pair-code-field" id="pair-code-input" placeholder="XXXXXX" maxlength="6" autocomplete="off" autocapitalize="characters" />
          <div class="devices-pair-row" style="margin-top:14px;">
            <button type="button" class="btn-connect" id="pair-redeem-btn">Connect</button>
            <span class="devices-pair-status" id="pair-status-text"></span>
          </div>
        </div>
      </div>
    </div>

    <div class="modal-pane" data-modal-tab="devices" hidden>
      <p class="devices-explainer">Full sync partners and browsers approved to view/edit this list.</p>
      <div class="devices-list" id="devices-list"></div>
      <div class="devices-list" id="access-viewers-list"></div>
      <p class="devices-explainer" id="sessions-heading" hidden>Active sessions</p>
      <div class="presence-list" id="sessions-list"></div>
      <p class="devices-explainer" id="presence-heading" hidden>Recent activity</p>
      <div class="presence-list" id="presence-list"></div>
    </div>
  </dialog>

  <dialog class="devices-panel" id="export-panel">
    <div class="modal-head">
      <div>
        <div class="devices-title">Export & Import</div>
        <div class="devices-subtitle">Backup, restore, or export your backlog</div>
      </div>
      <button type="button" class="modal-close" id="export-modal-close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div style="margin-top: 14px; display: flex; flex-direction: column; gap: 16px;">
      <div>
        <h4 style="font-family: 'Fredoka', sans-serif; margin: 0 0 8px; font-size: 14px;">Export to file</h4>
        <div style="display: flex; gap: 10px; flex-wrap: wrap;">
          <a href="/api/export?format=markdown" download="todos.md" class="btn-connect" style="text-decoration: none; display: inline-flex; align-items: center; gap: 6px;">
            <svg style="width: 14px; height: 14px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download Markdown (.md)
          </a>
          <a href="/api/export?format=json" download="todos.json" class="btn-connect" style="background: var(--lavender); text-decoration: none; display: inline-flex; align-items: center; gap: 6px;">
            <svg style="width: 14px; height: 14px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download JSON (.json)
          </a>
        </div>
      </div>
      <hr style="border: none; border-top: 1px solid var(--input-border); margin: 4px 0;" />
      <div>
        <h4 style="font-family: 'Fredoka', sans-serif; margin: 0 0 8px; font-size: 14px;">Import from file</h4>
        <p class="devices-explainer" style="margin-bottom: 10px;">Select a Markdown (.md) or JSON (.json) file to add items into your store.</p>
        <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
          <input type="file" id="import-file-input" accept=".json,.md,.markdown,.txt" style="display: none;" />
          <button type="button" class="btn-connect" id="import-file-btn" style="background: var(--ink); color: var(--ink-text); display: inline-flex; align-items: center; gap: 6px;">
            <svg style="width: 14px; height: 14px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Choose File & Import
          </button>
          <span id="import-status" style="font-size: 13px; color: var(--muted2);"></span>
        </div>
      </div>
    </div>
  </dialog>

  <!-- Reading and editing both moved off the card and into these two. A card that expands
       in place pushes every card below it, and an edit form that replaces a card loses its
       own inputs to any background refresh that lands mid-keystroke. -->
  <dialog class="item-panel" id="item-panel" aria-labelledby="item-panel-title">
    <div class="modal-head">
      <div class="item-panel-title" id="item-panel-title"></div>
      <button type="button" class="modal-close" id="item-modal-close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div class="item-panel-meta" id="item-panel-meta"></div>
    <div class="item-panel-body md" id="item-panel-body"></div>
    <div id="item-panel-extra"></div>
    <div class="item-panel-foot">
      <button type="button" class="dismiss" id="item-panel-dismiss">Close</button>
      <button type="button" class="to-edit" id="item-panel-edit">Edit</button>
    </div>
  </dialog>

  <dialog class="edit-panel" id="edit-panel" aria-labelledby="edit-panel-title">
    <div class="modal-head">
      <div>
        <div class="devices-title" id="edit-panel-title">Edit item</div>
        <div class="devices-subtitle" id="edit-panel-subtitle"></div>
      </div>
      <button type="button" class="modal-close" id="edit-modal-close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div id="edit-panel-form"></div>
  </dialog>

  <div class="page">
    <div class="tags">
      <button class="tag" data-tag="all" data-active="true" type="button"><span class="dot"></span>All <span class="n" data-count="all"></span></button>
      <button class="tag" data-tag="todo" data-active="false" type="button"><span class="dot"></span>Todo <span class="n" data-count="todo"></span></button>
      <button class="tag" data-tag="backlog" data-active="false" type="button"><span class="dot"></span>Backlog <span class="n" data-count="backlog"></span></button>
      <button class="tag" data-tag="devices" data-active="false" type="button"><span class="dot"></span>Other devices <span class="n" data-count="devices"></span></button>
    </div>

    <div class="toolbar">
      <!-- Scope, then search, then order: the three controls that answer "what am I looking
           at", grouped. It sits here rather than in its own row because a second row of
           pills above the tags duplicated the tags' own leading "All". -->
      <div class="workspaces"></div>
      <div class="search-row" style="flex:1">
        <input type="text" class="search" placeholder="Search text or category…" />
      </div>
      <select class="sort">
        <option value="default">Sort: default</option>
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="az">A → Z</option>
        <option value="category">By category</option>
        <option value="priority">By priority</option>
        <option value="due">By due date</option>
      </select>
    </div>

    <!-- The empty-scope warning lives here, immediately above the list it explains: a scoped
         view that is empty while the store is not reads as "my data is gone" from where the
         user sits, and the reaction to that is uninstalling, not reading docs. -->
    <div class="count-line"><span class="open-count"></span><span class="ws-note"></span></div>

    <ul class="open-list"></ul>
    <details class="done-section">
      <summary>Done <span class="done-count"></span></summary>
      <ul class="done-list"></ul>
    </details>

    <button class="add-toggle" type="button">+ Add item</button>
    <form class="add-form">
      <div class="row">
        <input type="text" class="title" placeholder="Title…" required />
        <input type="text" class="category" placeholder="category" />
      </div>
      <textarea class="description" placeholder="Description (optional)…" rows="2"></textarea>
      <input type="url" class="source-url" placeholder="Source link (GitHub, Notion, Obsidian, etc.) — optional" />
      <div class="row">
        <select class="priority">
          <option value="">No priority</option>
          <option value="low">Low priority</option>
          <option value="medium">Medium priority</option>
          <option value="high">High priority</option>
        </select>
        <input type="date" class="due" />
      </div>
      <div class="list-picker">
        <button type="button" data-value="todo" data-active="true">Todo</button>
        <button type="button" data-value="backlog" data-active="false">Backlog</button>
      </div>
      <div class="add-form-actions">
        <button class="add" type="submit">Add</button>
        <button class="cancel" type="button">Cancel</button>
      </div>
    </form>
  </div>

  <footer id="version-footer">loading version…</footer>

  <div class="toast" id="toast">
    <span id="toast-text"></span>
    <button id="toast-undo" type="button">Undo</button>
  </div>

`;
