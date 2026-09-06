import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { CrewConfig } from "./types.js";
import { DEFAULT_CREW_PORT } from "./types.js";
import type { DetectedRuntime, DocketDetection, WorkspaceResolution } from "./discovery.js";
import type { EventBus } from "./events.js";
import type { CrewPaths } from "./paths.js";
import type { StateStore } from "./state.js";
import type { Supervisor } from "./supervisor.js";
import type { RuntimeId } from "./types.js";

/**
 * The Crew daemon's HTTP + SSE surface (spec §33/§43). Loopback only: the listener binds
 * 127.0.0.1 and nothing else — Crew control is not exposed to the LAN, and deliberately
 * does NOT reuse Docket's LAN Viewer Gate (spec §43 forbids it: viewing todos and
 * commanding agents are different trust levels).
 *
 * The request-hardening model is the same one Docket Core's web server uses
 * (src/web/server.ts), re-implemented here because the packages don't import each other:
 *   1. Host-header validation before anything else — the DNS-rebinding guard. A malicious
 *      website can point its own domain at 127.0.0.1; every legitimate way of naming this
 *      server (localhost, an IP literal, an mDNS .local name) is a hostname an internet
 *      attacker cannot serve a page from.
 *   2. Same-origin check on mutating methods — CSRF defense-in-depth beside the
 *      SameSite=Strict session cookie.
 *   3. Security headers on every response.
 *   4. A random per-process UI session token, set as an HttpOnly cookie when a local
 *      browser loads the page; mutating routes require it via ctx.hasUiSession.
 *
 * Extensibility: Agent 3 registers Office UI routes and control endpoints on the exported
 * CrewRouter (ctx.router.register(...)). Registered routes are consulted before the
 * built-ins, so the Office UI can claim "/" — the built-in placeholder only answers when
 * nothing else did.
 */

export const CREW_VERSION = "0.1.0";
export const UI_SESSION_COOKIE = "docket_crew_ui";

/**
 * The UI KEY — the thing a request must present before the daemon will mint it a UI session.
 *
 * WHY IT EXISTS. `GET /` used to answer `Set-Cookie: docket_crew_ui=<token>` to ANY caller,
 * with no authentication whatsoever, and `hasUiSession()` was then used to decide "is a human
 * behind this request". That made the human's capability — putting a worker in the human's own
 * checkout, and speaking as `from: "human"` — free to any local process that can spell `curl`.
 * Demonstrated end to end by an adversarial review.
 *
 * WHAT IT IS. A random per-process secret the daemon never publishes over HTTP. The daemon
 * writes it to `<crew home>/ui-key` (0600, inside a 0700 root); `docket-crew start` reads it
 * back and prints the Office URL WITH the key on the user's own terminal, and `docket-crew
 * office` opens that same URL. Every mutating control route accepts it as the
 * `X-Crew-UI-Key` header, which is the CLI's path.
 *
 * WHAT IT HONESTLY DOES NOT DO. It does not make the human's capability unforgeable. Crew's
 * realistic adversary is an agent Crew itself spawned: same uid, a shell, and file tools. Such
 * a process can read `<crew home>/ui-key` exactly as the CLI does, and no amount of code here
 * changes that — closing it needs OS-level sandboxing Crew does not have. What this DOES
 * change is that the capability is no longer handed out for free by an unauthenticated GET:
 * an agent that has only what Crew gave it (DOCKET_CREW_URL and its own RPC token) cannot
 * obtain it by ASKING THE DAEMON. It has to go and read a file it was never told about. That
 * raises the bar; it does not close the hole.
 */
export const UI_KEY_HEADER = "x-crew-ui-key";
/** …and as a query parameter, because a browser cannot be made to send a header on navigation. */
export const UI_KEY_QUERY = "key";

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
} as const;

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

