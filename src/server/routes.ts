import type { IncomingMessage, ServerResponse } from "node:http";
import { getDeviceId, getDevicePublicKey } from "../device.js";
import { isSafeUrl, shortId } from "../mutations.js";
import {
  TodoClaimConflictError,
  TodoConflictError,
  type ClaimResult,
  type MutationContext,
  type TodoId,
  type TodoQuery,
} from "../repository.js";
import { CURRENT_FORMAT_VERSION } from "../storage.js";
import { todoService } from "../todo-service.js";
import type { Todo } from "../types.js";
import { checkPairingRateLimit } from "../sync/peering.js";
import {
  isDate,
  isPriority,
  isTodoList,
  json,
  patchDate,
  patchPriority,
  patchText,
  readRawBody,
  SECURITY_HEADERS,
  textOrNull,
} from "../web/http.js";
import { isAuthorizedAdminRequest } from "./admin-token.js";
import { checkDeviceAuth } from "./auth.js";
import {
  approvePairingRequest,
  createPairingCode,
  denyPairingRequest,
  getPairingRequestStatus,
  listDevices,
  listPendingPairingRequests,
  removeDevice,
  requestPairing,
  restoreDevice,
  revokeDevice,
} from "./devices.js";
import { broadcastServerEvent, sendServerVersionEvent, sseClients } from "./events.js";

/**
 * Version from day one (RFC "Local and Self-Hosted Backend Modes" §16) — a future v2 gets its
 * own prefix rather than breaking v1 clients in place.
 */
export const PROTOCOL_VERSION = 1;
export const MIN_CLIENT_PROTOCOL = 1;

export interface ServeApiContext {
  serverVersion: string;
  startedAt: string;
  /** The secret from <dataDir>/admin-token. See server/admin-token.ts for why a source
   *  address is not an identity once a reverse proxy is in the picture. */
  adminToken: string;
}

/** RFC §19: the local numeric id MUST NOT be part of the remote protocol. Every wire Todo uses the short human-facing id (see shortId() in mutations.ts) in `id`, plus the canonical `uuid`. */
type WireTodo = Omit<Todo, "id"> & { id: string };

function toWireTodo(todo: Todo): WireTodo {
  const { id: _localId, ...rest } = todo;
  return { id: shortId(todo.uuid), ...rest };
}

/**
 * `deviceId`/`deviceName` come from the AUTHENTICATED device (never a spoofable header —
 * closing the gap the Phase 1 placeholder bearer-auth explicitly flagged: "not
 * cryptographically verified"). `agent`/`session` stay self-reported the same way the
 * local web API hardcodes agent:"web" — there's no per-agent identity concept, only
 * per-device, so these remain descriptive/audit-trail fields, not a security boundary.
 */
function remoteContext(req: IncomingMessage, deviceId: string, deviceName: string): MutationContext {
  const header = (name: string): string | null => {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
  };
  return {
    agent: header("x-docket-agent"),
    session: header("x-docket-session"),
    deviceId,
    deviceName,
    // Which project the calling session is in, so items file themselves there rather than
    // landing unfiled. Self-reported like agent/session — the server has no view of the
    // client's filesystem — and descriptive rather than a security boundary.
    workspace: header("x-docket-workspace"),
  };
}

interface IfMatch {
  present: boolean;
  malformed: boolean;
  value?: number;
}

/** RFC §18: `If-Match: <revision>` — a plain integer, not a quoted HTTP entity-tag, matching the RFC's own example. */
function parseIfMatch(req: IncomingMessage): IfMatch {
  const raw = req.headers["if-match"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (header === undefined) return { present: false, malformed: false };
  const value = Number(header);
  if (!Number.isInteger(value)) return { present: true, malformed: true };
  return { present: true, malformed: false, value };
}

function conflict(res: ServerResponse, current: Todo, reason: string): void {
  json(res, 409, { error: reason, todo: toWireTodo(current) });
}

interface TodoRequestBody {
  title?: unknown;
  description?: unknown;
  list?: unknown;
  category?: unknown;
  priority?: unknown;
  dueDate?: unknown;
  sourceUrl?: unknown;
  workspace?: unknown;
}

function parseJsonBody(res: ServerResponse, raw: string): unknown | null {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    json(res, 400, { error: `malformed request body: ${(err as Error).message}` });
    return null;
  }
}

