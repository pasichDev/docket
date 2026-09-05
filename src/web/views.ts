import { MARKUP } from "./client/markup.js";
import { CARDS } from "./client/script/cards.js";
import { DEVICES } from "./client/script/devices.js";
import { LIST } from "./client/script/list.js";
import { MARKDOWN } from "./client/script/markdown.js";
import { MODALS } from "./client/script/modals.js";
import { UTIL } from "./client/script/util.js";
import { STYLES } from "./client/styles.js";

/**
 * The dashboard, assembled.
 *
 * This was one 2,588-line template literal — the largest module in the project and the only
 * one no tool could see into, which is exactly where the bugs came from: a backtick in a
 * comment closing the string (four times in one sitting), bare `ul`/`li` selectors written
 * for the card list silently restyling the lists inside rendered markdown, a min-height lost
 * to an equal-specificity rule sixty lines further down.
 *
 * Splitting it does NOT make the client type-checked — it is still text until a browser
 * parses it. What it buys is smaller blast radius (a stray backtick now breaks one ~200-line
 * file and the compiler points near it), CSS that lives in one place so cascade collisions
 * are visible, and a markdown renderer that can be found without scrolling.
 *
 * The parts are concatenated into ONE <script>, so the client keeps a single lexical scope
 * and every cross-reference between the parts still resolves. Order therefore matters:
 * util and markdown define what the later parts call at load time.
 */
const CLIENT_SCRIPT = [UTIL, MARKDOWN, CARDS, LIST, DEVICES, MODALS].join("\n");

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Docket</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%236C3BFF'/%3E%3Cstop offset='1' stop-color='%2300D4C8'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='8' fill='url(%23g)'/%3E%3Cpolyline points='8,17 13,22 24,11' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3C/svg%3E">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Karla:wght@400;500;600;700&display=swap">
<style>
${STYLES}
</style>
</head>
<body>
${MARKUP}
<script>
${CLIENT_SCRIPT}
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

