import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../http.js";
import QRCode from "qrcode";
import { getDevicePublicKey } from "../../device.js";
import { renderSessionStart } from "../../format.js";
import { computeAgentPresence } from "../../presence.js";
import { listSessions } from "../../sessions.js";
import { CURRENT_FORMAT_VERSION, readStore } from "../../storage.js";
import { todoService } from "../../todo-service.js";
import { SECURITY_HEADERS, json } from "../http.js";
import { getGeneration } from "../../generation.js";
import { getCurrentVersion } from "../../update.js";
import { fileURLToPath } from "node:url";

/** Distinguishes docket's dashboard from anything else that happens to answer on this port. */
export const WEB_UI_PRODUCT = "docket-web";

let cachedVersion: Promise<string> | null = null;
function packageVersion(): Promise<string> {
  cachedVersion ??= getCurrentVersion(fileURLToPath(import.meta.url)).catch(() => "0.0.0-unknown");
  return cachedVersion;
}

/**
 * Everything that answers "what is this install?" — version, pairing QR, device identity,
 * which agents are active, which terminals are open, and the payload the Claude Code
 * SessionStart hook fetches.
 *
 * The two source ranges were not adjacent in the old if-chain. They are safe to run together
 * because every path here is an exact literal and none of them can match a /api/todos request.
 */

export async function handleDeviceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<boolean> {
  // 4. Version
  if (req.method === "GET" && url.pathname === "/api/version") {
    json(res, 200, {
      formatVersion: CURRENT_FORMAT_VERSION,
      startedAt: ctx.startedAt,
      pid: process.pid,
      lanUrl: ctx.lanUrl,
      // Identity, not just liveness. `ensureWebUiRunning` used to accept any 200 on this
      // port as "the dashboard is already running", so after an upgrade the OLD detached
      // process kept serving — a build with a different store format and different route
      // behaviour, adopted silently by every new MCP session. These three fields are what
      // let a new process recognise a stale one instead of trusting a status code.
      product: WEB_UI_PRODUCT,
      packageVersion: await packageVersion(),
      // Which data directory this process is actually serving. `docket restore` probes this
      // port to warn about processes still holding the directory it is about to replace —
      // and a dashboard on the same port serving somebody ELSE's data directory (a second
      // install, a test run, a container) is not one of them. The port alone cannot tell
      // those apart; the generation can.
      generation: await getGeneration(),
    });
    return true;
  }

  // 5. QR Code
  if (req.method === "GET" && url.pathname === "/api/qr") {
    const custom = url.searchParams.get("text");
    const content = custom && custom.length <= 500 ? custom : ctx.lanUrl;
    if (!content) {
      json(res, 404, { error: "no LAN IP found" });
      return true;
    }
    const svg = await QRCode.toString(content, { type: "svg", margin: 1, width: 220 });
    res.writeHead(200, { "Content-Type": "image/svg+xml", ...SECURITY_HEADERS });
    res.end(svg);
    return true;
  }

  // 11. Device Info
  if (req.method === "GET" && url.pathname === "/api/device") {
    json(res, 200, {
      id: ctx.deviceId,
      name: ctx.deviceName,
      role: ctx.deviceRole,
      publicKeyX: await getDevicePublicKey(),
      isHostBrowser: ctx.hasUiSession(req),
    });
    return true;
  }

  // 11b. Agent Presence — "codex@ryzen active" / "idle 3m", derived from history (see presence.ts)
  if (req.method === "GET" && url.pathname === "/api/presence") {
    const store = await readStore();
    json(res, 200, { presence: computeAgentPresence(store) });
    return true;
  }

  // 11c. Live agent sessions — which terminals are open right now and where.
  // Distinct from /api/presence, which is derived from history and can only say what an
  // agent last DID. With a dozen terminals open, "where is it" is the actual question.
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    json(res, 200, { sessions: await listSessions() });
    return true;
  }

  // 11d. SessionStart hook payload — the ONE thing the Claude Code hook fetches.
  // Rendered here rather than in the hook process so the wording and the token budget live
  // in one place (src/format.ts, enforced by budget.test.ts), and so the hook stays a thin
  // HTTP client that never loads the MCP stack or decrypts anything itself.
  if (req.method === "GET" && url.pathname === "/api/hook/session-start") {
    const scope = url.searchParams.get("workspace");
    const todos = await todoService.list({ filter: "open", workspace: scope || "*" });
    json(res, 200, { text: renderSessionStart(todos, scope || null) });
    return true;
  }

  return false;
}
