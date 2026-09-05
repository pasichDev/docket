import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "./http.js";
import { handleAccessRoutes } from "./routes/access.js";
import { handleDataRoutes } from "./routes/data.js";
import { handleDeviceRoutes } from "./routes/device.js";
import { handlePairingRoutes } from "./routes/pairing.js";
import { handlePeerRoutes } from "./routes/peers.js";
import { handleStreamRoutes } from "./routes/stream.js";
import { handleSyncRoutes } from "./routes/sync.js";
import { handleTodoRoutes } from "./routes/todos.js";

/**
 * The dashboard's API surface, as a dispatch table.
 *
 * This was one 792-line function holding 28 route blocks in sequence, navigable only by the
 * numbered comments someone had written to make it navigable. The groups those comments
 * described are now modules; the comments are gone because the filenames say the same thing.
 *
 * Order is preserved from the old chain, and every group returns false when it recognises
 * nothing — so a request walks the same path it always did and an unmatched one still falls
 * through to the caller's 404. No group's paths overlap another's, so the order is a
 * formality rather than a rule; keeping it makes this a pure move.
 */
const ROUTE_GROUPS = [
  handleStreamRoutes,
  handleDataRoutes,
  handleDeviceRoutes,
  handleTodoRoutes,
  handlePeerRoutes,
  handlePairingRoutes,
  handleAccessRoutes,
  handleSyncRoutes,
];

export async function handleApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<boolean> {
  for (const group of ROUTE_GROUPS) {
    if (await group(req, res, url, ctx)) return true;
  }
  return false;
}
