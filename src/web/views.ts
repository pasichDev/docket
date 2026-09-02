export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Docket</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%236C3BFF'/%3E%3Cstop offset='1' stop-color='%2300D4C8'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='8' fill='url(%23g)'/%3E%3Cpolyline points='8,17 13,22 24,11' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3C/svg%3E">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Karla:wght@400;500;600;700&display=swap">
<style>
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
  .synced { font-size: 12px; color: var(--muted); font-weight: 600; }
  .synced .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--sage); margin-right: 6px; }
  .synced .dot.fail { background: #4a4a4a; }

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

  .toolbar { display: flex; gap: 8px; align-items: center; }
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

  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }

  li {
    border-radius: 20px; padding: 16px 18px; display: flex; flex-direction: column; gap: 8px;
    background: var(--card-plain-bg); border: 1px solid var(--card-plain-border); box-shadow: var(--card-shadow);
    position: relative;
  }
  li.done { opacity: .55; }
  li.done .card-title { text-decoration: line-through; }
  .card-top { display: flex; align-items: flex-start; gap: 6px; justify-content: space-between; }
  .card-top-left { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; row-gap: 6px; }
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
  .card-body { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 600; }
  .card-body .id { opacity: .4; font-weight: 700; font-size: 11px; font-variant-numeric: tabular-nums; font-family: 'Karla', sans-serif; }
  .card-body input[type=checkbox] {
    appearance: none; -webkit-appearance: none; width: 20px; height: 20px; margin: 2px 0 0; flex-shrink: 0;
    cursor: pointer; border: 2px solid var(--checkbox-border); border-radius: 7px; background: transparent;
  }
  .card-body input[type=checkbox]:checked {
    background-color: var(--sage); border-color: var(--sage);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Cpath d='M5 9.2 7.6 11.8 13 6' stroke='white' stroke-width='1.8' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: center; background-size: 12px 12px;
  }
  .card-body .txt { flex: 1; word-break: break-word; }
  .card-title { font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 16px; word-break: break-word; }
  .card-desc {
    font-family: 'Karla', sans-serif; font-weight: 400; font-size: 13px; color: var(--muted);
    line-height: 1.5; white-space: pre-wrap; word-break: break-word; margin-top: 2px;
  }
  .source-link {
    display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600;
    color: var(--lavender); text-decoration: none; margin-top: 6px; max-width: 100%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .source-link:hover { text-decoration: underline; }
  .history-section { margin-top: 4px; }
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
  .card-body .due {
    font-family: 'Fredoka', sans-serif; font-size: 11px; font-weight: 600; color: var(--due-text);
    background: var(--due-bg); padding: 3px 10px; border-radius: 999px; flex-shrink: 0; white-space: nowrap;
  }
  .card-body .due.overdue { color: var(--overdue-text); background: var(--overdue-bg); font-weight: 700; }
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


  .edit-card { padding: 0; overflow: hidden; box-shadow: 0 0 0 2px var(--accent), 0 10px 30px color-mix(in srgb, var(--accent) 16%, transparent); }
  .edit-header {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 14px 18px; background: var(--accent); color: #fff;
  }
  .edit-header-left { display: flex; align-items: center; gap: 8px; }
  .edit-header-title { font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 14px; }
  .edit-header-via { font-size: 11px; color: rgba(255,255,255,.85); font-weight: 600; }
  .edit-body { padding: 18px 18px 4px; display: flex; flex-direction: column; gap: 14px; }
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
  .edit-form-actions { display: flex; gap: 10px; align-items: center; justify-content: flex-end; padding: 14px 18px; }
  .edit-form-actions button { border-radius: 999px; padding: 10px 18px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: 'Fredoka', sans-serif; }
  .edit-form-actions button.save { border: none; background: var(--sage); color: #fff; box-shadow: 0 3px 10px color-mix(in srgb, var(--sage) 30%, transparent); }
  .edit-form-actions button.cancel-edit { border: none; background: none; color: var(--muted2); }
  .edit-card .history-section { margin: 0 18px 14px; }

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

  dialog.devices-panel {
    max-width: 680px; width: calc(100% - 40px); max-height: 82vh; overflow-y: auto;
    margin: auto; background: var(--card-plain-bg); border: 1px solid var(--card-plain-border); color: var(--text);
    border-radius: 20px; padding: 20px 22px; box-shadow: var(--card-shadow);
  }
  dialog.devices-panel::backdrop { background: rgba(20,15,8,.5); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
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

  .devices-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 4px; }
  .device-row {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 12px;
    background: var(--input-bg); box-shadow: 0 0 0 1px var(--card-plain-border);
  }
  .device-row .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .device-row .dot.ok { background: var(--sage); }
  .device-row .dot.fail { background: var(--danger); }
  .device-row .name { font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 13px; flex: 1; }
  .device-row .meta { font-size: 11px; color: var(--muted2); }
  .device-row .unpair {
    border: none; background: none; color: var(--muted2); cursor: pointer; font-size: 11px; font-weight: 700;
    padding: 4px 8px; border-radius: 999px; font-family: 'Fredoka', sans-serif;
  }
  .device-row .unpair:hover { color: var(--danger); background: var(--bg); }

  .devices-incoming { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
  .devices-incoming[hidden] { display: none; }
  .incoming-row {
    display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 12px;
    background: var(--due-bg); box-shadow: 0 0 0 2px var(--accent) inset;
  }
  .incoming-row .name { font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 13px; flex: 1; color: var(--text); }
  .incoming-row .meta { font-size: 11px; color: var(--muted2); display: block; }
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
</style>
</head>
<body>
  <header>
    <h1>Docket</h1>
    <div class="header-right">
      <div class="synced"><span class="dot"></span><span id="synced-text">syncing…</span></div>
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
          <input type="text" class="devices-pair-input" id="pair-host-input" placeholder="192.168.1.42:8787" autocomplete="off" />
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

  <div class="page">
    <div class="tags">
      <button class="tag" data-tag="all" data-active="true" type="button"><span class="dot"></span>All <span class="n" data-count="all"></span></button>
      <button class="tag" data-tag="todo" data-active="false" type="button"><span class="dot"></span>Todo <span class="n" data-count="todo"></span></button>
      <button class="tag" data-tag="backlog" data-active="false" type="button"><span class="dot"></span>Backlog <span class="n" data-count="backlog"></span></button>
    </div>

    <div class="toolbar">
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

    <div class="count-line"><span class="open-count"></span></div>

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

<script>
let lastSync = null;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function isDark() {
  return document.documentElement.dataset.theme !== "light";
}

function categoryTint(cat) {
  if (!cat) return null;
  let hash = 0;
  for (let i = 0; i < cat.length; i++) hash = (hash * 31 + cat.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const dark = isDark();
  return {
    chipBg: \`hsl(\${hue} \${dark ? "35% 22%" : "65% 85%"})\`,
    chipText: \`hsl(\${hue} \${dark ? "65% 75%" : "55% 32%"})\`,
    rot: \`\${((hash % 3) - 1) * 1.5}deg\`,
  };
}

function agentColor(agent) {
  if (!agent) return "#94a3b8";
  let hash = 0;
  for (let i = 0; i < agent.length; i++) hash = (hash * 31 + agent.charCodeAt(i)) >>> 0;
  return \`hsl(\${hash % 360} 55% 55%)\`;
}

function sageHex() {
  return isDark() ? "#7fc492" : "#3f7a50";
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isOverdue(t) {
  return !t.done && t.dueDate && t.dueDate < todayStr();
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

// "\\uffff" sorts after any real value, so items missing the sort key land last.
const byId = (a, b) => a.id - b.id;
const COMPARATORS = {
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
  az: (a, b) => a.title.localeCompare(b.title),
  category: (a, b) => (a.category || "\\uffff").localeCompare(b.category || "\\uffff") || byId(a, b),
  priority: (a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) || byId(a, b),
  due: (a, b) => (a.dueDate || "\\uffff").localeCompare(b.dueDate || "\\uffff") || byId(a, b),
};

function sortItems(items, mode) {
  const cmp = COMPARATORS[mode] ?? byId;
  // Claimed/in-progress items always come first, regardless of sort mode.
  return [...items].sort((a, b) => Number(!!b.workingAgent) - Number(!!a.workingAgent) || cmp(a, b));
}

let editingId = null;

function itemHtml(t) {
  if (t.id === editingId) return editFormHtml(t);

  const tint = categoryTint(t.category);
  const cardStyle = t.workingAgent ? \` style="--work-glow:\${agentColor(t.workingAgent)};"\` : "";
  const badge = t.category
    ? \`<span class="badge" style="background:\${tint.chipBg}; color:\${tint.chipText}; --badge-rot:\${tint.rot}">\${escapeHtml(t.category)}</span>\`
    : "";
  const listBadge = \`<span class="list-badge \${t.list}"><span class="dot"></span>\${t.list === "todo" ? "Todo" : "Backlog"}</span>\`;
  const priorityFlag = t.priority ? \`<span class="priority-flag \${t.priority}" title="\${t.priority} priority"></span>\` : "";
  // Done items show a static tick (no un-completing from the UI); open ones a live checkbox.
  const checkbox = t.done
    ? \`<span style="display:flex"><svg viewBox="0 0 18 18" width="18" height="18"><rect x="1.5" y="1.5" width="15" height="15" rx="6" fill="\${sageHex()}"/><path d="M5 9.2 7.6 11.8 13 6" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>\`
    : '<input type="checkbox" />';
  const due = t.dueDate
    ? \`<span class="due \${isOverdue(t) ? "overdue" : ""}">\${isOverdue(t) ? "overdue " : ""}\${t.dueDate}</span>\`
    : "";
  const via = t.agent
    ? \`<span class="via" title="\${t.session ? \`session \${escapeHtml(t.session)}\` : "no session (web)"}"><span class="adot" style="background:\${agentColor(t.agent)}"></span>via \${escapeHtml(t.agent)}\${t.session ? \` <span class="session">#\${escapeHtml(t.session)}</span>\` : ""}</span>\`
    : "";
  const workingPill = t.workingAgent
    ? \`<span class="working-pill" style="background:\${agentColor(t.workingAgent)}"><span class="pulse"></span>working — \${escapeHtml(t.workingAgent)}</span>\`
    : "";
  return \`
    <li class="\${t.done ? "done" : ""} \${t.workingAgent ? "working-card" : ""}" data-id="\${t.id}"\${cardStyle}>
      \${workingPill}
      <div class="card-top">
        <span class="card-top-left">\${priorityFlag}\${listBadge}\${badge}\${via}</span>
        <span class="card-actions">
          <button class="edit" title="Edit">✎</button>
          <button class="del" title="Delete">✕</button>
        </span>
      </div>
      <div class="card-body">
        \${checkbox}
        <span class="id">#\${t.id}</span>
        <span class="card-title">\${escapeHtml(t.title)}</span>
        \${due}
      </div>
      \${t.description ? \`<div class="card-desc">\${escapeHtml(t.description)}</div>\` : ""}
      \${sourceLinkHtml(t.sourceUrl)}
      \${historyHtml(t)}
    </li>\`;
}

function sourceHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\\./, "");
  } catch {
    return "source";
  }
}

function sourceLinkHtml(url) {
  if (!url) return "";
  return \`<a class="source-link" href="\${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="\${escapeHtml(url)}">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
    \${escapeHtml(sourceHost(url))}
  </a>\`;
}

function historyHtml(t) {
  if (!t.history || t.history.length === 0) return "";
  const rows = [...t.history]
    .reverse()
    .map(
      (h) => \`
        <div class="history-row">
          <span class="history-when">\${h.at.slice(0, 16).replace("T", " ")}</span>
          <span class="history-agent" style="color:\${agentColor(h.agent)}">\${escapeHtml(h.agent || "unknown")}</span>
          <span class="history-action">\${h.action}</span>
          <span class="history-detail">\${escapeHtml(h.detail)}</span>
        </div>\`
    )
    .join("");
  return \`
    <details class="history-section">
      <summary>History (\${t.history.length})</summary>
      \${rows}
    </details>\`;
}

function editFormHtml(t) {
  const priorityOptions = ["", "low", "medium", "high"]
    .map((p) => \`<option value="\${p}" \${(t.priority || "") === p ? "selected" : ""}>\${p ? p[0].toUpperCase() + p.slice(1) : "No priority"}</option>\`)
    .join("");
  const via = t.agent ? \`via \${escapeHtml(t.agent)}\${t.session ? \` · \${escapeHtml(t.session)}\` : ""}\` : "";
  return \`
    <li class="edit-card" data-id="\${t.id}" data-editing="true">
      <form class="edit-form">
        <div class="edit-header">
          <div class="edit-header-left">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            <span class="edit-header-title">Editing #\${t.id}</span>
          </div>
          \${via ? \`<span class="edit-header-via">\${via}</span>\` : ""}
        </div>
        <div class="edit-body">
          <div>
            <div class="edit-field-label">Title</div>
            <input type="text" class="title" value="\${escapeHtml(t.title)}" required />
          </div>
          <div>
            <div class="edit-field-label">Description</div>
            <textarea class="description" placeholder="Description (optional)…" rows="3">\${escapeHtml(t.description || "")}</textarea>
          </div>
          <div>
            <div class="edit-field-label">Source link</div>
            <input type="url" class="source-url" placeholder="https://github.com/… , Notion, Obsidian, etc." value="\${escapeHtml(t.sourceUrl || "")}" />
          </div>
          <div class="row">
            <div>
              <div class="edit-field-label">Category</div>
              <input type="text" class="category" placeholder="category" value="\${escapeHtml(t.category || "")}" />
            </div>
            <div>
              <div class="edit-field-label">Priority</div>
              <select class="priority">\${priorityOptions}</select>
            </div>
            <div>
              <div class="edit-field-label">Due date</div>
              <input type="date" class="due" value="\${t.dueDate || ""}" />
            </div>
          </div>
        </div>
        <div class="edit-form-actions">
          <button class="cancel-edit" type="button">Cancel</button>
          <button class="save" type="submit">Save changes</button>
        </div>
      </form>
      \${historyHtml(t)}
    </li>\`;
}

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

function applyTagCounts(todos) {
  const counts = { all: todos.length, todo: 0, backlog: 0 };
  for (const t of todos) counts[t.list] = (counts[t.list] ?? 0) + 1;
  for (const tag of ["all", "todo", "backlog"]) {
    document.querySelector(\`[data-count="\${tag}"]\`).textContent = counts[tag] ?? 0;
  }
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
      // Protect a card's live inputs ONLY when it was already showing the edit form and
      // still should be (an unrelated background refresh landing mid-edit) — comparing
      // just the node's own stale dataset would also block entering/exiting edit mode
      // (Save/Cancel set editingId then re-render expecting the swap to actually happen).
      const wasEditing = node.dataset.editing === "true";
      const staysEditing = key === String(editingId);
      if (!(wasEditing && staysEditing) && node.__lastHtml !== html) {
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
  applyTagCounts(todos);

  const search = document.querySelector(".search").value.trim().toLowerCase();
  const sortMode = document.querySelector(".sort").value;

  let items = activeTag === "all" ? todos : todos.filter((t) => t.list === activeTag);
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

  // A card mid-edit is never overwritten by this — see reconcileList's
  // dataset.editing check — so an in-progress refresh can't wipe unsaved input.
  const openListEl = document.querySelector(".open-list");
  const doneListEl = document.querySelector(".done-list");

  document.querySelector(".open-count").textContent = \`\${open.length} open\`;
  setEmptyPlaceholder(openListEl, open.length === 0, "Nothing open.");
  reconcileList(openListEl, open, itemHtml, (t) => t.id);
  reconcileList(doneListEl, done, itemHtml, (t) => t.id);
  document.querySelector(".done-count").textContent = \`(\${done.length})\`;
}

let syncFailed = false;

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
  const dot = document.querySelector(".synced .dot");
  const el = document.getElementById("synced-text");
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
  try { localStorage.setItem("todo-mcp-theme", theme); } catch {}
}

(function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem("todo-mcp-theme"); } catch {}
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

// --- Devices: pairing + sync modal ---

let devicesLoaded = false;
let devicesPollTimer = null;
let outgoingPollTimer = null;
let isHostBrowserFlag = false;
const seenRequestIds = new Set();

function timeAgo(iso) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return \`\${s}s ago\`;
  if (s < 3600) return \`\${Math.round(s / 60)}m ago\`;
  if (s < 86400) return \`\${Math.round(s / 3600)}h ago\`;
  return \`\${Math.round(s / 86400)}d ago\`;
}

async function loadDeviceInfo() {
  try {
    const d = await (await fetch("/api/device")).json();
    isHostBrowserFlag = !!d.isHostBrowser;
    document.getElementById("this-device-name").textContent = d.name + (d.role === "guest" ? " (guest)" : "");
    const canManage = d.role !== "guest" && d.isHostBrowser;
    document.getElementById("devices-pair-section").hidden = !canManage;
    const noteEl = document.getElementById("guest-note");
    noteEl.hidden = canManage;
    if (!canManage) {
      noteEl.innerHTML =
        d.role === "guest"
          ? \`This device joined an existing group via someone else's invite, so it's a
             <strong>guest</strong> — it stays in sync, but only the device that invited
             it can invite or approve further devices. Unpair to leave and become a
             host again.\`
          : "Only this device's own browser can manage pairing and approve new connections.";
    }
    document.getElementById("devices-requests").hidden = !isHostBrowserFlag;
    if (canManage && !devicesLoaded) {
      devicesLoaded = true;
      generateInvite();
    }
  } catch {
    document.getElementById("this-device-name").textContent = "unknown";
  }
}

/**
 * Background poll (host browser only) for pairing + viewer-access requests. Updates the
 * badge on the Devices icon, and pops the modal open the moment a request this browser
 * hasn't seen yet shows up — closing it again without acting doesn't re-trigger the popup
 * for the same request.
 */
async function pollNotifications() {
  if (!isHostBrowserFlag) {
    document.getElementById("notif-badge").hidden = true;
    return;
  }
  try {
    const [pairing, access] = await Promise.all([
      fetch("/api/pair/incoming").then((r) => r.json()),
      fetch("/api/access/pending").then((r) => r.json()),
    ]);
    const requests = [...(pairing.requests ?? []), ...(access.requests ?? [])];
    const notifBadge = document.getElementById("notif-badge");
    notifBadge.hidden = requests.length === 0;
    notifBadge.textContent = String(requests.length);

    const hasUnseen = requests.some((r) => !seenRequestIds.has(r.requestId));
    for (const r of requests) seenRequestIds.add(r.requestId);
    if (hasUnseen && !document.getElementById("devices-panel").open) openDevicesModal();
  } catch {
    // quiet — background nicety, not core functionality
  }
}

async function refreshDevicesPanel() {
  try {
    const { peers } = await (await fetch("/api/peers")).json();
    const listEl = document.getElementById("devices-list");
    listEl.innerHTML = peers
      .map(
        (p) => \`
        <div class="device-row" data-id="\${p.id}">
          <span class="dot \${p.lastSyncOk === false ? "fail" : "ok"}"></span>
          <span class="name">\${escapeHtml(p.name)}</span>
          <span class="row-badge sync">Sync</span>
          <span class="meta">synced \${timeAgo(p.lastSyncAt)}</span>
          <button class="unpair" data-id="\${p.id}" type="button">Unpair</button>
        </div>\`
      )
      .join("");
  } catch (err) {
    console.error("devices refresh failed", err);
  }

  try {
    const { viewers } = await (await fetch("/api/access/viewers")).json();
    const viewersEl = document.getElementById("access-viewers-list");
    viewersEl.innerHTML = viewers
      .map(
        (v) => \`
        <div class="device-row" data-id="\${v.id}">
          <span class="dot ok"></span>
          <span class="name">\${escapeHtml(v.label)}</span>
          <span class="row-badge viewer">Viewer</span>
          <span class="meta">seen \${timeAgo(v.lastSeenAt)}</span>
          <button class="unpair viewer-revoke" data-id="\${v.id}" type="button">Revoke</button>
        </div>\`
      )
      .join("");
  } catch (err) {
    console.error("access refresh failed", err);
  }

  const connectedCount = document.getElementById("devices-list").children.length + document.getElementById("access-viewers-list").children.length;
  if (connectedCount === 0) {
    document.getElementById("devices-list").innerHTML = '<div class="phone-panel-hint">Nothing connected yet.</div>';
  }
  const devicesTabBadge = document.getElementById("devices-tab-badge");
  devicesTabBadge.hidden = connectedCount === 0;
  devicesTabBadge.textContent = String(connectedCount);

  if (isHostBrowserFlag) {
    try {
      const { requests: pairingRequests } = await (await fetch("/api/pair/incoming")).json();
      const incomingEl = document.getElementById("devices-incoming");
      incomingEl.hidden = pairingRequests.length === 0;
      incomingEl.innerHTML = pairingRequests
        .map(
          (r) => \`
        <div class="incoming-row" data-id="\${r.requestId}">
          <span>
            <span class="name">Pairing request from \${escapeHtml(r.deviceName)}</span>
            <span class="meta">wants to share this list with this device</span>
          </span>
          <button class="approve" data-id="\${r.requestId}" type="button">Approve</button>
          <button class="deny" data-id="\${r.requestId}" type="button">Deny</button>
        </div>\`
        )
        .join("");

      const { requests: accessRequests } = await (await fetch("/api/access/pending")).json();
      const accessIncomingEl = document.getElementById("access-incoming");
      accessIncomingEl.hidden = accessRequests.length === 0;
      accessIncomingEl.innerHTML = accessRequests
        .map(
          (r) => \`
        <div class="incoming-row" data-id="\${r.requestId}">
          <span>
            <span class="name">Access request from \${escapeHtml(r.ip)}</span>
            <span class="meta">wants to view/edit this list in a browser</span>
          </span>
          <button class="approve" data-id="\${r.requestId}" type="button">Approve</button>
          <button class="deny" data-id="\${r.requestId}" type="button">Deny</button>
        </div>\`
        )
        .join("");

      // Resolved/expired history — the still-"pending" ones above already have their own cards.
      const { events } = await (await fetch("/api/notifications")).json();
      const past = events.filter((e) => e.status !== "pending");
      const logEl = document.getElementById("activity-log");
      logEl.hidden = past.length === 0;
      logEl.innerHTML = past
        .map(
          (e) => \`
        <div class="activity-row">
          <span class="status \${e.status}">\${e.status}</span>
          <span class="label">\${e.kind === "pairing" ? "Pairing" : "Access"} request from \${escapeHtml(e.label)}</span>
          <span class="when">\${timeAgo(new Date(e.resolvedAt ?? e.createdAt).toISOString())}</span>
        </div>\`
        )
        .join("");
    } catch (err) {
      console.error("requests refresh failed", err);
    }
  }
}

async function generateInvite() {
  const textarea = document.getElementById("pair-invite-text");
  const shortCode = document.getElementById("pair-short-code");
  const img = document.getElementById("pair-qr");
  const loading = document.getElementById("pair-qr-loading");
  textarea.value = "Generating…";
  shortCode.textContent = "······";
  img.hidden = true;
  loading.style.display = "grid";
  try {
    const invite = await (await fetch("/api/pair/invite", { method: "POST" })).json();
    if (invite.error) {
      textarea.value = invite.error;
      loading.style.display = "none";
      return;
    }
    const code = \`\${invite.url}?pair=\${invite.token}\`;
    textarea.value = code;
    shortCode.textContent = invite.token;
    img.onload = () => {
      loading.style.display = "none";
      img.hidden = false;
    };
    img.src = \`/api/qr?text=\${encodeURIComponent(code)}\`;
  } catch {
    textarea.value = "Couldn't generate a code — is this device on a network?";
    shortCode.textContent = "······";
    loading.style.display = "none";
  }
}

async function openDevicesModal() {
  const panel = document.getElementById("devices-panel");
  if (!panel.open) panel.showModal();
  document.getElementById("this-device-name").textContent = "…";
  await loadDeviceInfo();
  refreshDevicesPanel();
  clearInterval(devicesPollTimer);
  devicesPollTimer = setInterval(refreshDevicesPanel, 4000);
}

function closeDevicesModal() {
  const panel = document.getElementById("devices-panel");
  if (panel.open) panel.close();
  clearInterval(devicesPollTimer);
  devicesPollTimer = null;
}

document.getElementById("devices-toggle").addEventListener("click", openDevicesModal);
document.getElementById("devices-modal-close").addEventListener("click", closeDevicesModal);
document.getElementById("devices-panel").addEventListener("close", closeDevicesModal);
// Click on the ::backdrop lands on the <dialog> element itself, not its content — but so
// does a click in the dialog's own padding (target.id alone can't tell them apart), so
// check the click was actually outside the dialog's box, not just "target is the dialog".
document.getElementById("devices-panel").addEventListener("click", (e) => {
  const panel = document.getElementById("devices-panel");
  if (e.target !== panel) return;
  const r = panel.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside) closeDevicesModal();
});

document.getElementById("export-toggle").addEventListener("click", () => {
  document.getElementById("export-panel").showModal();
});
document.getElementById("export-modal-close").addEventListener("click", () => {
  document.getElementById("export-panel").close();
});
document.getElementById("export-panel").addEventListener("click", (e) => {
  const panel = document.getElementById("export-panel");
  if (e.target !== panel) return;
  const r = panel.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside) panel.close();
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
  if (!e.target.matches(".unpair")) return;
  const id = e.target.dataset.id;
  e.target.disabled = true;
  await fetch(\`/api/peers/\${id}\`, { method: "DELETE" });
  refreshDevicesPanel();
});

document.getElementById("devices-incoming").addEventListener("click", async (e) => {
  const id = e.target.dataset.id;
  if (!id) return;
  if (e.target.matches(".approve")) {
    e.target.disabled = true;
    await fetch(\`/api/pair/approve/\${id}\`, { method: "POST" });
    refreshDevicesPanel();
  } else if (e.target.matches(".deny")) {
    e.target.disabled = true;
    await fetch(\`/api/pair/deny/\${id}\`, { method: "POST" });
    refreshDevicesPanel();
  }
});

document.getElementById("access-incoming").addEventListener("click", async (e) => {
  const id = e.target.dataset.id;
  if (!id) return;
  if (e.target.matches(".approve")) {
    e.target.disabled = true;
    await fetch(\`/api/access/approve/\${id}\`, { method: "POST" });
    refreshDevicesPanel();
  } else if (e.target.matches(".deny")) {
    e.target.disabled = true;
    await fetch(\`/api/access/deny/\${id}\`, { method: "POST" });
    refreshDevicesPanel();
  }
});

document.getElementById("access-viewers-list").addEventListener("click", async (e) => {
  if (!e.target.matches(".unpair")) return;
  const id = e.target.dataset.id;
  e.target.disabled = true;
  await fetch(\`/api/access/viewers/\${id}\`, { method: "DELETE" });
  refreshDevicesPanel();
});

document.getElementById("pair-redeem-btn").addEventListener("click", async () => {
  const hostInput = document.getElementById("pair-host-input");
  const codeInput = document.getElementById("pair-code-input");
  const status = document.getElementById("pair-status-text");
  let host = hostInput.value.trim();
  let token = codeInput.value.trim().toUpperCase();
  // Someone pasting the full "host?pair=CODE" line into the host field still works.
  if (host.includes("?pair=")) {
    const [h, c] = host.split("?pair=");
    host = h.trim();
    if (!token) token = c.trim().toUpperCase();
  }
  if (!host || !token) {
    status.textContent = "Enter both the host address and the code.";
    return;
  }
  const peerUrl = /^https?:\\/\\//.test(host) ? host : \`http://\${host}\`;
  status.textContent = "Connecting…";
  try {
    const res = await fetch("/api/pair/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerUrl, token }),
    });
    const body = await res.json();
    if (!res.ok) {
      status.textContent = body.error || "Couldn't connect.";
      return;
    }
    status.textContent = "Waiting for approval on the other device…";
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
    body: JSON.stringify({ title, description, list: addFormList, category, priority, dueDate, sourceUrl }),
  });
  closeAddForm();
  refresh();
});

const toast = document.getElementById("toast");
const toastText = document.getElementById("toast-text");
const toastUndo = document.getElementById("toast-undo");
let toastTimer = null;
let lastDeleted = null;

function showUndoToast(deletedTodo) {
  lastDeleted = deletedTodo;
  toastText.textContent = \`Deleted "\${deletedTodo.title.slice(0, 40)}\${deletedTodo.title.length > 40 ? "…" : ""}"\`;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 6000);
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
  } else if (e.target.matches("button.edit")) {
    editingId = id;
    render(allTodos);
  } else if (e.target.matches("button.cancel-edit")) {
    editingId = null;
    render(allTodos);
  }
});

document.querySelector(".page").addEventListener("submit", async (e) => {
  if (!e.target.matches(".edit-form")) return;
  e.preventDefault();
  const li = e.target.closest("li[data-id]");
  const id = Number(li.dataset.id);
  const title = e.target.querySelector(".title").value.trim();
  if (!title) return;
  const description = e.target.querySelector(".description").value.trim();
  const category = e.target.querySelector(".category").value.trim();
  const priority = e.target.querySelector(".priority").value;
  const dueDate = e.target.querySelector(".due").value;
  const sourceUrl = e.target.querySelector(".source-url").value.trim();
  await fetch(\`/api/todos/\${id}\`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, description, category, priority, dueDate, sourceUrl }),
  });
  editingId = null;
  refresh();
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
</script>
</body>
</html>
`;

/**
 * Served instead of the app to any browser that isn't this machine and doesn't
 * already carry an approved viewer cookie — nothing about the list (not even
 * whether it's empty) is visible until the host explicitly approves the request.
 */
export const GATE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Docket</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%236C3BFF'/%3E%3Cstop offset='1' stop-color='%2300D4C8'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='8' fill='url(%23g)'/%3E%3Cpolyline points='8,17 13,22 24,11' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3C/svg%3E">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Karla:wght@400;500;600;700&display=swap">
<style>
  :root {
    color-scheme: light dark;
    --bg: #faf5ec; --text: #3d3229; --muted: #8a7a63; --card-bg: #ffffff; --card-border: #f0e2c9;
    --accent: #f5a623; --sage: #3f7a50; --danger: #b8402c; --ink: #3d3229; --ink-text: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1f1710; --text: #f0e6d8; --muted: #a89984; --card-bg: #2b2119; --card-border: #3d3122; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: var(--bg); color: var(--text); font-family: 'Karla', system-ui, sans-serif; padding: 20px;
  }
  .card {
    max-width: 380px; width: 100%; background: var(--card-bg); border: 1px solid var(--card-border);
    border-radius: 20px; padding: 28px 26px; text-align: center;
  }
  h1 { font-family: 'Fredoka', sans-serif; font-weight: 700; font-size: 19px; margin: 0 0 10px; }
  p { font-size: 13.5px; color: var(--muted); line-height: 1.5; margin: 0 0 20px; }
  button {
    border: none; border-radius: 999px; padding: 11px 22px; font-size: 14px; font-weight: 600; cursor: pointer;
    font-family: 'Fredoka', sans-serif; background: var(--ink); color: var(--ink-text); width: 100%;
  }
  button:disabled { opacity: .6; cursor: default; }
  #status { font-size: 12.5px; color: var(--muted); margin-top: 14px; min-height: 16px; }
  #status.denied { color: var(--danger); }
  #status.approved { color: var(--sage); }
</style>
</head>
<body>
  <div class="card">
    <h1>Docket</h1>
    <p>This list isn't shared with this browser yet. Send a request — nothing is visible until the device that owns this list approves it.</p>
    <button type="button" id="request-btn">Request access</button>
    <div id="status"></div>
  </div>
<script>
const btn = document.getElementById("request-btn");
const status = document.getElementById("status");
let pollTimer = null;

btn.addEventListener("click", async () => {
  btn.disabled = true;
  status.className = "";
  status.textContent = "Sending request…";
  try {
    const res = await fetch("/api/access/request", { method: "POST" });
    const body = await res.json();
    if (!res.ok) {
      status.textContent = body.error || "Couldn't send the request.";
      btn.disabled = false;
      return;
    }
    status.textContent = "Waiting for approval on the other device…";
    let attempts = 0;
    pollTimer = setInterval(async () => {
      attempts += 1;
      if (attempts > 150) {
        clearInterval(pollTimer);
        status.textContent = "Timed out waiting for approval.";
        btn.disabled = false;
        return;
      }
      const s = await (await fetch(\`/api/access/status/\${body.requestId}\`)).json();
      if (s.status === "approved") {
        clearInterval(pollTimer);
        status.className = "approved";
        status.textContent = "Approved — loading…";
        location.reload();
      } else if (s.status === "denied") {
        clearInterval(pollTimer);
        status.className = "denied";
        status.textContent = "The request was declined.";
        btn.disabled = false;
      } else if (s.status === "expired") {
        clearInterval(pollTimer);
        status.textContent = "Request expired.";
        btn.disabled = false;
      }
    }, 2000);
  } catch {
    status.textContent = "Couldn't reach the server.";
    btn.disabled = false;
  }
});
</script>
</body>
</html>
`;
