import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import QRCode from "qrcode";
import { diffDetail, pushHistory } from "./history.js";
import { installProcessLogging, log } from "./log.js";
import { CURRENT_FORMAT_VERSION, readStore, withStore } from "./storage.js";
import type { Todo, TodoList, TodoPriority } from "./types.js";

installProcessLogging("web");

const PORT = Number(process.env.TODO_MCP_WEB_PORT ?? 8787);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** First non-internal IPv4 address — best-effort "the LAN IP a phone on the same Wi-Fi would use". */
function lanIp(): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}
const LAN_IP = lanIp();
const LAN_URL = LAN_IP ? `http://${LAN_IP}:${PORT}` : null;
const WEB_STARTED_AT = new Date().toISOString();

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function isTodoList(value: unknown): value is TodoList {
  return value === "todo" || value === "backlog";
}

function isPriority(value: unknown): value is TodoPriority {
  return value === "low" || value === "medium" || value === "high";
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && DATE_RE.test(value);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>todo-mcp</title>
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
  select, input[type=text], input[type=date], textarea {
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

  .phone-panel {
    max-width: 720px; margin: 0 auto 20px; background: var(--card-plain-bg); border: 1px solid var(--card-plain-border);
    border-radius: 20px; padding: 16px 20px; display: flex; gap: 18px; align-items: center; box-shadow: var(--card-shadow);
  }
  .phone-panel[hidden] { display: none; }
  .qr-wrap {
    width: 180px; height: 180px; border-radius: 12px; background: #fff; padding: 8px; flex-shrink: 0;
    box-sizing: border-box; display: flex; align-items: center; justify-content: center;
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
  .phone-panel-url { font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 4px; word-break: break-all; }
  .phone-panel-hint { font-size: 12px; color: var(--muted2); }
</style>
</head>
<body>
  <header>
    <h1>todo-mcp</h1>
    <div class="header-right">
      <div class="synced"><span class="dot"></span><span id="synced-text">syncing…</span></div>
      <button class="theme-toggle" id="phone-toggle" title="Connect from phone" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/></svg>
      </button>
      <button class="theme-toggle" id="theme-toggle" title="Toggle theme" type="button">
        <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>
        <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      </button>
    </div>
  </header>
  <div class="phone-panel" id="phone-panel" hidden>
    <div class="qr-wrap">
      <div class="qr-loading" id="qr-loading">
        <span class="qr-dot"></span><span class="qr-dot"></span><span class="qr-dot"></span>
        <span class="qr-dot"></span><span class="qr-dot"></span><span class="qr-dot"></span>
        <span class="qr-dot"></span><span class="qr-dot"></span><span class="qr-dot"></span>
      </div>
      <img id="phone-qr" alt="QR code for LAN URL" width="164" height="164" hidden />
    </div>
    <div class="phone-panel-text">
      <div class="phone-panel-title">Scan to open on your phone</div>
      <div class="phone-panel-url" id="phone-url">—</div>
      <div class="phone-panel-hint">Same Wi-Fi network only. Anyone on this network can open this URL.</div>
    </div>
  </div>
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

function sortItems(items, mode) {
  const arr = [...items];
  const cmp =
    mode === "newest"
      ? (a, b) => b.createdAt.localeCompare(a.createdAt)
      : mode === "oldest"
      ? (a, b) => a.createdAt.localeCompare(b.createdAt)
      : mode === "az"
      ? (a, b) => a.title.localeCompare(b.title)
      : mode === "category"
      ? (a, b) => (a.category || "\\uffff").localeCompare(b.category || "\\uffff") || a.id - b.id
      : mode === "priority"
      ? (a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) || a.id - b.id
      : mode === "due"
      ? (a, b) => (a.dueDate || "\\uffff").localeCompare(b.dueDate || "\\uffff") || a.id - b.id
      : (a, b) => a.id - b.id;
  // Claimed/in-progress items always come first, regardless of sort mode.
  return arr.sort((a, b) => (!!b.workingAgent - !!a.workingAgent) || cmp(a, b));
}

let editingId = null;

function itemHtml(t) {
  if (t.id === editingId) return editFormHtml(t);

  const tint = categoryTint(t.category);
  const styleParts = [];
  if (t.workingAgent) styleParts.push(\`--work-glow:\${agentColor(t.workingAgent)}\`);
  const cardStyle = styleParts.length ? \` style="\${styleParts.join("; ")};"\` : "";
  const badge = t.category
    ? \`<span class="badge" style="background:\${tint.chipBg}; color:\${tint.chipText}; --badge-rot:\${tint.rot}">\${escapeHtml(t.category)}</span>\`
    : "";
  const listBadge = \`<span class="list-badge \${t.list}"><span class="dot"></span>\${t.list === "todo" ? "Todo" : "Backlog"}</span>\`;
  const priorityFlag = t.priority ? \`<span class="priority-flag \${t.priority}" title="\${t.priority} priority"></span>\` : "";
  const checkIcon = t.done
    ? \`<svg viewBox="0 0 18 18" width="18" height="18"><rect x="1.5" y="1.5" width="15" height="15" rx="6" fill="\${sageHex()}"/><path d="M5 9.2 7.6 11.8 13 6" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>\`
    : '';
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
        \${t.done
          ? \`<span style="display:flex">\${checkIcon}</span>\`
          : '<input type="checkbox" />'}
        <span class="id">#\${t.id}</span>
        <span class="card-title">\${escapeHtml(t.title)}</span>
        \${due}
      </div>
      \${t.description ? \`<div class="card-desc">\${escapeHtml(t.description)}</div>\` : ""}
      \${historyHtml(t)}
    </li>\`;
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

  // If a card is ALREADY mid-edit (its DOM node is the edit form, not a
  // fresh transition into edit mode), keep that live node — with whatever
  // the user has typed but not saved yet — instead of regenerating it from
  // server state on a periodic refresh.
  const openListEl = document.querySelector(".open-list");
  const doneListEl = document.querySelector(".done-list");
  const existingNode =
    editingId !== null
      ? openListEl.querySelector(\`li[data-id="\${editingId}"]\`) || doneListEl.querySelector(\`li[data-id="\${editingId}"]\`)
      : null;
  const preservedEdit = existingNode && existingNode.dataset.editing === "true" ? existingNode : null;
  const render1 = (t) => (preservedEdit && t.id === editingId ? preservedEdit.outerHTML : itemHtml(t));

  document.querySelector(".open-count").textContent = \`\${open.length} open\`;
  openListEl.innerHTML = open.length
    ? open.map(render1).join("")
    : '<li class="empty" style="background:none;border:none;padding:10px 4px">Nothing open.</li>';
  doneListEl.innerHTML = done.map(render1).join("");
  document.querySelector(".done-count").textContent = \`(\${done.length})\`;
}

async function refresh() {
  try {
    render(await fetchTodos());
  } catch (err) {
    console.error("refresh failed", err);
  }
}

function tickSyncedLabel() {
  const el = document.getElementById("synced-text");
  if (!lastSync) { el.textContent = "syncing…"; return; }
  const s = Math.round((Date.now() - lastSync) / 1000);
  el.textContent = s < 2 ? "synced just now" : \`synced \${s}s ago\`;
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

let phoneLoaded = false;
document.getElementById("phone-toggle").addEventListener("click", async () => {
  const panel = document.getElementById("phone-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden && !phoneLoaded) {
    phoneLoaded = true;
    try {
      const v = await (await fetch("/api/version")).json();
      if (v.lanUrl) {
        document.getElementById("phone-url").textContent = v.lanUrl;
        const img = document.getElementById("phone-qr");
        img.onload = () => {
          document.getElementById("qr-loading").style.display = "none";
          img.hidden = false;
        };
        img.src = "/api/qr";
      } else {
        document.getElementById("qr-loading").style.display = "none";
        document.getElementById("phone-url").textContent = "No LAN IP found — connect this machine to Wi-Fi/Ethernet.";
      }
    } catch {
      document.getElementById("qr-loading").style.display = "none";
      document.getElementById("phone-url").textContent = "Couldn't load.";
    }
  }
});

document.querySelectorAll(".tag").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTag = btn.dataset.tag;
    document.querySelectorAll(".tag").forEach((b) => (b.dataset.active = String(b === btn)));
    render(allTodos);
  });
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
  const title = titleInput.value.trim();
  if (!title) return;
  const description = descInput.value.trim() || undefined;
  const category = catInput.value.trim() || undefined;
  const priority = priorityInput.value || undefined;
  const dueDate = dueInput.value || undefined;
  await fetch("/api/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, description, list: addFormList, category, priority, dueDate }),
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
  await fetch(\`/api/todos/\${id}\`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, description, category, priority, dueDate }),
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
      \`todo-mcp web · format v\${v.formatVersion} · pid \${v.pid} · started \${started}\`;
  } catch (err) {
    document.getElementById("version-footer").textContent = "version unavailable";
  }
}
loadVersionFooter();

refresh();
setInterval(() => {
  // Skip while a card is mid-edit — refresh() re-renders from server state
  // and would wipe unsaved input values out from under the user.
  if (editingId === null) refresh();
}, 3000);
setInterval(tickSyncedLabel, 1000);
</script>
</body>
</html>
`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/version") {
      json(res, 200, { formatVersion: CURRENT_FORMAT_VERSION, startedAt: WEB_STARTED_AT, pid: process.pid, lanUrl: LAN_URL });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/qr") {
      if (!LAN_URL) return json(res, 404, { error: "no LAN IP found" });
      const svg = await QRCode.toString(LAN_URL, { type: "svg", margin: 1, width: 220 });
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end(svg);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/todos") {
      const store = await readStore();
      json(res, 200, { todos: store.todos });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/todos") {
      const body = (await readJsonBody(req)) as {
        title?: unknown;
        description?: unknown;
        list?: unknown;
        category?: unknown;
        priority?: unknown;
        dueDate?: unknown;
      };
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const description = typeof body.description === "string" && body.description.trim() ? body.description.trim() : null;
      const list: TodoList = isTodoList(body.list) ? body.list : "todo";
      const category = typeof body.category === "string" && body.category.trim() ? body.category.trim() : null;
      const priority = isPriority(body.priority) ? body.priority : null;
      const dueDate = isDate(body.dueDate) ? body.dueDate : null;
      if (!title) return json(res, 400, { error: "title is required" });
      const todo = await withStore((store) => {
        const newTodo: Todo = {
          id: store.nextId,
          title,
          description,
          done: false,
          list,
          category,
          priority,
          dueDate,
          agent: "web",
          session: null,
          workingAgent: null,
          workingSince: null,
          workingSession: null,
          createdAt: new Date().toISOString(),
          completedAt: null,
          history: [],
        };
        pushHistory(newTodo, "web", "created", `title: "${title}"`);
        store.nextId += 1;
        store.todos.push(newTodo);
        return newTodo;
      });
      json(res, 201, { todo });
      return;
    }

    const completeMatch = url.pathname.match(/^\/api\/todos\/(\d+)\/complete$/);
    if (req.method === "POST" && completeMatch) {
      const id = Number(completeMatch[1]);
      const todo = await withStore((store) => {
        const item = store.todos.find((t) => t.id === id);
        if (!item) return null;
        item.done = true;
        item.completedAt = new Date().toISOString();
        item.workingAgent = null;
        item.workingSince = null;
        pushHistory(item, "web", "completed", "marked done");
        return item;
      });
      if (!todo) return json(res, 404, { error: `No todo with id #${id}` });
      json(res, 200, { todo });
      return;
    }

    const patchMatch = url.pathname.match(/^\/api\/todos\/(\d+)$/);
    if (req.method === "PATCH" && patchMatch) {
      const id = Number(patchMatch[1]);
      const body = (await readJsonBody(req)) as {
        title?: unknown;
        description?: unknown;
        list?: unknown;
        category?: unknown;
        priority?: unknown;
        dueDate?: unknown;
      };
      const todo = await withStore((store) => {
        const item = store.todos.find((t) => t.id === id);
        if (!item) return null;
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        if (typeof body.title === "string" && body.title.trim() && body.title.trim() !== item.title) {
          changes.title = { from: item.title, to: body.title.trim() };
          item.title = body.title.trim();
        }
        if (typeof body.description === "string") {
          const next = body.description.trim() || null;
          if (next !== item.description) {
            changes.description = { from: item.description, to: next };
            item.description = next;
          }
        }
        if (typeof body.category === "string") {
          const next = body.category.trim() || null;
          if (next !== item.category) {
            changes.category = { from: item.category, to: next };
            item.category = next;
          }
        }
        if (typeof body.priority === "string") {
          const next = isPriority(body.priority) ? body.priority : null;
          if (next !== item.priority) {
            changes.priority = { from: item.priority, to: next };
            item.priority = next;
          }
        }
        if (typeof body.dueDate === "string") {
          const next = isDate(body.dueDate) ? body.dueDate : null;
          if (next !== item.dueDate) {
            changes.dueDate = { from: item.dueDate, to: next };
            item.dueDate = next;
          }
        }
        if (isTodoList(body.list) && body.list !== item.list) {
          changes.list = { from: item.list, to: body.list };
          item.list = body.list;
        }
        if (Object.keys(changes).length > 0) pushHistory(item, "web", "edited", diffDetail(changes));
        return item;
      });
      if (!todo) return json(res, 404, { error: `No todo with id #${id}` });
      json(res, 200, { todo });
      return;
    }

    const deleteMatch = url.pathname.match(/^\/api\/todos\/(\d+)$/);
    if (req.method === "DELETE" && deleteMatch) {
      const id = Number(deleteMatch[1]);
      const removed = await withStore((store) => {
        const index = store.todos.findIndex((item) => item.id === id);
        if (index === -1) return null;
        return store.todos.splice(index, 1)[0];
      });
      if (!removed) return json(res, 404, { error: `No todo with id #${id}` });
      log(`deleted #${removed.id} "${removed.title}" by web`);
      json(res, 200, { removed });
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    log(`web request error: ${(err as Error).stack ?? (err as Error).message}`);
    json(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  log(`web listening on 0.0.0.0:${PORT}${LAN_URL ? ` (LAN: ${LAN_URL})` : ""}`);
  console.log(`todo-mcp web UI: http://localhost:${PORT}${LAN_URL ? ` (LAN: ${LAN_URL})` : ""}`);
});