/**
 * Last-resort error reply. NEVER writes a header that has already been sent.
 *
 * This is the guard whose absence killed the daemon: `/api/events` wrote its 200 SSE header
 * and only then awaited the backlog read, so when that read threw (a large events.jsonl once
 * hit `RangeError: Invalid string length`) the catch called json(…, 500, …) on a response
 * whose head was long gone, `ERR_HTTP_HEADERS_SENT` escaped an async request listener as an
 * unhandled rejection, and the process exited — orphaning every runtime child, because dying
 * that way skips supervisor.stopAll() entirely.
 */
export function failRequest(res: ServerResponse, err: unknown): void {
  const message = (err as Error)?.message ?? String(err);
  try {
    if (res.headersSent || res.writableEnded) {
      res.end();
      return;
    }
    json(res, 500, { error: message });
  } catch {
    // The socket is gone. Nothing to report to, and definitely nothing to crash over.
    try {
      res.destroy();
    } catch {
      /* already destroyed */
    }
  }
}

/** Parse a request target without throwing — used before the main URL is built. */
function safeUrl(target: string | undefined): URL | null {
  try {
    return new URL(target ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

export function hasTrustedHostHeader(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return true; // no browser omits Host — a raw local client is fine
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  const bare = hostname.replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname.endsWith(".local") || isIP(bare) > 0;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function hasSameOriginForMutation(req: IncomingMessage): boolean {
  if (!req.method || !MUTATING_METHODS.has(req.method)) return true;
  const claimed = req.headers.origin ?? req.headers.referer;
  if (!claimed) return true; // non-browser client (curl, another local process)
  const hostHeader = req.headers.host;
  if (!hostHeader) return true;
  try {
    return new URL(claimed).host === hostHeader;
  } catch {
    return false;
  }
}

/** Belt-and-braces beside the loopback bind: refuse any socket that isn't loopback. */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const addr = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  return addr === "127.0.0.1" || addr === "::1";
}

export type CrewRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: CrewServerContext,
) => Promise<boolean | void> | boolean | void;

interface RegisteredRoute {
  method: string;
  pattern: string | RegExp;
  handler: CrewRouteHandler;
}

/**
 * Ordered route table. `register()` is the extension point the other layers build on;
 * a handler signals "not mine after all" by returning false explicitly — any other return
 * (undefined included) counts as handled.
 */
export class CrewRouter {
  private readonly routes: RegisteredRoute[] = [];

  register(method: string, pattern: string | RegExp, handler: CrewRouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), pattern, handler });
  }

  async dispatch(req: IncomingMessage, res: ServerResponse, url: URL, ctx: CrewServerContext): Promise<boolean> {
    for (const route of this.routes) {
      if (route.method !== (req.method ?? "GET").toUpperCase()) continue;
      const matches =
        typeof route.pattern === "string" ? route.pattern === url.pathname : route.pattern.test(url.pathname);
      if (!matches) continue;
      const handled = await route.handler(req, res, url, ctx);
      if (handled !== false) return true;
    }
    return false;
  }
}

export interface CrewServerContext {
  store: StateStore;
  bus: EventBus;
  config: CrewConfig;
  paths: CrewPaths;
  supervisor: Supervisor | null;
  runtimes: Record<RuntimeId, DetectedRuntime>;
  docket: DocketDetection | null;
  workspace: WorkspaceResolution;
  startedAt: string;
  router: CrewRouter;
  /**
   * Random per-process token; the local browser gets it as an HttpOnly cookie on "/" — but
   * ONLY when that request presented the UI key (see UI_KEY_HEADER).
   */
  uiSessionToken: string;
  /**
   * Random per-process secret, never published over HTTP. The daemon writes it to
   * `<crew home>/ui-key` (0600) for the CLI to read; see UI_KEY_HEADER for what it does and
   * does not guarantee.
   */
  uiKey: string;
  /** Whether this request carries the current UI session cookie — guard for mutating routes. */
  hasUiSession(req: IncomingMessage): boolean;
  /** Whether this request presents the UI key, as a header or as `?key=`. */
  hasUiKey(req: IncomingMessage, url?: URL): boolean;
}

