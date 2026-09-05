import type { IncomingMessage, ServerResponse } from "node:http";
import type { MutationContext } from "../repository.js";
import type { TodoList, TodoPriority } from "../types.js";

/**
 * The HTTP kit both servers share: response helpers, body readers, and the small validators
 * that turn untyped JSON into the shapes the domain accepts.
 *
 * It lives on its own because the sync server (server/routes.ts) needs exactly these and
 * nothing else about the dashboard. It used to import them from web/api.ts, which meant the
 * self-hosted server pulled in the dashboard's entire route table to get at `json()`.
 */

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

/**
 * Exported (alongside readJsonBody below) so the remote server's device-signed routes
 * (src/server/routes.ts) can hash the EXACT raw bytes a caller signed before parsing them
 * — RFC "Local and Self-Hosted Backend Modes" §14's signature covers the raw body, and
 * re-serializing a parsed object could disagree byte-for-byte with what was actually sent.
 */
export async function readRawBody(req: IncomingMessage): Promise<string> {
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
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A request the CALLER got wrong. Distinguished from every other throw so the server answers
 * 4xx rather than 500: a malformed body is not a server fault, and telling a client "my
 * mistake, try again" when its own payload is broken sends it into a retry loop over
 * something no retry can fix.
 */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestError("request body is not valid JSON");
  }
}

// Exported for reuse by the remote server's own request validation (src/server/routes.ts) —
// the wire shapes match, so there's no reason for it to reinvent these.
export function isTodoList(value: unknown): value is TodoList {
  return value === "todo" || value === "backlog";
}

export function isPriority(value: unknown): value is TodoPriority {
  return value === "low" || value === "medium" || value === "high";
}

export function isDate(value: unknown): value is string {
  return typeof value === "string" && DATE_RE.test(value);
}

export function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function patchText(value: unknown): string | null | undefined {
  return typeof value === "string" ? textOrNull(value) : undefined;
}

export function patchPriority(value: unknown): TodoPriority | null | undefined {
  if (typeof value !== "string") return undefined;
  return isPriority(value) ? value : null;
}

export function patchDate(value: unknown): string | null | undefined {
  if (typeof value !== "string") return undefined;
  return isDate(value) ? value : null;
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

/** Every web-originated mutation is attributed to agent "web", one connection, no session token — matching what every route already passed to createTodo/applyEdits/etc. directly before TodoService existed. */
export function webContext(ctx: ApiContext): MutationContext {
  // No workspace: the dashboard is one shared view across every project, not a checkout, so
  // an item typed here is genuinely unfiled unless the caller names a project explicitly.
  return { agent: "web", session: null, deviceId: ctx.deviceId, deviceName: ctx.deviceName, workspace: null };
}