/**
 * Strictly 127.0.0.1/::1. Retained as defence in depth, NOT as the authorization boundary:
 * a reverse proxy — which the docs recommend for HTTPS — makes every forwarded request look
 * loopback, so this alone would let anyone on the internet reach the admin routes. The
 * credential check in isAuthorizedAdminRequest is what actually decides.
 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const addr = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  return addr === "127.0.0.1" || addr === "::1";
}

/**
 * Handles every `/api/v1/*` route (RFC §16). Returns false for anything outside that prefix
 * so the caller (server.ts) can 404 it. Every route below goes through todoService — the
 * SAME shared mutation-rules seam the MCP tools and the local web API use (RFC §8) — this
 * file only translates HTTP <-> that service, never reimplements a mutation rule itself.
 */
export async function handleServeApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ServeApiContext,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v1/")) return false;

  // 1. Health — public, no auth: meant for infra healthchecks (Docker HEALTHCHECK, systemd)
  // that have no device pairing of their own, and it leaks nothing sensitive.
  if (req.method === "GET" && url.pathname === "/api/v1/health") {
    json(res, 200, { ok: true, uptimeSeconds: process.uptime() });
    return true;
  }

  // 2. Info / compatibility negotiation (RFC §23) — also public: a client must be able to
  // check protocol compatibility and learn the server's identity BEFORE it has anything to
  // authenticate with (RFC §11's setup flow probes this ahead of pairing; RFC §13's pairing
  // needs the server's own X25519 public key to derive the shared secret it verifies during
  // approval — see server/devices.ts requestPairing).
  if (req.method === "GET" && url.pathname === "/api/v1/info") {
    json(res, 200, {
      product: "docket",
      serverVersion: ctx.serverVersion,
      protocolVersion: PROTOCOL_VERSION,
      minClientProtocol: MIN_CLIENT_PROTOCOL,
      storeFormatVersion: CURRENT_FORMAT_VERSION,
      features: ["claims", "history", "sse", "if-match", "device-pairing"],
      deviceId: await getDeviceId(),
      devicePublicKeyX: await getDevicePublicKey(),
    });
    return true;
  }

  // 3. Pairing — public but rate-limited (RFC §13/§31): the presenting device has nothing
  // to authenticate with yet. A pairing code is short-lived and single-use (server/devices.ts),
  // and the resulting device only becomes usable once a human approves it via the
  // loopback-only admin routes below — never automatically.
  if (req.method === "POST" && url.pathname === "/api/v1/pair/request") {
    const sourceIp = req.socket.remoteAddress ?? "unknown";
    if (!checkPairingRateLimit(sourceIp)) {
      json(res, 429, { error: "too many pairing attempts from this address — try again later" });
      return true;
    }
    const raw = await readRawBody(req);
    const body = parseJsonBody(res, raw);
    if (body === null) return true;
    const b = body as { code?: unknown; deviceId?: unknown; deviceName?: unknown; publicKeyX?: unknown };
    if (typeof b.code !== "string" || typeof b.deviceId !== "string" || typeof b.deviceName !== "string" || typeof b.publicKeyX !== "string") {
      json(res, 400, { error: "malformed pairing request — code, deviceId, deviceName, publicKeyX are all required" });
      return true;
    }
    const outcome = await requestPairing(b.code, b.deviceId, b.deviceName.slice(0, 80), b.publicKeyX);
    if (!outcome.ok) {
      json(res, 400, { error: outcome.error === "already_paired" ? "this device is already paired" : "pairing code is invalid, expired, or already used" });
      return true;
    }
    json(res, 200, { requestId: outcome.requestId, sas: outcome.sas });
    return true;
  }

  const pairStatusMatch = url.pathname.match(/^\/api\/v1\/pair\/status\/([\w-]+)$/);
  if (req.method === "GET" && pairStatusMatch) {
    const status = getPairingRequestStatus(pairStatusMatch[1]);
    if (!status) {
      json(res, 404, { error: "unknown or expired pairing request" });
      return true;
    }
    json(res, 200, status);
    return true;
  }

  // 4. Admin device management, backing `docket devices pair|list|revoke` (RFC §24).
  // Authorised by a local secret rather than by device signature: the operator on the
  // server machine has no paired device of their own yet — approving the first one is the
  // whole point — so the credential has to be something only a local process can read.
  if (url.pathname.startsWith("/api/v1/admin/devices")) {
    // Both, and the token is the one that matters. A request forwarded by a reverse proxy
    // satisfies the loopback check and cannot satisfy this one: the secret lives in a 0600
    // file on the server, and being proxied does not obtain it.
    if (!isLoopbackRequest(req) || !isAuthorizedAdminRequest(req, ctx.adminToken)) {
      json(res, 403, {
        error:
          "admin device routes require the local admin token — run `docket devices …` on the server machine itself, " +
          "as the user that runs `docket serve`",
      });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/admin/devices/pairing-code") {
      json(res, 200, createPairingCode());
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/admin/devices/pending") {
      json(res, 200, { requests: listPendingPairingRequests() });
      return true;
    }
    const approveMatch = url.pathname.match(/^\/api\/v1\/admin\/devices\/pending\/([\w-]+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      const device = await approvePairingRequest(approveMatch[1]);
      if (!device) {
        json(res, 404, { error: "no such pending request (it may have expired or already been resolved)" });
        return true;
      }
      const { secret: _secret, ...safe } = device;
      json(res, 200, { device: safe });
      return true;
    }
    const denyMatch = url.pathname.match(/^\/api\/v1\/admin\/devices\/pending\/([\w-]+)\/deny$/);
    if (req.method === "POST" && denyMatch) {
      const denied = denyPairingRequest(denyMatch[1]);
      json(res, denied ? 200 : 404, { denied });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/admin/devices") {
      const devices = await listDevices();
      json(res, 200, { devices: devices.map(({ secret: _secret, ...safe }) => safe) });
      return true;
    }
    const revokeMatch = url.pathname.match(/^\/api\/v1\/admin\/devices\/([\w-]+)\/revoke$/);
    if (req.method === "POST" && revokeMatch) {
      const ok = await revokeDevice(revokeMatch[1]);
      json(res, ok ? 200 : 404, { revoked: ok });
      return true;
    }
    const restoreMatch = url.pathname.match(/^\/api\/v1\/admin\/devices\/([\w-]+)\/restore$/);
    if (req.method === "POST" && restoreMatch) {
      const ok = await restoreDevice(restoreMatch[1]);
      json(res, ok ? 200 : 404, { restored: ok });
      return true;
    }
    const removeMatch = url.pathname.match(/^\/api\/v1\/admin\/devices\/([\w-]+)$/);
    if (req.method === "DELETE" && removeMatch) {
      const ok = await removeDevice(removeMatch[1]);
      json(res, ok ? 200 : 404, { removed: ok });
      return true;
    }
    json(res, 404, { error: "not found" });
    return true;
  }

  // Every route below requires a signed request from a paired, non-revoked device — RFC
  // §14: "Every remote API call MUST authenticate the device." Read the raw body ONCE
  // here so the signature check and the route's own JSON parsing see byte-identical
  // content — re-reading (or re-serializing a parsed object) could disagree with what
  // was actually signed.
  const rawBody = await readRawBody(req);
  const auth = await checkDeviceAuth(req, req.method ?? "GET", url.pathname + url.search, rawBody);
  if (!auth.ok) {
    json(res, auth.status, { error: auth.error });
    return true;
  }
  const context = remoteContext(req, auth.device.id, auth.device.name);

  // 5. Events (SSE) — RFC §20.
  if (req.method === "GET" && url.pathname === "/api/v1/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...SECURITY_HEADERS,
    });
    sseClients.add(res);
    sendServerVersionEvent(res, ctx.serverVersion);
    req.on("close", () => {
      sseClients.delete(res);
    });
    return true;
  }

  // 6. Todos — List
  if (req.method === "GET" && url.pathname === "/api/v1/todos") {
    const filterParam = url.searchParams.get("filter");
    const filter = filterParam === "open" || filterParam === "done" || filterParam === "all" ? filterParam : undefined;
    const listParam = url.searchParams.get("list");
    const list = isTodoList(listParam) || listParam === "all" ? (listParam as TodoQuery["list"]) : undefined;
    const query: TodoQuery = {
      filter,
      list,
      category: url.searchParams.get("category") ?? undefined,
      agent: url.searchParams.get("agent") ?? undefined,
      session: url.searchParams.get("session") ?? undefined,
      inProgress: url.searchParams.get("inProgress") === "true" ? true : undefined,
      workspace: url.searchParams.get("workspace") || undefined,
    };
    const todos = await todoService.list(query);
    json(res, 200, { todos: todos.map(toWireTodo) });
    return true;
  }

  // 7. Todos — Create
  if (req.method === "POST" && url.pathname === "/api/v1/todos") {
    const body = parseJsonBody(res, rawBody);
    if (body === null) return true;
    const b = body as TodoRequestBody;
    const title = typeof b.title === "string" ? b.title.trim() : "";
    if (!title) {
      json(res, 400, { error: "title is required" });
      return true;
    }
    const todo = await todoService.create(
      {
        title,
        description: textOrNull(b.description),
        list: isTodoList(b.list) ? b.list : "todo",
        category: textOrNull(b.category),
        priority: isPriority(b.priority) ? b.priority : null,
        dueDate: isDate(b.dueDate) ? b.dueDate : null,
        sourceUrl: typeof b.sourceUrl === "string" && isSafeUrl(b.sourceUrl) ? b.sourceUrl : null,
        // Only when the caller named one explicitly. Left undefined, create() falls back to
        // the calling session's own project from X-Docket-Workspace, which is what makes
        // filing automatic rather than something an agent has to remember.
        workspace: typeof b.workspace === "string" ? textOrNull(b.workspace) : undefined,
      },
      context,
    );
    broadcastServerEvent("todo.created", todo.uuid, context.deviceId);
    json(res, 201, { todo: toWireTodo(todo) });
    return true;
  }

  const idMatch = url.pathname.match(/^\/api\/v1\/todos\/([^/]+)$/);
  const id: TodoId | undefined = idMatch ? decodeURIComponent(idMatch[1]) : undefined;

  // 8. Todos — Get one
  if (req.method === "GET" && id !== undefined) {
    const todo = await todoService.get(id);
    if (!todo) {
      json(res, 404, { error: `No todo with id ${id}` });
      return true;
    }
    json(res, 200, { todo: toWireTodo(todo) });
    return true;
  }

  // 9. Todos — Edit (If-Match optional; RFC §18)
  if (req.method === "PATCH" && id !== undefined) {
    const ifMatch = parseIfMatch(req);
    if (ifMatch.malformed) {
      json(res, 400, { error: "If-Match must be an integer revision number" });
      return true;
    }
    const body = parseJsonBody(res, rawBody);
    if (body === null) return true;
    const b = body as TodoRequestBody;
    const nextTitle = typeof b.title === "string" ? b.title.trim() : "";
    const patch = {
      title: nextTitle || undefined,
      description: patchText(b.description),
      category: patchText(b.category),
      priority: patchPriority(b.priority),
      dueDate: patchDate(b.dueDate),
      sourceUrl: patchText(b.sourceUrl),
      list: isTodoList(b.list) ? b.list : undefined,
    };
    try {
      const todo = await todoService.edit(id, patch, context, ifMatch.value);
      if (!todo) {
        json(res, 404, { error: `No todo with id ${id}` });
        return true;
      }
      broadcastServerEvent("todo.updated", todo.uuid, context.deviceId);
      json(res, 200, { todo: toWireTodo(todo) });
    } catch (err) {
      if (err instanceof TodoConflictError) {
        conflict(res, err.current, "revision_conflict");
        return true;
      }
      throw err;
    }
    return true;
  }

  // 10. Todos — Delete (If-Match optional)
  if (req.method === "DELETE" && id !== undefined) {
    const ifMatch = parseIfMatch(req);
    if (ifMatch.malformed) {
      json(res, 400, { error: "If-Match must be an integer revision number" });
      return true;
    }
    try {
      const removed = await todoService.delete(id, context, ifMatch.value);
      if (!removed) {
        json(res, 404, { error: `No todo with id ${id}` });
        return true;
      }
      broadcastServerEvent("todo.deleted", removed.uuid, context.deviceId);
      json(res, 200, { removed: toWireTodo(removed) });
    } catch (err) {
      if (err instanceof TodoConflictError) {
        conflict(res, err.current, "revision_conflict");
        return true;
      }
      throw err;
    }
    return true;
  }

  const completeMatch = url.pathname.match(/^\/api\/v1\/todos\/([^/]+)\/complete$/);
  // 11. Todos — Complete (If-Match optional)
  if (req.method === "POST" && completeMatch) {
    const completeId = decodeURIComponent(completeMatch[1]);
    const ifMatch = parseIfMatch(req);
    if (ifMatch.malformed) {
      json(res, 400, { error: "If-Match must be an integer revision number" });
      return true;
    }
    try {
      const todo = await todoService.complete(completeId, context, ifMatch.value);
      if (!todo) {
        json(res, 404, { error: `No todo with id ${completeId}` });
        return true;
      }
      broadcastServerEvent("todo.completed", todo.uuid, context.deviceId);
      json(res, 200, { todo: toWireTodo(todo) });
    } catch (err) {
      if (err instanceof TodoConflictError) {
        conflict(res, err.current, "revision_conflict");
        return true;
      }
      throw err;
    }
    return true;
  }

  const claimMatch = url.pathname.match(/^\/api\/v1\/todos\/([^/]+)\/claim$/);
  // 12. Todos — Claim (RFC §21: atomic — 409 already_claimed unless force, If-Match optional)
  if (req.method === "POST" && claimMatch) {
    const claimId = decodeURIComponent(claimMatch[1]);
    const ifMatch = parseIfMatch(req);
    if (ifMatch.malformed) {
      json(res, 400, { error: "If-Match must be an integer revision number" });
      return true;
    }
    const rawClaimBody = parseJsonBody(res, rawBody);
    if (rawClaimBody === null) return true;
    const force = (rawClaimBody as { force?: unknown }).force === true;
    try {
      const claimed: ClaimResult | null = await todoService.claim(claimId, context, {
        expectedRevision: ifMatch.value,
        requireFree: true,
        force,
      });
      if (!claimed) {
        json(res, 404, { error: `No todo with id ${claimId}` });
        return true;
      }
      broadcastServerEvent("claim.acquired", claimed.todo.uuid, context.deviceId);
      json(res, 200, { todo: toWireTodo(claimed.todo), previousAgent: claimed.previousAgent });
    } catch (err) {
      if (err instanceof TodoConflictError) {
        conflict(res, err.current, "revision_conflict");
        return true;
      }
      if (err instanceof TodoClaimConflictError) {
        conflict(res, err.current, "already_claimed");
        return true;
      }
      throw err;
    }
    return true;
  }

  const releaseMatch = url.pathname.match(/^\/api\/v1\/todos\/([^/]+)\/release$/);
  // 13. Todos — Release (If-Match optional)
  if (req.method === "POST" && releaseMatch) {
    const releaseId = decodeURIComponent(releaseMatch[1]);
    const ifMatch = parseIfMatch(req);
    if (ifMatch.malformed) {
      json(res, 400, { error: "If-Match must be an integer revision number" });
      return true;
    }
    try {
      const todo = await todoService.release(releaseId, context, ifMatch.value);
      if (!todo) {
        json(res, 404, { error: `No todo with id ${releaseId}` });
        return true;
      }
      broadcastServerEvent("claim.released", todo.uuid, context.deviceId);
      json(res, 200, { todo: toWireTodo(todo) });
    } catch (err) {
      if (err instanceof TodoConflictError) {
        conflict(res, err.current, "revision_conflict");
        return true;
      }
      throw err;
    }
    return true;
  }

  const historyMatch = url.pathname.match(/^\/api\/v1\/todos\/([^/]+)\/history$/);
  // 14. Todos — History
  if (req.method === "GET" && historyMatch) {
    const historyId = decodeURIComponent(historyMatch[1]);
    const history = await todoService.history(historyId);
    if (!history) {
      json(res, 404, { error: `No todo with id ${historyId}` });
      return true;
    }
    json(res, 200, { history });
    return true;
  }

  return false;
}
