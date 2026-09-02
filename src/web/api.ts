import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import QRCode from "qrcode";
import {
  approveAccessRequest,
  checkAccessRateLimit,
  createAccessRequest,
  denyAccessRequest,
  listAccessRequests,
  pollAccessRequest,
} from "../access.js";
import { deriveSharedSecret, getDevicePublicKey, getDeviceRole, setDeviceRole } from "../device.js";
import { exportToJson, exportToMarkdown, importFromJson, importFromMarkdown } from "../export.js";
import { log } from "../log.js";
import { applyEdits, completeTodo, createTodo, isClaimActive, isSafeUrl, shortId, tombstoneDelete } from "../mutations.js";
import { listEvents, recordCreated, recordResolved } from "../notifications.js";
import { addPeer, loadPeers, peerFingerprint, peerTrustState, removePeer, restorePeer, revokePeer, updatePeerUrl } from "../peers.js";
import { computeAgentPresence } from "../presence.js";
import { CURRENT_FORMAT_VERSION, readStore, withStore, withTodo } from "../storage.js";
import {
  addIncomingRequest,
  addOutgoingRequest,
  checkPairingRateLimit,
  confirmProof,
  createInvite,
  encryptSyncPayload,
  getIncomingRequest,
  getOutgoingRequest,
  isSyncProtocolCompatible,
  listIncomingRequests,
  MIN_COMPATIBLE_SYNC_PROTOCOL_VERSION,
  pairingSas,
  redeemInvite,
  removeIncomingRequest,
  resolveOutgoingRequest,
  signSyncRequest,
  SYNC_PROTOCOL_VERSION,
  verifyConfirmProof,
  verifySyncRequest,
  type SyncPayload,
} from "../sync.js";
import type { Peer, TodoList, TodoPriority } from "../types.js";
import { addViewer, loadViewers, removeViewer } from "../viewers.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
} as const;

export function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...SECURITY_HEADERS,
  });
  res.end(payload);
}