export interface CrewServerOptions {
  store: StateStore;
  bus: EventBus;
  config: CrewConfig;
  paths: CrewPaths;
  supervisor?: Supervisor | null;
  runtimes: Record<RuntimeId, DetectedRuntime>;
  docket?: DocketDetection | null;
  workspace: WorkspaceResolution;
  /** Injected so the daemon can persist exactly the key it will accept; random otherwise. */
  uiKey?: string;
}

export interface CrewServer {
  server: Server;
  router: CrewRouter;
  ctx: CrewServerContext;
  /** Bound port after start(). */
  port(): number;
  start(port?: number): Promise<number>;
  /**
   * Answer 503 to everything until markReady(). The daemon holds before binding, so it can
   * claim the port — proving nobody else owns it — BEFORE restart recovery and the
   * orchestration layer run, without ever serving a half-initialized daemon. See daemonMain.
   */
  hold(): void;
  markReady(): void;
  stop(): Promise<void>;
}

const PLACEHOLDER_PAGE = `<!doctype html><meta charset="utf-8"><title>Docket Crew</title>
<body style="font-family:system-ui;margin:3rem auto;max-width:36rem;color:#333">
<h1>Docket Crew</h1>
<p>The daemon is running. The Office UI is not wired yet — <code>GET /api/state</code>,
<code>GET /api/events</code> (SSE) and <code>GET /api/health</code> are live.</p></body>`;

