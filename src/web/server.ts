import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { getDeviceId, getDeviceName, getDeviceRole } from "../device.js";
import { installProcessLogging, log } from "../log.js";
import { loadPeers, removePeer } from "../peers.js";
import { migrateLegacyFields, withStore } from "../storage.js";
import { syncAllPeers } from "../sync/client.js";
import { loadViewers, touchViewer } from "../viewers.js";
import { handleApiRoute } from "./api.js";
import { AmbiguousTodoIdError } from "../storage.js";
import { BadRequestError, json, SECURITY_HEADERS, type ApiContext } from "./http.js";
import { removePeerAndMaybeRevertRole } from "./peer-admin.js";
import { isClientAssetPath, serveClientAsset } from "./client-assets.js";
import { GATE_PAGE, PAGE } from "./views.js";

installProcessLogging("web");

export const PORT = Number(process.env.DOCKET_WEB_PORT ?? 8787);
const SYNC_INTERVAL_MS = 15_000;

export const UI_SESSION_TOKEN = randomBytes(32).toString("hex");
export const UI_SESSION_COOKIE = "docket_ui";
export const VIEWER_COOKIE = "docket_viewer";

export function hasUiSession(req: IncomingMessage): boolean {
  const cookieHeader = req.headers.cookie ?? "";
  const match = cookieHeader.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${UI_SESSION_COOKIE}=`));
  if (!match) return false;
  const value = match.slice(UI_SESSION_COOKIE.length + 1);
  const a = Buffer.from(value);
  const b = Buffer.from(UI_SESSION_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function lanIp(): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

export const LAN_IP = lanIp();
export const LAN_URL = LAN_IP ? `http://${LAN_IP}:${PORT}` : null;
export const WEB_STARTED_AT = new Date().toISOString();

export function isLocalRequest(req: IncomingMessage): boolean {
  const addr = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (addr === "127.0.0.1" || addr === "::1") return true;
  return LAN_IP !== null && addr === LAN_IP;
}

/**
 * DNS-rebinding guard. Authorization here leans on "the request came from this
 * machine / holds a cookie", but a malicious website can point its OWN domain's
 * DNS at 127.0.0.1 (or a LAN IP) and make the victim's browser issue same-"site"
 * requests straight into this server. Every legitimate way of reaching this
 * server — localhost, an IP literal (LAN or loopback), an mDNS `.local` name —
 * has a hostname an internet attacker cannot serve their page from, so anything
 * else in the Host header is rejected before any route or auth check runs.
 */
export function hasTrustedHostHeader(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return true; // no browser omits Host — a raw local/LAN client is authenticated by the usual means
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  const bare = hostname.replace(/^\[|\]$/g, ""); // URL keeps IPv6 literals bracketed
  return hostname === "localhost" || hostname.endsWith(".local") || isIP(bare) > 0;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF defense-in-depth for mutating requests, alongside the SameSite=Strict session
 * cookies (the primary defense — a real cross-site browser request never carries them
 * at all). This catches the residual case those cookies don't: a request forged from
 * another page on the SAME device, e.g. a malicious LAN page the browser still treats
 * as first-party to itself, or a viewer whose bearer token a page embeds directly
 * instead of relying on cookies. No Origin/Referer at all means a non-browser client
 * (another paired device's own fetch(), curl) — those never send Origin unless told
 * to, so leaving this case open doesn't weaken anything; a spoofed Origin can't fool
 * this check because the browser sets it, not page script.
 */
export function hasSameOriginForMutation(req: IncomingMessage): boolean {
  if (!req.method || !MUTATING_METHODS.has(req.method)) return true;
  const originHeader = req.headers.origin;
  const refererHeader = req.headers.referer;
  const claimed = originHeader ?? refererHeader;
  if (!claimed) return true;
  const hostHeader = req.headers.host;
  if (!hostHeader) return true;
  try {
    return new URL(claimed).host === hostHeader;
  } catch {
    return false;
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const TOUCH_DEBOUNCE_MS = 60_000;
const lastTouchedAt = new Map<string, number>();

export async function hasViewerSession(req: IncomingMessage): Promise<boolean> {
  const cookieHeader = req.headers.cookie ?? "";
  const match = cookieHeader.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${VIEWER_COOKIE}=`));
  if (!match) return false;
  const token = match.slice(VIEWER_COOKIE.length + 1);
  const hash = sha256Hex(token);
  const hashBuf = Buffer.from(hash);
  const viewers = await loadViewers();
  for (const v of viewers) {
    const stored = Buffer.from(v.tokenHash);
    if (stored.length === hashBuf.length && timingSafeEqual(stored, hashBuf)) {
      const now = Date.now();
      if (now - (lastTouchedAt.get(v.id) ?? 0) > TOUCH_DEBOUNCE_MS) {
        lastTouchedAt.set(v.id, now);
        void touchViewer(v.id);
      }
      return true;
    }
  }
  return false;
}

export async function isAuthorizedBrowser(req: IncomingMessage): Promise<boolean> {
  return isLocalRequest(req) || (await hasViewerSession(req));
}

export const sseClients = new Set<ServerResponse>();

function broadcastEvent(name: string, data: Record<string, unknown>): void {
  const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

export function broadcastUpdate(): void {
  broadcastEvent("update", { timestamp: Date.now() });
}

/**
 * Device sync runs on this process's own interval, so the browser has no way to know one is
 * happening — it would otherwise show a static "synced 4m ago" throughout. Announcing the
 * start and the end is what lets the header show a real spinner instead of a guess made
 * from the dashboard's own polling, which is a different thing entirely.
 */
export function broadcastSync(phase: "start" | "end", detail: Record<string, unknown> = {}): void {
  broadcastEvent("sync", { phase, ...detail });
}

const BROWSER_PROTECTED_PATHS = [
  /^\/api\/version$/,
  /^\/api\/events$/,
  /^\/api\/export$/,
  /^\/api\/import$/,
  /^\/api\/qr$/,
  /^\/api\/todos(\/|$)/,
  /^\/api\/peers(\/|$)/,
  /^\/api\/presence$/,
  /^\/api\/sessions$/,
  /^\/api\/hook\//,
  /^\/api\/pair\/invite$/,
  /^\/api\/pair\/incoming$/,
  /^\/api\/pair\/redeem$/,
  /^\/api\/pair\/outgoing\//,
];

export async function createWebServer(): Promise<Server> {
  const DEVICE_ID = await getDeviceId();
  const DEVICE_NAME = await getDeviceName();
  let deviceRole = await getDeviceRole();

  const ctx: ApiContext = {
    deviceId: DEVICE_ID,
    deviceName: DEVICE_NAME,
    deviceRole,
    setDeviceRoleState: (role) => {
      deviceRole = role;
      ctx.deviceRole = role;
    },
    lanUrl: LAN_URL,
    startedAt: WEB_STARTED_AT,
    viewerCookieName: VIEWER_COOKIE,
    hasUiSession,
    hasViewerSession,
    isAuthorizedBrowser,
    isLocalRequest,
    broadcastUpdate,
    sseClients,
    sha256Hex,
  };

  const server = createServer(async (req, res) => {
    try {
      if (!hasTrustedHostHeader(req)) {
        return json(res, 403, { error: "unrecognized Host header" });
      }
      if (!hasSameOriginForMutation(req)) {
        return json(res, 403, { error: "cross-origin request rejected" });
      }
      const url = new URL(req.url ?? "/", "http://localhost");

      // Root dashboard / Gate page
      if (req.method === "GET" && url.pathname === "/") {
        if (isLocalRequest(req)) {
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Set-Cookie": `${UI_SESSION_COOKIE}=${UI_SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
            ...SECURITY_HEADERS,
          });
          res.end(PAGE);
          return;
        }
        if (await hasViewerSession(req)) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
          res.end(PAGE);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
        res.end(GATE_PAGE);
        return;
      }

      // The dashboard's own modules. Ahead of the authorization guard on purpose: this is the
      // page's script, the page itself is already served to an unauthorized browser as the
      // access gate, and the modules contain no data — only code that would then ask for it.
      if (isClientAssetPath(url.pathname)) {
        await serveClientAsset(url.pathname, res, SECURITY_HEADERS);
        return;
      }

      // Authorization guard for protected paths
      if (BROWSER_PROTECTED_PATHS.some((re) => re.test(url.pathname)) && !(await isAuthorizedBrowser(req))) {
        return json(res, 403, { error: "this browser hasn't been granted access — reload the page to request it" });
      }

      // Dispatch to API routes
      const handled = await handleApiRoute(req, res, url, ctx);
      if (handled) return;

      json(res, 404, { error: "not found" });
    } catch (err) {
      // A caller's own malformed request is a 4xx. Only genuine server faults get a 500 and
      // a stack trace in the log — otherwise the log fills with other people's typos and a
      // real fault is harder to find, not easier.
      if (err instanceof BadRequestError) {
        json(res, 400, { error: err.message });
        return;
      }
      if (err instanceof AmbiguousTodoIdError) {
        // 409, not 500: the request was well-formed and the server is healthy — the id the
        // caller used simply does not identify one item, and the fix is theirs (use the uuid).
        json(res, 409, { error: err.message, candidates: err.candidates.map((t) => ({ uuid: t.uuid, title: t.title })) });
        return;
      }
      log(`web request error: ${(err as Error).stack ?? (err as Error).message}`);
      json(res, 500, { error: (err as Error).message });
    }
  });

  return server;
}

