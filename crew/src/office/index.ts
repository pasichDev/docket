/**
 * Docket Crew — the Office UI.
 *
 * `http://127.0.0.1:8790/office` (and `/`): an illustrated pixel office you can actually
 * drive. The conversation — the live Team Feed and "Tell the team what to do…" — sits above
 * the room; below it is the floor. Every managed agent is a character at a desk whose pose
 * and screen are a pure function of its AgentStatus; a busy character carries a thought
 * bubble holding its assignment title or its latest *visible* output line. Docket itself is
 * the filing cabinet on the wall, with the real open-task count and a drawer that opens when
 * work actually moves. Observed Docket sessions — the ones Crew did not launch — are
 * translucent figures outside the window, with no control anywhere on them (spec §17).
 *
 * The art is inline SVG compiled from character maps in client/render.ts, coloured entirely
 * by --px-* custom properties in styles.ts. No image, no canvas, no dependency, no external
 * asset: `pixelRects` turns a picture written as text into <rect> runs, which means the
 * sprites are pure functions `node --test` can assert on like any other markup.
 *
 * Accessibility is not the picture's afterthought: every desk is a real <button> whose
 * aria-label carries everything the drawing carries, every ghost is a labelled list item, and
 * a "Plain view" toggle swaps the whole scene for the card board (the two are hidden from each
 * other with the `hidden` attribute, so assistive tech is never told about both at once).
 *
 * ── Mounting ──────────────────────────────────────────────────────────────────────────────
 * This layer owns no other file. To mount it, the module that builds the daemon calls:
 *
 *     import { registerOfficeRoutes } from "./office/index.js";
 *     registerOfficeRoutes(crewServer.router);
 *
 * from `attachToDaemon` in crew/src/orchestrator.ts (the hook crew/src/cli.ts already calls),
 * or equivalently `registerOfficeRoutes(ctx.router)` from anywhere holding a CrewServerContext.
 * It is idempotent-free — call it exactly once per server.
 *
 * That single call is the whole integration. The Office adds no API of its own: it reads
 * `/api/state` and `/api/events`, and drives the frozen control contract (`/api/profiles`,
 * `/api/ask`, `/api/agents/spawn`, `/api/agents/:id/{message,cancel,stop}`,
 * `/api/manager/{pause,resume}`, and optionally `POST /api/assignments`). Any of those that
 * does not exist yet degrades to a disabled control with the reason in its tooltip — never a
 * blank page and never an uncaught exception.
 *
 * ── Security ──────────────────────────────────────────────────────────────────────────────
 * Nothing new. The page is served with the same `docket_crew_ui` HttpOnly SameSite=Strict
 * cookie the foundation's "/" sets, and every mutation the client makes is a same-origin
 * `credentials: "same-origin"` POST — which is exactly what crew/src/server.ts's Host check,
 * same-origin check and `ctx.hasUiSession()` guard already expect. Docket's LAN Viewer Gate
 * is not involved and must not be (spec §43).
 */

export { registerOfficeRoutes, officePageHandler, officeAssetHandler } from "./routes.js";
export { OFFICE_PAGE } from "./page.js";
export { OFFICE_MARKUP } from "./markup.js";
export { OFFICE_STYLES } from "./styles.js";
export * as render from "./client/render.js";