/** Constant-time secret comparison that is also safe for mismatched lengths. */
export function secretEquals(candidate: string, secret: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function createCrewServer(opts: CrewServerOptions): CrewServer {
  const uiSessionToken = randomBytes(32).toString("hex");
  const uiKey = opts.uiKey ?? randomBytes(32).toString("hex");
  const router = new CrewRouter();
  const sseClients = new Set<ServerResponse>();

  const hasUiSession = (req: IncomingMessage): boolean => {
    const cookieHeader = req.headers.cookie ?? "";
    const match = cookieHeader
      .split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith(`${UI_SESSION_COOKIE}=`));
    if (!match) return false;
    return secretEquals(match.slice(UI_SESSION_COOKIE.length + 1), uiSessionToken);
  };

  /**
   * The key may arrive as a header (the CLI, and anything scripted) or as `?key=` (a browser
   * navigating to the URL `docket-crew start` printed — a navigation cannot carry a header).
   */
  const hasUiKey = (req: IncomingMessage, url?: URL): boolean => {
    const header = req.headers[UI_KEY_HEADER];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    if (fromHeader && secretEquals(fromHeader.trim(), uiKey)) return true;
    const target = url ?? safeUrl(req.url);
    const fromQuery = target?.searchParams.get(UI_KEY_QUERY);
    return Boolean(fromQuery && secretEquals(fromQuery.trim(), uiKey));
  };

  const ctx: CrewServerContext = {
    store: opts.store,
    bus: opts.bus,
    config: opts.config,
    paths: opts.paths,
    supervisor: opts.supervisor ?? null,
    runtimes: opts.runtimes,
    docket: opts.docket ?? null,
    workspace: opts.workspace,
    startedAt: new Date().toISOString(),
    router,
    uiSessionToken,
    uiKey,
    hasUiSession,
    hasUiKey,
  };

  // Ready by default: an embedded/in-test server is usable the moment it is created. The
  // daemon calls hold() before binding and markReady() once it is genuinely initialized.
  let ready = true;

  const server = createServer(async (req, res) => {
    try {
      // A response whose socket dies mid-write emits 'error' on the ServerResponse; with no
      // listener that becomes an uncaught exception, which in this process means every
      // supervised child is orphaned. It is never worth more than a shrug.
      res.on("error", () => {});
      if (!isLoopbackRequest(req)) return json(res, 403, { error: "crew control is loopback-only" });
      if (!hasTrustedHostHeader(req)) return json(res, 403, { error: "unrecognized Host header" });
      if (!hasSameOriginForMutation(req)) return json(res, 403, { error: "cross-origin request rejected" });
      const url = new URL(req.url ?? "/", "http://localhost");

      // Bound but not yet initialized: answer honestly instead of serving a daemon whose
      // restart recovery and orchestration routes are still being wired up.
      if (!ready) return json(res, 503, { error: "crew daemon is still starting", starting: true });

      // Extension routes first — the Office UI overrides the placeholder by registering "/".
      if (await router.dispatch(req, res, url, ctx)) return;

      if (req.method === "GET" && url.pathname === "/") {
        /**
         * The cookie is a CAPABILITY, not a greeting. This page used to set it for anybody —
         * see UI_KEY_HEADER for the exploit that made possible. A caller that cannot present
         * the UI key still gets the page (there is nothing secret on it), just no session.
         */
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          ...(hasUiKey(req, url) || hasUiSession(req)
            ? { "Set-Cookie": `${UI_SESSION_COOKIE}=${uiSessionToken}; HttpOnly; SameSite=Strict; Path=/` }
            : {}),
          ...SECURITY_HEADERS,
        });
        res.end(PLACEHOLDER_PAGE);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, {
          ok: true,
          version: CREW_VERSION,
          pid: process.pid,
          startedAt: ctx.startedAt,
          activeRuns: ctx.supervisor?.runningCount ?? 0,
          // A crew whose event log cannot be written is still supervising, but its record is
          // incomplete — say so where a human or `status` will actually see it.
          ...(ctx.bus.degraded
            ? { eventLog: { degraded: ctx.bus.degraded, droppedEvents: ctx.bus.droppedEvents } }
            : {}),
        });
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        const state = await ctx.store.getState();
        return json(res, 200, {
          state,
          runtimes: ctx.runtimes,
          docket: ctx.docket,
          workspace: ctx.workspace,
          daemon: { pid: process.pid, version: CREW_VERSION, startedAt: ctx.startedAt },
        });
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        // Backlog first, then live, without gaps or reordering: subscribe immediately (so
        // nothing emitted while the backlog is being read is lost), but buffer live events
        // until the backlog is on the wire, deduplicating by event id.
        //
        // The backlog is read BEFORE any header goes out. It used to be read after, which
        // meant a failure there had nowhere to be reported: writeHead(200) had already
        // happened, so the catch below threw ERR_HTTP_HEADERS_SENT out of an async listener
        // and took the whole daemon with it. Read first → a bad log is an honest 500 and the
        // daemon keeps supervising.
        const backlogN = Math.min(Number(url.searchParams.get("backlog") ?? 50) || 50, 500);
        const send = (event: unknown) => {
          if (res.writableEnded || res.destroyed) return;
          res.write(`event: crew\ndata: ${JSON.stringify(event)}\n\n`);
        };
        let backlogDone = false;
        const pending: { id: string }[] = [];
        const buffer = (event: { id: string }) => {
          if (!backlogDone) pending.push(event);
          else send(event);
        };
        const unsubscribe = ctx.bus.subscribe(buffer);
        let backlog: { id: string }[];
        try {
          backlog = await ctx.bus.readRecent(backlogN);
        } catch (err) {
          unsubscribe();
          throw err;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          ...SECURITY_HEADERS,
        });
        res.write("retry: 3000\n\n");
        sseClients.add(res);
        const heartbeat = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
        }, 25_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
          sseClients.delete(res);
        });
        const seen = new Set(backlog.map((e) => e.id));
        for (const event of backlog) send(event);
        for (const event of pending) if (!seen.has(event.id)) send(event);
        pending.length = 0;
        backlogDone = true;
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      failRequest(res, err);
    }
  });

  let boundPort = 0;
  return {
    server,
    router,
    ctx,
    port: () => boundPort,
    hold(): void {
      ready = false;
    },
    markReady(): void {
      ready = true;
    },
    start(port: number = Number(process.env.DOCKET_CREW_PORT ?? DEFAULT_CREW_PORT)): Promise<number> {
      return new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          const addr = server.address();
          boundPort = typeof addr === "object" && addr ? addr.port : port;
          resolvePromise(boundPort);
        });
      });
    },
    stop(): Promise<void> {
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          // already gone
        }
      }
      sseClients.clear();
      return new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}