export async function startWebServer(port: number = PORT): Promise<Server> {
  await migrateLegacyFields();
  const server = await createWebServer();

  const DEVICE_ID = await getDeviceId();

  server.listen(port, "0.0.0.0", () => {
    log(`web listening on 0.0.0.0:${port}${LAN_URL ? ` (LAN: ${LAN_URL})` : ""}`);
    console.log(`docket web UI: http://localhost:${port}${LAN_URL ? ` (LAN: ${LAN_URL})` : ""}`);
  });

  // Pull-based gossip sync with paired devices
  setInterval(async () => {
    // No peers means nothing to sync, and announcing a "sync" that talks to nobody would
    // spin the header on a single-device install every few seconds for no reason.
    const peerCount = await loadPeers().then((p) => p.filter((peer) => !peer.revoked).length).catch(() => 0);
    if (peerCount === 0) return;
    broadcastSync("start", { peers: peerCount });
    try {
      const unpairedIds = await syncAllPeers(DEVICE_ID, withStore);
      broadcastUpdate();
      await Promise.all(unpairedIds.map((id) => removePeer(id)));
      broadcastSync("end", { ok: true });
    } catch (err) {
      log(`sync loop error: ${(err as Error).message}`);
      broadcastSync("end", { ok: false });
    }
  }, SYNC_INTERVAL_MS);

  // Graceful shutdown handlers
  const shutdown = () => {
    log("web server shutting down cleanly");
    for (const client of sseClients) {
      try {
        client.end();
      } catch {}
    }
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}