/** Far above any legitimate payload (imports included) — exists so one request to a reachable endpoint can't buffer an unbounded body into memory. */
const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    // Throwing (rather than destroying the socket) lets the caller still send its
    // error response; Node tears the connection down itself once the response ends
    // with the request body unconsumed.
    if (total > MAX_JSON_BODY_BYTES) throw new Error(`request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function isTodoList(value: unknown): value is TodoList {
  return value === "todo" || value === "backlog";
}

function isPriority(value: unknown): value is TodoPriority {
  return value === "low" || value === "medium" || value === "high";
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && DATE_RE.test(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function patchText(value: unknown): string | null | undefined {
  return typeof value === "string" ? textOrNull(value) : undefined;
}

function patchPriority(value: unknown): TodoPriority | null | undefined {
  if (typeof value !== "string") return undefined;
  return isPriority(value) ? value : null;
}

function patchDate(value: unknown): string | null | undefined {
  if (typeof value !== "string") return undefined;
  return isDate(value) ? value : null;
}

interface TodoRequestBody {
  title?: unknown;
  description?: unknown;
  list?: unknown;
  category?: unknown;
  priority?: unknown;
  dueDate?: unknown;
  sourceUrl?: unknown;
}

function isPrivateNetworkUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname;
  const octets = host.split(".");
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return false;
  const [a, b] = octets.map(Number);
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

async function postPairConfirm(callbackUrl: string, requestId: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${callbackUrl.replace(/\/$/, "")}/api/pair/confirm/${requestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`confirm callback rejected: ${res.status}`);
}

export interface ApiContext {
  deviceId: string;
  deviceName: string;
  deviceRole: "host" | "guest";
  setDeviceRoleState: (role: "host" | "guest") => void;
  lanUrl: string | null;
  startedAt: string;
  viewerCookieName: string;
  hasUiSession: (req: IncomingMessage) => boolean;
  hasViewerSession: (req: IncomingMessage) => Promise<boolean>;
  isAuthorizedBrowser: (req: IncomingMessage) => Promise<boolean>;
  isLocalRequest: (req: IncomingMessage) => boolean;
  broadcastUpdate: () => void;
  sseClients: Set<ServerResponse>;
  sha256Hex: (val: string) => string;
}

export async function removePeerAndMaybeRevertRole(id: string, ctx: ApiContext): Promise<boolean> {
  const ok = await removePeer(id);
  if (ok && ctx.deviceRole === "guest" && (await loadPeers()).length === 0) {
    ctx.setDeviceRoleState("host");
    await setDeviceRole("host");
    log("pairing: this device left its last group and is a host again");
  }
  return ok;
}

export async function handleApiRoute(
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

  // 2. Export
  if (req.method === "GET" && url.pathname === "/api/export") {
    const format = url.searchParams.get("format")?.toLowerCase() === "markdown" ? "markdown" : "json";
    const store = await readStore();
    const filename = format === "markdown" ? `todos-${new Date().toISOString().slice(0, 10)}.md` : `todos-${new Date().toISOString().slice(0, 10)}.json`;
    const contentType = format === "markdown" ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8";
    const content = format === "markdown" ? exportToMarkdown(store) : exportToJson(store);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      ...SECURITY_HEADERS,
    });
    res.end(content);
    return true;
  }

  // 3. Import
  if (req.method === "POST" && url.pathname === "/api/import") {
    const body = (await readJsonBody(req)) as { content?: unknown; filename?: unknown };
    const rawContent = typeof body.content === "string" ? body.content : "";
    if (!rawContent.trim()) {
      json(res, 400, { error: "No content provided to import" });
      return true;
    }
    const filename = typeof body.filename === "string" ? body.filename : "";
    const isJson = filename.endsWith(".json") || rawContent.trim().startsWith("{") || rawContent.trim().startsWith("[");
    const result = await withStore((store) => {
      if (isJson) {
        return importFromJson(store, rawContent, ctx.deviceId, ctx.deviceName);
      }
      return importFromMarkdown(store, rawContent, ctx.deviceId, ctx.deviceName);
    });
    ctx.broadcastUpdate();
    json(res, 200, result);
    return true;
  }

  // 4. Version
  if (req.method === "GET" && url.pathname === "/api/version") {
    json(res, 200, {
      formatVersion: CURRENT_FORMAT_VERSION,
      startedAt: ctx.startedAt,
      pid: process.pid,
      lanUrl: ctx.lanUrl,
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

  // 6. Todos - List
  if (req.method === "GET" && url.pathname === "/api/todos") {
    const store = await readStore();
    // shortId travels with each item so the web UI can show the same cross-device id an
    // MCP tool would — computed here, not client-side, so there's only one place deriving
    // it from uuid (see shortId() in mutations.ts).
    const todos = store.todos.map((t) => ({ ...(isClaimActive(t) ? t : { ...t, workingAgent: null }), shortId: shortId(t.uuid) }));
    json(res, 200, { todos });
    return true;
  }

  // 7. Todos - Create
  if (req.method === "POST" && url.pathname === "/api/todos") {
    const body = (await readJsonBody(req)) as TodoRequestBody;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      json(res, 400, { error: "title is required" });
      return true;
    }
    const todo = await withStore((store) =>
      createTodo(
        store,
        {
          title,
          description: textOrNull(body.description),
          list: isTodoList(body.list) ? body.list : "todo",
          category: textOrNull(body.category),
          priority: isPriority(body.priority) ? body.priority : null,
          dueDate: isDate(body.dueDate) ? body.dueDate : null,
          sourceUrl: textOrNull(body.sourceUrl),
          agent: "web",
          session: null,
        },
        ctx.deviceId,
        ctx.deviceName,
      ),
    );
    ctx.broadcastUpdate();
    json(res, 201, { todo });
    return true;
  }

  // 8. Todos - Complete
  const completeMatch = url.pathname.match(/^\/api\/todos\/(\d+)\/complete$/);
  if (req.method === "POST" && completeMatch) {
    const id = Number(completeMatch[1]);
    const todo = await withTodo(id, (item) => completeTodo(item, "web", ctx.deviceId, ctx.deviceName));
    if (!todo) {
      json(res, 404, { error: `No todo with id #${id}` });
      return true;
    }
    ctx.broadcastUpdate();
    json(res, 200, { todo });
    return true;
  }

  // 9. Todos - Edit / Patch
  const todoIdMatch = url.pathname.match(/^\/api\/todos\/(\d+)$/);
  if (req.method === "PATCH" && todoIdMatch) {
    const id = Number(todoIdMatch[1]);
    const body = (await readJsonBody(req)) as TodoRequestBody;
    const nextTitle = typeof body.title === "string" ? body.title.trim() : "";
    const patch = {
      title: nextTitle || undefined,
      description: patchText(body.description),
      category: patchText(body.category),
      priority: patchPriority(body.priority),
      dueDate: patchDate(body.dueDate),
      sourceUrl: patchText(body.sourceUrl),
      list: isTodoList(body.list) ? body.list : undefined,
    };
    const todo = await withTodo(id, (item) => applyEdits(item, patch, "web", ctx.deviceId, ctx.deviceName));
    if (!todo) {
      json(res, 404, { error: `No todo with id #${id}` });
      return true;
    }
    ctx.broadcastUpdate();
    json(res, 200, { todo });
    return true;
  }

  // 10. Todos - Delete
  if (req.method === "DELETE" && todoIdMatch) {
    const id = Number(todoIdMatch[1]);
    const removed = await withTodo(id, (item, store) => tombstoneDelete(store, item, ctx.deviceId));
    if (!removed) {
      json(res, 404, { error: `No todo with id #${id}` });
      return true;
    }
    log(`deleted #${removed.id} "${removed.title}" by web`);
    ctx.broadcastUpdate();
    json(res, 200, { removed });
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

  // 12. Peers - List
  if (req.method === "GET" && url.pathname === "/api/peers") {
    const peers = await loadPeers();
    json(res, 200, {
      peers: peers.map(({ secret: _secret, publicKeyX, ...safe }) => ({
        ...safe,
        trustState: peerTrustState({ ...safe, publicKeyX } as Peer),
        fingerprint: publicKeyX ? peerFingerprint(publicKeyX) : null,
      })),
    });
    return true;
  }

  // 13. Peers - Delete
  const unpairMatch = url.pathname.match(/^\/api\/peers\/([\w-]+)$/);
  if (req.method === "DELETE" && unpairMatch) {
    // Unpairing is pairing management — approved LAN viewers can view/edit the LIST,
    // but must never be able to detach this device's sync partners (every other
    // pairing-management route already requires the host browser's own session).
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const ok = await removePeerAndMaybeRevertRole(unpairMatch[1], ctx);
    json(res, ok ? 200 : 404, { removed: ok });
    return true;
  }

  // 13b. Peers - Revoke / Restore (blocks/resumes sync without dropping the pairing — see peers.ts)
  const peerRevokeMatch = url.pathname.match(/^\/api\/peers\/([\w-]+)\/revoke$/);
  if (req.method === "POST" && peerRevokeMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const ok = await revokePeer(peerRevokeMatch[1]);
    json(res, ok ? 200 : 404, { revoked: ok });
    return true;
  }
  const peerRestoreMatch = url.pathname.match(/^\/api\/peers\/([\w-]+)\/restore$/);
  if (req.method === "POST" && peerRestoreMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const ok = await restorePeer(peerRestoreMatch[1]);
    json(res, ok ? 200 : 404, { restored: ok });
    return true;
  }

  // 13c. Peers - Update Address (manual recovery when a peer's LAN address changes — see backlog #139)
  const peerAddressMatch = url.pathname.match(/^\/api\/peers\/([\w-]+)\/address$/);
  if (req.method === "POST" && peerAddressMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const peer = (await loadPeers()).find((p) => p.id === peerAddressMatch[1]);
    if (!peer) {
      json(res, 404, { error: "unknown peer" });
      return true;
    }
    const body = (await readJsonBody(req)) as { url?: unknown };
    if (typeof body.url !== "string" || !isSafeUrl(body.url)) {
      json(res, 400, { error: "invalid address" });
      return true;
    }
    const newUrl = body.url.replace(/\/$/, "");
    // Re-verify identity at the NEW address before trusting it — but NOT via /api/device's
    // self-reported id/publicKeyX, which anything can answer unauthenticated (and is all
    // most existing peers have on record anyway, from before publicKeyX was persisted).
    // Instead, prove it cryptographically: sign a sync request with the SECRET already on
    // file for this peer. Only the genuine paired device derived that same secret via ECDH,
    // so only it can produce a response the candidate address's own /api/sync accepts.
    const since = "9999-01-01T00:00:00.000Z"; // far future — verified via signature only, no data ever needs to come back
    const timestamp = new Date().toISOString();
    const signature = signSyncRequest(peer.secret, ctx.deviceId, since, timestamp);
    const proofUrl = `${newUrl}/api/sync?since=${encodeURIComponent(since)}&deviceId=${encodeURIComponent(ctx.deviceId)}&timestamp=${encodeURIComponent(timestamp)}&signature=${signature}`;
    try {
      const proofRes = await fetch(proofUrl, { signal: AbortSignal.timeout(5000) });
      if (!proofRes.ok) throw new Error(`status ${proofRes.status}`);
    } catch (err) {
      json(res, 403, { error: `the device at that address didn't prove it holds this peer's shared secret — refusing to update: ${(err as Error).message}` });
      return true;
    }
    await updatePeerUrl(peer.id, newUrl);
    log(`peers: updated address for ${peer.name} (${peer.id}) to ${newUrl} after re-verifying identity`);
    json(res, 200, { ok: true });
    return true;
  }

  // 14. Pair - Create Invite
  if (req.method === "POST" && url.pathname === "/api/pair/invite") {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    if (ctx.deviceRole !== "host") {
      json(res, 403, { error: "this device joined another device's group as a guest — only that host can invite further devices" });
      return true;
    }
    if (!ctx.lanUrl) {
      json(res, 400, { error: "No LAN IP found — can't be paired from another device without one." });
      return true;
    }
    const { token, expiresAt } = createInvite();
    // publicKeyX travels in the invite itself (QR / full-line paste) — the ONE channel an
    // active LAN attacker can't tamper with — so the redeeming device can anchor trust in
    // this device's real identity before ever making a network call. See pairingSas().
    json(res, 200, {
      token,
      expiresAt,
      deviceId: ctx.deviceId,
      deviceName: ctx.deviceName,
      url: ctx.lanUrl,
      publicKeyX: await getDevicePublicKey(),
    });
    return true;
  }

  // 15. Pair - Remote Request
  if (req.method === "POST" && url.pathname === "/api/pair/request") {
    if (ctx.deviceRole !== "host") {
      json(res, 403, { error: "this device is a guest and can't accept pairing requests" });
      return true;
    }
    const sourceIp = req.socket.remoteAddress ?? "unknown";
    if (!checkPairingRateLimit(sourceIp)) {
      json(res, 429, { error: "too many pairing attempts from this address — try again later" });
      return true;
    }
    const body = (await readJsonBody(req)) as {
      token?: unknown;
      deviceId?: unknown;
      deviceName?: unknown;
      callbackUrl?: unknown;
      publicKeyX?: unknown;
    };
    if (
      typeof body.token !== "string" ||
      typeof body.deviceId !== "string" ||
      typeof body.deviceName !== "string" ||
      typeof body.callbackUrl !== "string" ||
      typeof body.publicKeyX !== "string"
    ) {
      json(res, 400, { error: "malformed pairing request" });
      return true;
    }
    if (!isPrivateNetworkUrl(body.callbackUrl)) {
      json(res, 400, { error: "callbackUrl must be a private-network address" });
      return true;
    }
    if (body.deviceId === ctx.deviceId) {
      json(res, 400, { error: "can't pair a device with itself" });
      return true;
    }
    if (!redeemInvite(body.token)) {
      json(res, 400, { error: "invite token is invalid, expired, or already used" });
      return true;
    }
    const requestId = randomUUID();
    const secret = await deriveSharedSecret(body.publicKeyX);
    addIncomingRequest(requestId, {
      deviceId: body.deviceId,
      deviceName: body.deviceName.slice(0, 80),
      callbackUrl: body.callbackUrl,
      peerPublicKeyX: body.publicKeyX,
      receivedAt: Date.now(),
      sas: pairingSas(secret, await getDevicePublicKey(), body.publicKeyX),
    });
    recordCreated(requestId, "pairing", body.deviceName.slice(0, 80));
    log(`pairing: incoming request ${requestId} from ${body.deviceName} — awaiting approval`);
    json(res, 200, { requestId });
    return true;
  }

  // 16. Pair - List Incoming
  if (req.method === "GET" && url.pathname === "/api/pair/incoming") {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    json(res, 200, { requests: listIncomingRequests() });
    return true;
  }

  // 17. Pair - Approve Incoming
  const approveMatch = url.pathname.match(/^\/api\/pair\/approve\/([\w-]+)$/);
  if (req.method === "POST" && approveMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    if (ctx.deviceRole !== "host") {
      json(res, 403, { error: "only the host device can approve pairing requests" });
      return true;
    }
    const requestId = approveMatch[1];
    const pending = getIncomingRequest(requestId);
    if (!pending) {
      json(res, 404, { error: "no such pending request (it may have expired)" });
      return true;
    }
    const secret = await deriveSharedSecret(pending.peerPublicKeyX);
    try {
      await postPairConfirm(pending.callbackUrl, requestId, { proof: confirmProof(secret, requestId) });
    } catch (err) {
      log(`pairing: confirm callback to ${pending.deviceName} failed, not pairing: ${(err as Error).message}`);
      json(res, 502, { error: "couldn't reach the other device to confirm pairing — try again" });
      return true;
    }
    await addPeer({
      id: pending.deviceId,
      name: pending.deviceName,
      url: pending.callbackUrl,
      secret,
      pairedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastSyncOk: true,
      publicKeyX: pending.peerPublicKeyX,
    });
    removeIncomingRequest(requestId);
    recordResolved(requestId, "approved");
    log(`pairing: approved ${pending.deviceName} (${pending.deviceId})`);
    json(res, 200, { paired: true });
    return true;
  }

  // 18. Pair - Deny Incoming
  const denyMatch = url.pathname.match(/^\/api\/pair\/deny\/([\w-]+)$/);
  if (req.method === "POST" && denyMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    if (ctx.deviceRole !== "host") {
      json(res, 403, { error: "only the host device can respond to pairing requests" });
      return true;
    }
    const requestId = denyMatch[1];
    const pending = getIncomingRequest(requestId);
    if (!pending) {
      json(res, 404, { error: "no such pending request" });
      return true;
    }
    removeIncomingRequest(requestId);
    recordResolved(requestId, "denied");
    log(`pairing: denied ${pending.deviceName} (${pending.deviceId})`);
    try {
      const secret = await deriveSharedSecret(pending.peerPublicKeyX);
      await postPairConfirm(pending.callbackUrl, requestId, { denied: true, proof: confirmProof(secret, requestId) });
    } catch {}
    json(res, 200, { denied: true });
    return true;
  }

  // 19. Pair - Redeem Local
  if (req.method === "POST" && url.pathname === "/api/pair/redeem") {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const body = (await readJsonBody(req)) as { peerUrl?: unknown; token?: unknown; publicKeyX?: unknown };
    if (typeof body.peerUrl !== "string" || typeof body.token !== "string" || !body.peerUrl || !body.token) {
      json(res, 400, { error: "peerUrl and token are required" });
      return true;
    }
    if (!ctx.lanUrl) {
      json(res, 400, { error: "No LAN IP on this machine — can't receive the pairing callback." });
      return true;
    }
    // If the invite carried the host's public key (QR / full-line paste, not just the bare
    // 6-char code), anchor trust in it via the out-of-band channel — derive the secret and
    // an SAS to show the human RIGHT NOW, before any network round-trip can be tampered with.
    const expectedPublicKeyX = typeof body.publicKeyX === "string" ? body.publicKeyX : undefined;
    let sas: string | undefined;
    if (expectedPublicKeyX) {
      const secret = await deriveSharedSecret(expectedPublicKeyX);
      sas = pairingSas(secret, expectedPublicKeyX, await getDevicePublicKey());
    }
    try {
      const upstream = await fetch(`${body.peerUrl.replace(/\/$/, "")}/api/pair/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: body.token,
          deviceId: ctx.deviceId,
          deviceName: ctx.deviceName,
          callbackUrl: ctx.lanUrl,
          publicKeyX: await getDevicePublicKey(),
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!upstream.ok) {
        const errBody = (await upstream.json().catch(() => ({}))) as { error?: string };
        json(res, 400, { error: errBody.error ?? `peer responded ${upstream.status}` });
        return true;
      }
      const { requestId } = (await upstream.json()) as { requestId: string };
      addOutgoingRequest(requestId, { peerUrl: body.peerUrl, status: "pending", expectedPublicKeyX, sas });
      json(res, 200, { requestId, sas });
    } catch (err) {
      json(res, 502, { error: `couldn't reach that device: ${(err as Error).message}` });
    }
    return true;
  }

  // 20. Pair - Outgoing Status
  const outgoingStatusMatch = url.pathname.match(/^\/api\/pair\/outgoing\/([\w-]+)$/);
  if (req.method === "GET" && outgoingStatusMatch) {
    if (!ctx.hasUiSession(req)) {
      json(res, 403, { error: "this action must come from this device's own browser" });
      return true;
    }
    const pendingOut = getOutgoingRequest(outgoingStatusMatch[1]);
    if (!pendingOut) {
      json(res, 404, { error: "unknown or expired pairing request" });
      return true;
    }
    json(res, 200, { status: pendingOut.status, deviceName: pendingOut.peerDeviceName, sas: pendingOut.sas });
    return true;
  }

  // 21. Pair - Confirm Callback
  const confirmMatch = url.pathname.match(/^\/api\/pair\/confirm\/([\w-]+)$/);
  if (req.method === "POST" && confirmMatch) {
    const requestId = confirmMatch[1];
    const pending = getOutgoingRequest(requestId);
    if (!pending) {
      json(res, 404, { error: "unknown or expired pairing request" });
      return true;
    }
    const body = (await readJsonBody(req)) as { denied?: unknown; proof?: unknown };
    if (typeof body.proof !== "string") {
      json(res, 400, { error: "malformed confirmation" });
      return true;
    }

    let peerInfo: { id: string; name: string; publicKeyX: string };
    try {
      const infoRes = await fetch(`${pending.peerUrl.replace(/\/$/, "")}/api/device`, { signal: AbortSignal.timeout(5000) });
      if (!infoRes.ok) throw new Error(`status ${infoRes.status}`);
      const raw = (await infoRes.json()) as Partial<typeof peerInfo>;
      if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.publicKeyX !== "string") {
        throw new Error("malformed device info");
      }
      peerInfo = { id: raw.id, name: raw.name, publicKeyX: raw.publicKeyX };
    } catch (err) {
      json(res, 502, { error: `couldn't verify the pairing device's identity: ${(err as Error).message}` });
      return true;
    }

    // If this device redeemed with the host's public key already anchored via the invite
    // itself, an attacker who intercepted the pairing traffic and swapped in a different
    // /api/device response here would be caught by this mismatch, not silently trusted.
    if (pending.expectedPublicKeyX && pending.expectedPublicKeyX !== peerInfo.publicKeyX) {
      json(res, 403, { error: "the confirming device's public key doesn't match the one from the pairing invite" });
      return true;
    }

    const secret = await deriveSharedSecret(peerInfo.publicKeyX);
    if (!verifyConfirmProof(secret, requestId, body.proof)) {
      json(res, 403, { error: "invalid proof" });
      return true;
    }
    if (body.denied) {
      resolveOutgoingRequest(requestId, { status: "denied" });
      json(res, 200, { ok: true });
      return true;
    }
    const peerName = peerInfo.name.slice(0, 80);
    await addPeer({
      id: peerInfo.id,
      name: peerName,
      url: pending.peerUrl,
      secret,
      pairedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastSyncOk: true,
      publicKeyX: peerInfo.publicKeyX,
    });
    resolveOutgoingRequest(requestId, { status: "confirmed", peerDeviceId: peerInfo.id, peerDeviceName: peerName });
    if (ctx.deviceRole !== "guest") {
      ctx.setDeviceRoleState("guest");
      await setDeviceRole("guest");
      log(`pairing: this device is now a guest of ${peerName}'s group (joined via invite)`);
    }
    log(`pairing: confirmed with ${peerName} (${peerInfo.id})`);
    json(res, 200, { ok: true });
    return true;
  }

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

  // 30. Peer Sync - Sync Endpoint
  if (req.method === "GET" && url.pathname === "/api/sync") {
    const since = url.searchParams.get("since") ?? "";
    const callerDeviceId = url.searchParams.get("deviceId") ?? "";
    const timestamp = url.searchParams.get("timestamp") ?? "";
    const signature = url.searchParams.get("signature") ?? "";
    const callerProtocolVersionRaw = url.searchParams.get("protocolVersion");
    const callerProtocolVersion = callerProtocolVersionRaw === null ? null : Number(callerProtocolVersionRaw);
    const peers = await loadPeers();
    const peer = peers.find((p) => p.id === callerDeviceId);
    if (!peer) {
      json(res, 403, { error: "not a paired device", reason: "unpaired" });
      return true;
    }
    if (peer.revoked) {
      json(res, 403, { error: "this peer has been revoked", reason: "revoked" });
      return true;
    }
    if (!verifySyncRequest(peer.secret, callerDeviceId, since, timestamp, signature)) {
      json(res, 403, { error: "signature invalid or expired" });
      return true;
    }
    if (!isSyncProtocolCompatible(callerProtocolVersion)) {
      json(res, 409, {
        error: `caller's sync protocol v${callerProtocolVersion} is older than this device supports`,
        reason: "protocol-incompatible",
        minVersion: MIN_COMPATIBLE_SYNC_PROTOCOL_VERSION,
      });
      return true;
    }
    const store = await readStore();
    const payload: SyncPayload = {
      todos: store.todos.filter((t) => t.updatedAt > since),
      deletedUuids: (store.deletedUuids ?? []).filter((t) => t.deletedAt > since),
      serverTime: new Date().toISOString(),
      protocolVersion: SYNC_PROTOCOL_VERSION,
    };
    json(res, 200, encryptSyncPayload(peer.secret, payload));
    return true;
  }

  return false;
}
