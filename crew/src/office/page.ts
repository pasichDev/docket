import { OFFICE_MARKUP } from "./markup.js";
import { OFFICE_STYLES } from "./styles.js";

/**
 * The Office page's HTML shell.
 *
 * Same shape as Docket Core's src/web/views.ts, and the same split for the same reason: the
 * stylesheet and the markup are text no compiler can see into, so they live in their own
 * files and stay static; everything dynamic is real TypeScript in office/client, which the
 * browser loads as native ES modules from /office/*.js. No bundler, no new dependency.
 *
 * The favicon is Docket's mark with the workshop-amber ring, so the Crew tab is recognisably
 * from the same product without being mistaken for the Docket tab beside it.
 */
export const OFFICE_PAGE = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="same-origin" />
<title>Docket Crew — Office</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23f5a623'/%3E%3Ccircle cx='11' cy='12' r='3.4' fill='%232b2119'/%3E%3Ccircle cx='21' cy='12' r='3.4' fill='%232b2119'/%3E%3Cpath d='M5 26c0-4 2.7-6.4 6-6.4s6 2.4 6 6.4' stroke='%232b2119' stroke-width='2.6' fill='none' stroke-linecap='round'/%3E%3Cpath d='M15 26c0-4 2.7-6.4 6-6.4s6 2.4 6 6.4' stroke='%232b2119' stroke-width='2.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Karla:wght@400;500;600;700&display=swap">
<style>
${OFFICE_STYLES}
</style>
</head>
<body>
${OFFICE_MARKUP}
<noscript>
  <p class="warn" style="margin:16px 0">The Office is a live view of a running daemon, so it needs
  JavaScript. Without it, <code>docket-crew status</code> is the equivalent from a terminal.</p>
</noscript>
<script type="module" src="/office/app.js"></script>
</body>
</html>
`;
