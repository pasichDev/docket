import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../http.js";
import { SECURITY_HEADERS } from "../http.js";

/**
 * Server-sent events. One route, kept apart because it is the only handler that keeps the
 * response open instead of answering and returning.
 */

export async function handleStreamRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<boolean> {
  // 1. SSE Events
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...SECURITY_HEADERS,
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ connectedAt: Date.now() })}\n\n`);
    ctx.sseClients.add(res);
    req.on("close", () => {
      ctx.sseClients.delete(res);
    });
    return true;
  }

  return false;
}
