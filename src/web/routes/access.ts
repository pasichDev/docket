import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../http.js";
import { approveAccessRequest, checkAccessRateLimit, createAccessRequest, denyAccessRequest, listAccessRequests, pollAccessRequest } from "../../access.js";
import { log } from "../../log.js";
import { listEvents, recordCreated, recordResolved } from "../../notifications.js";
import { listIncomingRequests } from "../../sync/peering.js";
import { addViewer, loadViewers, removeViewer } from "../../viewers.js";
import { SECURITY_HEADERS, json } from "../http.js";

/**
 * Who is allowed to open this dashboard from another browser: requesting access, approving or
 * denying it, listing and revoking the viewers that resulted, and the notification feed that
 * tells the host a request is waiting.
 */

export async function handleAccessRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<boolean> {
  // 22. Access - Request
  if (req.method === "POST" && url.pathname === "/api/access/request") {
    if (ctx.isLocalRequest(req) || (await ctx.hasViewerSession(req))) {
      json(res, 200, { ok: true, alreadyAuthorized: true });
      return true;
    }
    const sourceIp = req.socket.remoteAddress ?? "unknown";
    if (!checkAccessRateLimit(sourceIp)) {
      json(res, 429, { error: "too many requests from this address — try again later" });
      return true;
    }
    const requestId = createAccessRequest(sourceIp);
    recordCreated(requestId, "access", sourceIp);
    log(`access: request ${requestId} from ${sourceIp} — awaiting approval`);
    json(res, 200, { requestId });
    return true;
  }

  // 23. Access - Status Poll
  const accessStatusMatch = url.pathname.match(/^\/api\/access\/status\/([\w-]+)$/);
  if (req.method === "GET" && accessStatusMatch) {
    const result = pollAccessRequest(accessStatusMatch[1]);
    if (result.status === "approved") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `${ctx.viewerCookieName}=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        ...SECURITY_HEADERS,
      });
      res.end(JSON.stringify({ status: "approved" }));
      return true;
    }
    json(res, 200, { status: result.status });
    return true;
  }

  // 24. Access - List Pending
  if (req.method === "GET" && url.pathname === "/api/access/pending") {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    json(res, 200, { requests: listAccessRequests() });
    return true;
  }

  // 25. Access - Approve
  const accessApproveMatch = url.pathname.match(/^\/api\/access\/approve\/([\w-]+)$/);
  if (req.method === "POST" && accessApproveMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const requestId = accessApproveMatch[1];
    const token = randomBytes(32).toString("hex");
    const ok = approveAccessRequest(requestId, token);
    if (!ok) {
      json(res, 404, { error: "no such pending request (it may have expired)" });
      return true;
    }
    recordResolved(requestId, "approved");
    await addViewer({
      id: randomUUID(),
      tokenHash: ctx.sha256Hex(token),
      label: `Browser (${requestId.slice(0, 8)})`,
      approvedAt: new Date().toISOString(),
      lastSeenAt: null,
    });
    log(`access: approved request ${requestId}`);
    json(res, 200, { approved: true });
    return true;
  }

  // 26. Access - Deny
  const accessDenyMatch = url.pathname.match(/^\/api\/access\/deny\/([\w-]+)$/);
  if (req.method === "POST" && accessDenyMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const ok = denyAccessRequest(accessDenyMatch[1]);
    if (ok) recordResolved(accessDenyMatch[1], "denied");
    json(res, ok ? 200 : 404, { denied: ok });
    return true;
  }

  // 27. Notifications
  if (req.method === "GET" && url.pathname === "/api/notifications") {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const liveIds = new Set([
      ...listIncomingRequests().map((r) => r.requestId),
      ...listAccessRequests().map((r) => r.requestId),
    ]);
    json(res, 200, { events: listEvents(liveIds) });
    return true;
  }

  // 28. Access - List Viewers
  if (req.method === "GET" && url.pathname === "/api/access/viewers") {
    if (!(await ctx.isAuthorizedBrowser(req))) {
      json(res, 403, { error: "this browser hasn't been granted access" });
      return true;
    }
    const viewers = await loadViewers();
    json(res, 200, { viewers: viewers.map(({ tokenHash: _tokenHash, ...safe }) => safe) });
    return true;
  }

  // 29. Access - Revoke Viewer
  const viewerRevokeMatch = url.pathname.match(/^\/api\/access\/viewers\/([\w-]+)$/);
  if (req.method === "DELETE" && viewerRevokeMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const ok = await removeViewer(viewerRevokeMatch[1]);
    json(res, ok ? 200 : 404, { removed: ok });
    return true;
  }

  return false;
}
