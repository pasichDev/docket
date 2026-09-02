import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { getDeviceId, getDeviceName, getDeviceRole } from "../device.js";
import { installProcessLogging, log } from "../log.js";
import { removePeer } from "../peers.js";
import { migrateLegacyFields, withStore } from "../storage.js";
import { syncAllPeers } from "../sync.js";
import { loadViewers, touchViewer } from "../viewers.js";
import { handleApiRoute, json, removePeerAndMaybeRevertRole, SECURITY_HEADERS, type ApiContext } from "./api.js";
import { GATE_PAGE, PAGE } from "./views.js";

installProcessLogging("web");

export const PORT = Number(process.env.TODO_MCP_WEB_PORT ?? 8787);
const SYNC_INTERVAL_MS = 15_000;

export const UI_SESSION_TOKEN = randomBytes(32).toString("hex");
export const UI_SESSION_COOKIE = "todo_ui";
export const VIEWER_COOKIE = "todo_viewer";

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

export function broadcastUpdate(): void {
  const payload = `event: update\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

const BROWSER_PROTECTED_PATHS = [
  /^\/api\/version$/,
  /^\/api\/events$/,
  /^\/api\/export$/,
  /^\/api\/import$/,
  /^\/api\/qr$/,
  /^\/api\/todos(\/|$)/,
  /^\/api\/peers(\/|$)/,
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

      // Authorization guard for protected paths
      if (BROWSER_PROTECTED_PATHS.some((re) => re.test(url.pathname)) && !(await isAuthorizedBrowser(req))) {
        return json(res, 403, { error: "this browser hasn't been granted access — reload the page to request it" });
      }

      // Dispatch to API routes
      const handled = await handleApiRoute(req, res, url, ctx);
      if (handled) return;

      json(res, 404, { error: "not found" });
    } catch (err) {
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
    console.log(`todo-mcp web UI: http://localhost:${port}${LAN_URL ? ` (LAN: ${LAN_URL})` : ""}`);
  });

  // Pull-based gossip sync with paired devices
  setInterval(() => {
    syncAllPeers(DEVICE_ID, withStore)
      .then((unpairedIds) => {
        broadcastUpdate();
        return Promise.all(unpairedIds.map((id) => removePeer(id)));
      })
      .catch((err) => log(`sync loop error: ${(err as Error).message}`));
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
