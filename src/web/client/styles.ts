/*
 * A TEMPLATE LITERAL, not a module. Everything below is text that becomes the page's stylesheet.
 *
 * Two rules follow from that and there is no compiler to enforce either:
 *  - a literal backtick ends the string. Write \\` , or reword. views.backtick.test.ts
 *    fails with the exact line number when one slips into a comment, which is where it
 *    always happens — a backtick is the natural way to quote an identifier in prose.
 *  - ${...} interpolates. Write \\${ for a dollar-brace that should reach the browser.
 */
export const STYLES = `
  /* Warm Workshop theme. Light is the default; [data-theme="dark"] overrides. */
  :root {
    color-scheme: light;
    --bg: #faf5ec; --card-shadow: 0 2px 8px rgba(61,50,41,.05);
    --text: #3d3229; --muted: #8a7a63; --muted2: #a8987f; --meta: #b4a488; --faint: #c9bca3;
    --danger: #b8402c;
    --card-empty-border: #e3d5b8;
    --input-bg: #ffffff; --input-border: #f0e2c9;
    --card-plain-bg: #ffffff; --card-plain-border: #f0e2c9;
    --checkbox-border: #d8c9ac;
    --sage: #3f7a50; --sage-bg: #e7f3ea;
    --lavender: #7c4f9e; --lavender-bg: #f1e9f7;
    --accent: #f5a623;
    --due-bg: #fdeee0; --due-text: #b8722f;
    --overdue-bg: #fbdcd6; --overdue-text: #b8402c;
    --ink: #3d3229; --ink-text: #ffffff;
    --avatar-shadow: 0 2px 6px rgba(61,50,41,.1);
  }
  html[data-theme="dark"] {
    color-scheme: dark;
    --bg: #1f1710; --card-shadow: 0 2px 10px rgba(0,0,0,.3);
    --text: #f0e6d8; --muted: #a89984; --muted2: #8f8268; --meta: #8f8268; --faint: #6b5f4c;
    --danger: #e2685a;
    --card-empty-border: #4a3c28;
    --input-bg: #2b2119; --input-border: #3d3122;
    --card-plain-bg: #2b2119; --card-plain-border: #3d3122;
    --checkbox-border: #55452e;
    --sage: #7fc492; --sage-bg: #223523;
    --lavender: #c79ee8; --lavender-bg: #352a41;
    --accent: #f5a623;
    --due-bg: #3a2a1a; --due-text: #e2a361;
    --overdue-bg: #3a1f1a; --overdue-text: #e2685a;
    --ink: #f0e6d8; --ink-text: #1f1710;
    --avatar-shadow: 0 2px 6px rgba(0,0,0,.35);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 20px 60px; background: var(--bg); color: var(--text);
    font-family: 'Karla', system-ui, sans-serif;
    transition: background .15s ease, color .15s ease;
  }
  header { max-width: 720px; margin: 0 auto 22px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  h1 { font-family: 'Fredoka', sans-serif; font-weight: 700; font-size: 21px; margin: 0; color: var(--text); }
  .header-right { display: flex; align-items: center; gap: 12px; }
  /* Three states, one element. The dot alone carries "fine"; syncing swaps it for a spinner
     and tints the pill, so a sync in flight is visible without reading anything. */
  .synced {
    font-size: 12px; color: var(--muted); font-weight: 600;
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px; border-radius: 999px;
    transition: background .18s ease, color .18s ease;
  }
  .synced .dot { display: block; width: 7px; height: 7px; border-radius: 50%; background: var(--sage); flex-shrink: 0; }
  .synced .dot.fail { background: #4a4a4a; }
  .synced .spinner {
    display: none; width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0;
    border: 2px solid currentColor; border-top-color: transparent;
    animation: sync-spin .7s linear infinite;
  }
  .synced[data-state="syncing"] { background: var(--sage-bg); color: var(--sage); }
  .synced[data-state="syncing"] .dot { display: none; }
  .synced[data-state="syncing"] .spinner { display: block; }
  .synced[data-state="failed"] { background: var(--overdue-bg); color: var(--overdue-text); }
  @keyframes sync-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .synced .spinner { animation: none; border-top-color: currentColor; opacity: .5; }
  }

  .theme-toggle {
    border: none; background: var(--input-bg); color: var(--muted);
    border-radius: 50%; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center;
    cursor: pointer; padding: 0; box-shadow: var(--avatar-shadow);
  }
  .theme-toggle svg { width: 16px; height: 16px; }
  .theme-toggle .sun { display: none; }
  .theme-toggle .moon { display: block; }
  html[data-theme="light"] .theme-toggle .sun { display: block; }
  html[data-theme="light"] .theme-toggle .moon { display: none; }

  .page { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }

  .tags { display: flex; gap: 8px; flex-wrap: wrap; }
  .tag {
    border: none; background: var(--input-bg); color: var(--muted); box-shadow: 0 0 0 1px var(--input-border) inset;
    border-radius: 999px; padding: 7px 16px; font-size: 13px; font-weight: 600; cursor: pointer;
    display: flex; align-items: center; gap: 7px; font-family: 'Fredoka', sans-serif;
  }
  .tag .n { font-weight: 600; opacity: .75; font-variant-numeric: tabular-nums; }
  .tag .dot { display: none; }
  .tag[data-active="true"] { box-shadow: none; }
  .tag[data-tag="all"][data-active="true"] { background: var(--ink); color: var(--ink-text); }
  .tag[data-tag="todo"][data-active="true"] { background: var(--sage-bg); color: var(--sage); }
  .tag[data-tag="backlog"][data-active="true"] { background: var(--lavender-bg); color: var(--lavender); }
  .tag[data-tag="devices"][data-active="true"] { background: var(--due-bg); color: var(--due-text); }

  /* Project scope is a different KIND of question from "todo or backlog?", so it gets a
     different SHAPE — not a second row of the same pills. Two stacked rows that both
     opened with "All 2" read as one control accidentally rendered twice. */
  .workspaces { display: flex; align-items: center; flex-shrink: 0; }
  .workspaces:empty { display: none; }
  .ws-select { max-width: 190px; font-weight: 600; text-overflow: ellipsis; }
  .ws-select[data-scoped="true"] { color: var(--lavender); box-shadow: 0 0 0 1px var(--lavender) inset; }
  .ws-note {
    font-size: 11.5px; color: var(--due-text); background: var(--due-bg);
    border-radius: 999px; padding: 3px 10px; margin-left: 8px; font-weight: 600;
  }
  .ws-note:empty { display: none; }

  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  select, input[type=text], input[type=date], input[type=url], textarea {
    font: inherit; border: none; box-shadow: 0 0 0 1px var(--input-border) inset; border-radius: 999px; background: var(--input-bg);
    color: var(--text); padding: 8px 14px;
  }
  select {
    appearance: none; -webkit-appearance: none; -moz-appearance: none;
    font-size: 12px; padding: 8px 30px 8px 14px; cursor: pointer; font-family: 'Karla', sans-serif;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a7a63' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center; background-size: 11px;
  }
  html[data-theme="dark"] select {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a89984' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  }
  input[type=date]::-webkit-calendar-picker-indicator { filter: var(--date-icon-filter, none); cursor: pointer; }
  html[data-theme="dark"] input[type=date]::-webkit-calendar-picker-indicator { filter: invert(1); }
  .search-row { display: flex; gap: 6px; }
  .search-row input[type=text] { flex: 1; font-size: 13px; padding: 8px 14px; }
  .count-line { font-size: 12px; color: var(--muted2); font-weight: 600; padding: 0 4px; }

  /* Scoped to the card lists on purpose. As bare ul/li selectors these also styled the lists
     inside rendered markdown — bullets gone, every inline run forced onto its own line by
     the flex column. A description is allowed to contain a list. */
  ul.open-list, ul.done-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }

  li[data-id] {
    border-radius: 20px; padding: 16px 18px; display: flex; flex-direction: column; gap: 8px;
    background: var(--card-plain-bg); border: 1px solid var(--card-plain-border); box-shadow: var(--card-shadow);
    position: relative;
  }
  li.done { opacity: .55; }
  li.done .card-title { text-decoration: line-through; }
  /* Row 1 is the sentence you read; row 2 is what you only sometimes check. Reversing the
     old order is what removes the wrap — the title no longer starts behind an identifier,
     and the meta row holds only small uniform pieces that wrap without looking broken. */
  .card-main { display: flex; align-items: center; gap: 10px; }
  .card-meta {
    display: flex; align-items: center; gap: 7px; flex-wrap: wrap; row-gap: 5px;
    padding-left: 30px; min-width: 0;
  }
  .card-meta .sep { color: var(--faint); font-size: 10px; }
  .badge {
    display: inline-block; font-family: 'Fredoka', sans-serif; font-size: 11px; font-weight: 600;
    padding: 3px 11px; border-radius: 999px; transform: rotate(var(--badge-rot, 0deg));
  }
  .list-badge {
    display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; color: var(--muted2);
  }
  .list-badge .dot { width: 6px; height: 6px; border-radius: 50%; }
  .list-badge.todo .dot { background: var(--sage); }
  .list-badge.backlog .dot { background: var(--lavender); }
  .card-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
  li button.del, li button.edit {
    border: none; background: transparent; cursor: pointer; font-size: 15px; color: var(--muted);
    width: 30px; height: 30px; border-radius: 999px; flex-shrink: 0; display: flex; align-items: center;
    justify-content: center; opacity: .55; transition: opacity .12s ease, background .12s ease;
  }
  li button.del:hover, li button.edit:hover { opacity: 1; background: var(--bg); }
  li button.del { color: var(--danger); }
  li button.edit { color: var(--text); }
  /* A button, not a label: the cross-device id is the string you paste to an agent, and
     selecting eleven characters by hand on a phone is the reason nobody ever did. */
  button.id {
    margin-left: auto; border: none; background: none; padding: 2px 6px; border-radius: 7px; cursor: pointer;
    color: var(--meta); opacity: .6; font-weight: 700; font-size: 11px; font-variant-numeric: tabular-nums;
    font-family: 'Karla', sans-serif; white-space: nowrap; flex-shrink: 0;
    display: inline-flex; align-items: center; gap: 5px;
  }
  button.id:hover { opacity: 1; background: var(--bg); color: var(--text); }
  button.id .copy-icon { width: 10px; height: 10px; opacity: 0; transition: opacity .12s ease; flex-shrink: 0; }
  button.id:hover .copy-icon, button.id:focus-visible .copy-icon { opacity: .8; }
  .card-main input[type=checkbox] {
    appearance: none; -webkit-appearance: none; width: 20px; height: 20px; margin: 2px 0 0; flex-shrink: 0;
    cursor: pointer; border: 2px solid var(--checkbox-border); border-radius: 7px; background: transparent;
  }
  .card-main input[type=checkbox]:checked {
    background-color: var(--sage); border-color: var(--sage);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Cpath d='M5 9.2 7.6 11.8 13 6' stroke='white' stroke-width='1.8' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: center; background-size: 12px 12px;
  }
  .card-title {
    font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 16px; word-break: break-word;
    flex: 1 1 auto; min-width: 0; text-align: left; border: none; background: none; padding: 0;
    color: inherit; cursor: pointer; line-height: 1.35;
  }
  .card-title:hover { text-decoration: underline; text-decoration-color: var(--faint); text-underline-offset: 3px; }
  .card-desc {
    font-family: 'Karla', sans-serif; font-weight: 400; font-size: 13px; color: var(--muted);
    line-height: 1.55; word-break: break-word; margin-top: 2px; padding-left: 30px;
  }
  /* The preview is a real render of the first 300 characters, not a stripped-down one, so
     what you read on the card is what you read in the modal — just less of it. */
  .read-more {
    align-self: flex-start; margin-left: 30px; border: none; background: none; cursor: pointer;
    font-family: 'Fredoka', sans-serif; font-size: 11px; font-weight: 600; color: var(--lavender);
    padding: 2px 0; display: inline-flex; align-items: center; gap: 4px;
  }
  .read-more:hover { text-decoration: underline; }
  .source-link {
    display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600;
    color: var(--lavender); text-decoration: none; margin: 6px 0 0; max-width: 100%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; align-self: flex-start;
  }
  /* Indented to sit under the title on a card; flush left in the detail modal. */
  li .source-link { margin-left: 30px; max-width: calc(100% - 30px); }
  .source-link:hover { text-decoration: underline; }
  /* History lives in the detail modal now, not on the card — it was a line on every card
     that almost nobody opened, and the modal is where you go when you want the whole item. */
  .history-section { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--input-border); }
  .history-section summary {
    cursor: pointer; font-family: 'Fredoka', sans-serif; font-size: 11px; color: var(--meta); font-weight: 600; list-style: none;
    padding: 2px 4px; opacity: .8;
  }
  .history-section summary::-webkit-details-marker { display: none; }
  .history-section summary:hover { opacity: 1; }
  .history-row {
    display: flex; gap: 10px; align-items: baseline; font-size: 12px; color: var(--muted);
    padding: 6px 4px 0; border-top: 1px dashed var(--card-plain-border); flex-wrap: wrap; margin-top: 4px;
  }
  .history-when { color: var(--faint); font-variant-numeric: tabular-nums; flex-shrink: 0; width: 84px; }
  .history-agent { font-weight: 700; flex-shrink: 0; width: 90px; }
  .history-action { text-transform: uppercase; font-size: 9px; font-weight: 700; opacity: .55; flex-shrink: 0; }
  .history-detail { flex: 1; min-width: 120px; word-break: break-word; }
  .via { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--meta); font-weight: 600; white-space: nowrap; }
  .via .adot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .via .session { opacity: .7; font-weight: 600; font-variant-numeric: tabular-nums; }
  .device-badge {
    display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; white-space: nowrap;
    color: var(--due-text); background: var(--due-bg); padding: 2px 8px; border-radius: 999px;
  }
  /* Unscoped: the same pill is used on the card and in the detail modal's meta row. */
  .due {
    font-family: 'Fredoka', sans-serif; font-size: 11px; font-weight: 600; color: var(--due-text);
    background: var(--due-bg); padding: 3px 10px; border-radius: 999px; flex-shrink: 0; white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .due.overdue { color: var(--overdue-text); background: var(--overdue-bg); font-weight: 700; }
  .priority-flag { width: 0; height: 0; flex-shrink: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-bottom: 7px solid; }
  .priority-flag.low { border-bottom-color: var(--muted2); }
  .priority-flag.medium { border-bottom-color: var(--accent); }
  .priority-flag.high { border-bottom-color: var(--danger); }

  .working-pill {
    position: absolute; top: -10px; right: 16px; color: #fff;
    font-family: 'Fredoka', sans-serif; font-size: 11px; font-weight: 600;
    padding: 4px 12px; border-radius: 999px; display: flex; align-items: center; gap: 5px;
    box-shadow: 0 2px 6px color-mix(in srgb, var(--work-glow, var(--accent)) 45%, transparent);
  }
  .working-pill .pulse { width: 6px; height: 6px; border-radius: 50%; background: #fff; flex-shrink: 0; animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

  li.working-card {
    box-shadow: 0 0 0 2px var(--work-glow, var(--accent)), 0 6px 20px color-mix(in srgb, var(--work-glow, var(--accent)) 18%, transparent);
    animation: working-glow 1.8s ease-in-out infinite;
  }
  @keyframes working-glow {
    0%, 100% { box-shadow: 0 0 0 2px var(--work-glow, var(--accent)), 0 6px 20px color-mix(in srgb, var(--work-glow, var(--accent)) 26%, transparent); }
    50% { box-shadow: 0 0 0 2px var(--work-glow, var(--accent)), 0 6px 20px color-mix(in srgb, var(--work-glow, var(--accent)) 8%, transparent); }
  }


  /* ---- rendered markdown -------------------------------------------------------------
     Every tag below is emitted by renderMarkdown() from text that escapeHtml() has already
     neutralised, so this list doubles as the exhaustive set of tags a description can
     produce. Nothing here comes from the stored string itself. */
  .md > *:first-child { margin-top: 0; }
  .md > *:last-child { margin-bottom: 0; }
  .md p { margin: 0 0 8px; }
  .md h3, .md h4, .md h5 { font-family: 'Fredoka', sans-serif; color: var(--text); margin: 12px 0 6px; line-height: 1.3; }
  .md h3 { font-size: 1.18em; }
  .md h4 { font-size: 1.06em; }
  .md h5 { font-size: 1em; }
  /* Stated rather than inherited, so a future bare ul/li rule cannot quietly flatten
     a description's list again. */
  .md ul, .md ol { margin: 0 0 8px; padding-left: 20px; display: block; }
  .md ul { list-style: disc; }
  .md ol { list-style: decimal; }
  .md li { margin: 2px 0; display: list-item; padding: 0; border: none; background: none; box-shadow: none; }
  .md a { color: var(--lavender); text-decoration: underline; text-underline-offset: 2px; word-break: break-word; }
  .md code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em;
    background: var(--input-bg); box-shadow: 0 0 0 1px var(--input-border); padding: 1px 5px; border-radius: 5px;
  }
  .md pre {
    margin: 0 0 8px; padding: 10px 12px; border-radius: 10px; background: var(--input-bg);
    box-shadow: 0 0 0 1px var(--input-border); overflow-x: auto;
  }
  .md pre code { background: none; box-shadow: none; padding: 0; font-size: .88em; line-height: 1.55; }
  .md blockquote { margin: 0 0 8px; padding: 2px 0 2px 12px; border-left: 3px solid var(--input-border); color: var(--muted2); }
  .md hr { border: none; border-top: 1px solid var(--input-border); margin: 12px 0; }
  .md strong { font-weight: 700; color: var(--text); }
  .md del { opacity: .6; }

  /* ---- item detail modal -------------------------------------------------------------- */
  .item-panel-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 4px; }
  .item-panel-title {
    font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 19px; line-height: 1.3;
    flex: 1; min-width: 0; word-break: break-word;
  }
  .item-panel-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0 16px; }
  .item-panel-body { font-size: 14px; color: var(--text); line-height: 1.6; }
  .item-panel-empty { font-size: 13px; color: var(--muted2); font-style: italic; }
  .item-panel-foot {
    display: flex; align-items: center; gap: 10px; justify-content: flex-end;
    margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--input-border);
  }
  .item-panel-foot button {
    border: none; border-radius: 999px; padding: 9px 18px; font-size: 13px; font-weight: 600;
    cursor: pointer; font-family: 'Fredoka', sans-serif;
  }
  .item-panel-foot .to-edit { background: var(--accent); color: #fff; }
  .item-panel-foot .dismiss { background: none; color: var(--muted2); }

  /* ---- markdown editor ---------------------------------------------------------------- */
  .md-editor { display: flex; flex-direction: column; }
  .md-bar { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; margin-bottom: 6px; }
  .md-bar button {
    border: none; background: none; color: var(--muted2); cursor: pointer; border-radius: 7px;
    min-width: 28px; height: 26px; padding: 0 7px; font-size: 12px; font-weight: 700;
    font-family: 'Karla', sans-serif; display: inline-flex; align-items: center; justify-content: center;
  }
  .md-bar button:hover { background: var(--bg); color: var(--text); }
  .md-bar .md-gap { flex: 1; }
  .md-bar .md-tab { font-family: 'Fredoka', sans-serif; font-size: 11px; font-weight: 600; padding: 0 11px; }
  .md-bar .md-tab[data-active="true"] { background: var(--ink); color: var(--ink-text); }
  /* .edit-form is prefixed deliberately: the plain .edit-form rule below has the same
     specificity and comes later, so without it the box stays at its old two-line height. */
  .edit-form .md-editor textarea.description { min-height: 220px; line-height: 1.55; }
  /* The preview stands exactly where the textarea stood, same box, so switching tabs does
     not move the dialog under the pointer. */
  .md-preview {
    display: none; min-height: 210px; padding: 10px 13px; border-radius: 12px;
    box-shadow: inset 0 0 0 1px var(--input-border); background: var(--input-bg);
    font-size: 13px; line-height: 1.55; color: var(--text); overflow-y: auto; max-height: 42vh;
  }
  .md-editor[data-mode="preview"] textarea.description { display: none; }
  .md-editor[data-mode="preview"] .md-preview { display: block; }
  .md-hint { font-size: 10.5px; color: var(--faint); margin-top: 5px; }

  .edit-body { padding: 4px 0 0; display: flex; flex-direction: column; gap: 14px; }
  .edit-field-label {
    font-family: 'Fredoka', sans-serif; font-size: 11px; font-weight: 600; color: var(--meta); margin-bottom: 5px;
  }
  .edit-form { display: flex; flex-direction: column; }
  .edit-form .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .edit-form input[type=text].title { width: 100%; font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 15px; box-shadow: inset 0 0 0 1px var(--input-border); border-radius: 12px; }
  .edit-form input[type=text].category { width: 100%; font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 12px; box-shadow: inset 0 0 0 1px var(--input-border); border-radius: 999px; text-align: center; }
  .edit-form textarea.description {
    font-family: 'Karla', sans-serif; font-size: 13px; padding: 10px 13px; box-shadow: inset 0 0 0 1px var(--input-border); border: none;
    border-radius: 12px; background: var(--input-bg); color: var(--text); resize: vertical; min-height: 58px; width: 100%;
  }
  .edit-form input[type=url].source-url {
    font-family: 'Karla', sans-serif; font-size: 13px; width: 100%; box-shadow: inset 0 0 0 1px var(--input-border); border-radius: 12px;
  }
  .edit-form select.priority, .edit-form input[type=date].due {
    font-size: 12px; font-weight: 600; padding: 8px 14px; box-shadow: inset 0 0 0 1px var(--input-border); border-radius: 999px; width: 100%;
  }
  .edit-form select.priority {
    padding-right: 30px;
  }
  .edit-form-actions {
    display: flex; gap: 10px; align-items: center; justify-content: flex-end;
    padding: 16px 0 0; margin-top: 4px; border-top: 1px solid var(--input-border);
  }
  .edit-form-actions button { border-radius: 999px; padding: 10px 18px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: 'Fredoka', sans-serif; }
  .edit-form-actions button.save { border: none; background: var(--sage); color: #fff; box-shadow: 0 3px 10px color-mix(in srgb, var(--sage) 30%, transparent); }
  .edit-form-actions button.cancel-edit { border: none; background: none; color: var(--muted2); }

  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(0);
    background: var(--card-plain-bg); border: 1px solid var(--card-plain-border); color: var(--text);
    border-radius: 999px; padding: 10px 18px; display: flex; align-items: center; gap: 14px; font-size: 13px;
    box-shadow: 0 8px 24px rgba(0,0,0,.18); opacity: 0; pointer-events: none; transition: opacity .15s ease;
    z-index: 10;
  }
  .toast.show { opacity: 1; pointer-events: auto; }
  .toast button {
    border: none; background: none; color: var(--sage); font-weight: 700; font-size: 13px; cursor: pointer; padding: 0;
    font-family: 'Fredoka', sans-serif;
  }
  .toast button[hidden] { display: none; }

  details.done-section summary {
    cursor: pointer; font-family: 'Fredoka', sans-serif; font-size: 12px; color: var(--muted2); font-weight: 600; list-style: none;
    padding: 4px 8px; display: flex; align-items: center; gap: 6px;
  }
  details.done-section summary::-webkit-details-marker { display: none; }
  details.done-section ul { margin-top: 10px; }

  .add-toggle {
    border: 2px dashed var(--card-empty-border); border-radius: 20px; padding: 14px;
    font-family: 'Fredoka', sans-serif; font-size: 13px; color: var(--meta); font-weight: 600; text-align: center; cursor: pointer;
    background: none;
  }
  .add-toggle:hover { color: var(--text); }
  form.add-form { display: none; flex-direction: column; gap: 10px; background: var(--card-plain-bg); border: 1px solid var(--card-plain-border); border-radius: 20px; padding: 16px 18px; box-shadow: var(--card-shadow); }
  form.add-form.open { display: flex; }
  form.add-form .row { display: flex; gap: 8px; }
  form.add-form input[type=text].title { flex: 1; font-family: 'Fredoka', sans-serif; font-weight: 600; }
  form.add-form input[type=text].category { width: 110px; }
  form.add-form textarea.description {
    font-family: 'Karla', sans-serif; font-size: 13px; padding: 10px 13px; box-shadow: inset 0 0 0 1px var(--input-border); border: none;
    border-radius: 12px; background: var(--input-bg); color: var(--text); resize: vertical; min-height: 52px;
  }
  form.add-form input[type=url].source-url {
    font-family: 'Karla', sans-serif; font-size: 13px; width: 100%; box-shadow: inset 0 0 0 1px var(--input-border); border-radius: 12px;
  }
  .list-picker { display: flex; gap: 8px; }
  .list-picker button {
    flex: 1; border: none; background: var(--input-bg); color: var(--muted2); box-shadow: 0 0 0 1px var(--input-border) inset;
    border-radius: 999px; padding: 8px 10px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: 'Fredoka', sans-serif;
  }
  .list-picker button[data-active="true"] { box-shadow: none; }
  .list-picker button[data-value="todo"][data-active="true"] { background: var(--sage-bg); color: var(--sage); }
  .list-picker button[data-value="backlog"][data-active="true"] { background: var(--lavender-bg); color: var(--lavender); }
  .add-form-actions { display: flex; gap: 8px; }
  button.add {
    border: none; border-radius: 999px; padding: 9px 18px; color: #ffffff; cursor: pointer; font-size: 13px; font-weight: 600;
    background: var(--sage); font-family: 'Fredoka', sans-serif; box-shadow: 0 3px 10px color-mix(in srgb, var(--sage) 30%, transparent);
  }
  button.add:hover { filter: brightness(1.05); }
  button.cancel {
    border: none; background: none; color: var(--muted2);
    border-radius: 999px; padding: 9px 12px; cursor: pointer; font-size: 13px; font-weight: 600; font-family: 'Fredoka', sans-serif;
  }
  .empty { opacity: .6; font-style: italic; padding: 10px 4px; font-size: 13px; }

  #version-footer {
    max-width: 720px; margin: 24px auto 0; text-align: center; font-size: 11px;
    color: var(--faint); font-variant-numeric: tabular-nums;
  }

  .qr-wrap {
    width: 180px; height: 180px; border-radius: 12px; background: #fff; padding: 8px; flex-shrink: 0;
    box-sizing: border-box; display: flex; align-items: center; justify-content: center; overflow: hidden;
    box-shadow: inset 0 0 0 1px var(--input-border);
  }
  .qr-wrap img { width: 164px; height: 164px; }
  .qr-loading {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; width: 100px; height: 100px;
  }
  .qr-dot {
    background: linear-gradient(135deg, var(--accent), var(--lavender)); border-radius: 5px;
    animation: qr-pulse 1.1s ease-in-out infinite; opacity: .2;
  }
  .qr-dot:nth-child(1) { animation-delay: 0s; }
  .qr-dot:nth-child(2) { animation-delay: .08s; }
  .qr-dot:nth-child(3) { animation-delay: .16s; }
  .qr-dot:nth-child(4) { animation-delay: .24s; }
  .qr-dot:nth-child(5) { animation-delay: .32s; }
  .qr-dot:nth-child(6) { animation-delay: .4s; }
  .qr-dot:nth-child(7) { animation-delay: .48s; }
  .qr-dot:nth-child(8) { animation-delay: .56s; }
  .qr-dot:nth-child(9) { animation-delay: .64s; }
  @keyframes qr-pulse {
    0%, 100% { opacity: .18; transform: scale(.75); }
    50% { opacity: 1; transform: scale(1); }
  }
  .phone-panel-title { font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 15px; margin-bottom: 4px; }
  .phone-panel-hint { font-size: 12px; color: var(--muted2); }

  .devices-badge {
    position: absolute; top: -4px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px;
    background: var(--accent); color: #fff; font-size: 10px; font-weight: 700; line-height: 16px; text-align: center;
    box-shadow: 0 0 0 2px var(--bg); font-family: 'Fredoka', sans-serif;
  }
  #devices-toggle { position: relative; }

  /* One shell for every modal in the app — the devices panel, export, item detail and edit
     all sit in the same box, so they stay the same box when one of them changes. */
  dialog.devices-panel, dialog.item-panel, dialog.edit-panel {
    max-width: 680px; width: calc(100% - 40px); max-height: 82vh; overflow-y: auto;
    margin: auto; background: var(--card-plain-bg); border: 1px solid var(--card-plain-border); color: var(--text);
    border-radius: 20px; padding: 20px 22px; box-shadow: var(--card-shadow);
  }
  dialog.devices-panel::backdrop, dialog.item-panel::backdrop, dialog.edit-panel::backdrop {
    background: rgba(20,15,8,.5); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
  }
  dialog.item-panel { max-width: 640px; }
  dialog.edit-panel { max-width: 620px; }
  .modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .modal-close {
    border: none; background: var(--input-bg); color: var(--muted); border-radius: 50%; width: 30px; height: 30px;
    display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; padding: 0;
  }
  .modal-close svg { width: 14px; height: 14px; }
  .devices-title { font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 16px; }
  .devices-subtitle { font-size: 12px; color: var(--muted2); margin-top: 2px; }
  .devices-explainer { font-size: 12.5px; color: var(--muted); line-height: 1.5; margin: 0 0 16px; }

  .modal-tabs { display: flex; gap: 8px; margin: 16px 0 14px; }
  .modal-tab {
    border: none; background: var(--input-bg); color: var(--muted); box-shadow: 0 0 0 1px var(--input-border) inset;
    border-radius: 999px; padding: 7px 16px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: 'Fredoka', sans-serif;
    display: flex; align-items: center; gap: 6px;
  }
  .modal-tab[data-active="true"] { background: var(--ink); color: var(--ink-text); box-shadow: none; }
  .modal-pane[hidden] { display: none; }
  .tab-badge {
    background: var(--accent); color: #fff; font-size: 10px; font-weight: 700; border-radius: 999px; padding: 1px 6px; line-height: 1.4;
  }
  .modal-tab[data-active="true"] .tab-badge { background: rgba(255,255,255,.25); }

  .row-badge {
    font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 999px; font-family: 'Fredoka', sans-serif; flex-shrink: 0;
  }
  .row-badge.sync { background: var(--sage-bg); color: var(--sage); }
  .row-badge.viewer { background: var(--lavender-bg); color: var(--lavender); }
  .row-badge.trust-trusted { background: var(--sage-bg); color: var(--sage); }
  .row-badge.trust-verified { background: var(--due-bg); color: var(--accent); }
  .row-badge.trust-pending { background: var(--input-bg); color: var(--muted2); box-shadow: 0 0 0 1px var(--card-plain-border) inset; }
  .row-badge.trust-revoked { background: var(--due-bg); color: var(--danger); }

  .devices-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 4px; }
  .device-row {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 12px; flex-wrap: wrap;
    background: var(--input-bg); box-shadow: 0 0 0 1px var(--card-plain-border);
  }
  .device-row .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .device-row .dot.ok { background: var(--sage); }
  .device-row .dot.fail { background: var(--danger); }
  .device-row .name { font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 13px; flex: 1; }
  .device-row .meta { font-size: 11px; color: var(--muted2); }
  .device-row .unpair, .device-row .peer-revoke {
    border: none; background: none; color: var(--muted2); cursor: pointer; font-size: 11px; font-weight: 700;
    padding: 4px 8px; border-radius: 999px; font-family: 'Fredoka', sans-serif;
  }
  .device-row .unpair:hover { color: var(--danger); background: var(--bg); }
  .device-row .peer-revoke:hover { color: var(--accent); background: var(--bg); }
  .device-row-details {
    flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 10.5px; color: var(--muted2);
    padding-top: 6px; margin-top: 2px; border-top: 1px dashed var(--card-plain-border);
  }
  .device-row-details .err { color: var(--danger); }
  .device-row-details button {
    border: none; background: none; color: var(--accent); cursor: pointer; font-size: 10.5px; font-weight: 600;
    font-family: 'Fredoka', sans-serif; padding: 0;
  }

  .presence-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 4px; }
  .presence-row { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 11.5px; color: var(--muted2); }
  .presence-row .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .presence-row .dot.active { background: var(--sage); }
  .presence-row .dot.idle { background: var(--muted2); }
  .presence-row .who { font-weight: 600; color: var(--ink); }

  .devices-incoming { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
  .devices-incoming[hidden] { display: none; }
  .incoming-row {
    display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 12px;
    background: var(--due-bg); box-shadow: 0 0 0 2px var(--accent) inset;
  }
  .incoming-row .name { font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 13px; flex: 1; color: var(--text); }
  .incoming-row .meta { font-size: 11px; color: var(--muted2); display: block; }
  .incoming-row .meta.sas-verify { color: var(--accent); margin-top: 2px; }
  .incoming-row .meta.sas-verify strong { font-family: ui-monospace, monospace; letter-spacing: .05em; }
  .incoming-row button {
    border: none; border-radius: 999px; padding: 6px 14px; font-size: 12px; font-weight: 700; cursor: pointer;
    font-family: 'Fredoka', sans-serif;
  }
  .incoming-row button.approve { background: var(--sage); color: #fff; }
  .incoming-row button.deny { background: var(--input-bg); color: var(--muted2); }

  .activity-log { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .activity-log[hidden] { display: none; }
  .activity-row {
    display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 11.5px; color: var(--muted2);
  }
  .activity-row .status { font-weight: 700; flex-shrink: 0; }
  .activity-row .status.approved { color: var(--sage); }
  .activity-row .status.denied { color: var(--danger); }
  .activity-row .status.expired { color: var(--muted2); }
  .activity-row .label { flex: 1; color: var(--muted); }
  .activity-row .when { flex-shrink: 0; }

  .devices-pair { border-top: 1px dashed var(--card-plain-border); padding-top: 16px; }
  .devices-pair-tabs { display: flex; gap: 8px; margin-bottom: 14px; }
  .pair-tab {
    border: none; background: var(--input-bg); color: var(--muted); box-shadow: 0 0 0 1px var(--input-border) inset;
    border-radius: 999px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: 'Fredoka', sans-serif;
  }
  .pair-tab[data-active="true"] { background: var(--ink); color: var(--ink-text); box-shadow: none; }
  .devices-pair-pane[hidden] { display: none; }
  .devices-pair-row { display: flex; gap: 14px; align-items: flex-start; }
  .devices-pair-text { flex: 1; min-width: 0; }
  .pair-short-code {
    font-family: ui-monospace, monospace; font-size: 26px; font-weight: 700; letter-spacing: .18em;
    color: var(--accent); margin-bottom: 8px;
  }
  textarea.devices-pair-code {
    width: 100%; font-family: ui-monospace, monospace; font-size: 11.5px; resize: none;
    box-shadow: inset 0 0 0 1px var(--input-border); border-radius: 10px; padding: 8px 10px;
  }
  .devices-pair-input {
    width: 100%; font-family: ui-monospace, monospace; font-size: 14px;
    box-shadow: inset 0 0 0 1px var(--input-border); border-radius: 10px; padding: 9px 12px;
  }
  .pair-code-field { letter-spacing: .3em; font-size: 18px; font-weight: 700; text-transform: uppercase; max-width: 180px; }
  .btn-connect {
    border: none; border-radius: 999px; padding: 9px 18px; color: #fff; cursor: pointer; font-size: 13px; font-weight: 600;
    background: var(--sage); font-family: 'Fredoka', sans-serif; flex-shrink: 0;
  }
  .devices-pair-status { font-size: 12px; color: var(--muted2); }
`;
