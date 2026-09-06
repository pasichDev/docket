import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SECURITY_HEADERS, UI_SESSION_COOKIE, type CrewRouteHandler, type CrewRouter, type CrewServerContext } from "../server.js";
import { OFFICE_PAGE } from "./page.js";

/**
 * The Office's two routes: the page, and the client modules it loads.
 *
 * There is deliberately no third. Every piece of live data the page shows comes from the
 * daemon's existing `/api/state` and `/api/events`, and every action it takes goes to the
 * control endpoints on the same origin — so this file adds no API surface of its own and no
 * second security model beside the one crew/src/server.ts already enforces (loopback bind,
 * Host validation, same-origin on mutations, security headers, UI session cookie).
 *
 * The one security responsibility that IS here: the page response must set the UI session
 * cookie, exactly as the built-in "/" does. Mutating control endpoints gate on
 * `ctx.hasUiSession(req)`, and that cookie is how a page served from here earns it.
 */

/**
 * Both are IMPORTED from server.ts, not restated. They were copied here, character-identical,
 * which meant a header added to the daemon's set would silently not reach the Office page or
 * any `/office/*.js` — the one place a browser actually executes code.
 */

/** Compiled sibling modules: dist/office/client/*.js, next to this file's own dist output. */
const CLIENT_DIR = fileURLToPath(new URL("./client/", import.meta.url));

/**
 * An allowlist by shape rather than path normalisation, the same call Docket Core's
 * client-assets.ts makes. Every emitted module name is a lowercase identifier, so anything
 * carrying a slash, a dot-segment, a backslash or a URL escape is not a file this server has
 * — and refusing it by shape means there is no traversal left to reason about, on any
 * platform.
 */
const CLIENT_MODULE = /^[a-z][a-z0-9-]*\.js$/;

/** In-memory: these files change only when the daemon binary does. */
const assetCache = new Map<string, string>();

function sendPage(res: ServerResponse, ctx: CrewServerContext): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Set-Cookie": `${UI_SESSION_COOKIE}=${ctx.uiSessionToken}; HttpOnly; SameSite=Strict; Path=/`,
    ...SECURITY_HEADERS,
  });
  res.end(OFFICE_PAGE);
}

async function sendAsset(name: string, res: ServerResponse): Promise<void> {
  if (!CLIENT_MODULE.test(name)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    res.end("not found");
    return;
  }
  let source = assetCache.get(name);
  if (source === undefined) {
    try {
      source = await readFile(join(CLIENT_DIR, name), "utf8");
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
      res.end("not found");
      return;
    }
    assetCache.set(name, source);
  }
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    // no-cache rather than immutable: the filenames are stable across versions, so a cached
    // copy would survive an upgrade and pair a new page with an old module. Revalidating
    // costs one conditional request against a loopback socket.
    "Cache-Control": "no-cache",
    ...SECURITY_HEADERS,
  });
  res.end(source);
}

/** `/office`, `/office/` and `/` all serve the same page — the CLI prints the bare root. */
export const officePageHandler: CrewRouteHandler = (_req, res, _url, ctx) => {
  sendPage(res, ctx);
};

/** `/office/<module>.js` → dist/office/client/<module>.js */
export const officeAssetHandler: CrewRouteHandler = async (_req: IncomingMessage, res, url) => {
  const name = url.pathname.slice("/office/".length);
  await sendAsset(name, res);
};

const OFFICE_ASSET_PATH = /^\/office\/[^/]+\.js$/;

/**
 * Mount the Office on a running Crew daemon.
 *
 * Registration order matters: the asset pattern is narrower than the page pattern and is
 * registered first, so `/office/app.js` is never answered with the HTML page.
 *
 * Registered routes are consulted before the daemon's built-ins (see CrewRouter.dispatch),
 * which is what lets "/" here replace the foundation placeholder page.
 */
export function registerOfficeRoutes(router: CrewRouter): void {
  router.register("GET", OFFICE_ASSET_PATH, officeAssetHandler);
  router.register("GET", "/office", officePageHandler);
  router.register("GET", "/office/", officePageHandler);
  router.register("GET", "/", officePageHandler);
}
