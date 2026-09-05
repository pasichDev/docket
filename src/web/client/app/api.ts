import type { Todo } from "./types.js";

/**
 * What the dashboard's own endpoints answer with.
 *
 * These were untyped object literals read straight out of `await res.json()`, which is
 * exactly where a rename on the server side becomes a blank panel in the browser with
 * nothing in the console. Declaring them here does not make the server honour them — only
 * web/routes does that — but it does mean a field this code reads has to exist somewhere in
 * writing, and that the two can be diffed when one moves.
 */

export interface DeviceInfo {
  id: string;
  name: string;
  role: "host" | "guest";
  publicKeyX: string;
  isHostBrowser: boolean;
}

export type TrustState = "trusted" | "verified" | "pending" | "revoked";

export interface PeerRow {
  id: string;
  name: string;
  url: string;
  trustState: TrustState;
  lastSyncAt: string | null;
  lastError?: string | null;
  revoked?: boolean;
  fingerprint?: string | null;
  protocolVersion?: number;
  clockSkewMs?: number;
}

export interface ViewerRow {
  id: string;
  label: string;
  lastSeenAt: string | null;
}

export interface PresenceRow {
  identity: string;
  active: boolean;
  lastActiveAt: string | null;
}

export interface SessionRow {
  agent: string | null;
  workspace: string | null;
  lastSeenAt: string;
}

export interface PairingRequest {
  requestId: string;
  deviceName: string;
  /** Short Authentication String — compare against the other device's screen before approving. */
  sas?: string;
}

export interface AccessRequest {
  requestId: string;
  ip: string;
}

export interface NotificationEvent {
  kind: "pairing" | "access";
  status: "pending" | "approved" | "denied" | "expired";
  label: string;
  createdAt: string;
  resolvedAt?: string | null;
}

export interface InviteResponse {
  url: string;
  token: string;
  publicKeyX: string;
  error?: string;
}

/**
 * A GET that returns parsed JSON, or throws. Deliberately not a swallow-and-return-null
 * helper: the callers below each decide what a failure means for their own panel, and a
 * shared "just return empty" would turn every outage into an empty list that looks like
 * real, current data.
 */
export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return (await res.json()) as T;
}

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}

export const listTodos = () => getJson<{ todos: Todo[] }>("/api/todos");
export const listPeers = () => getJson<{ peers: PeerRow[] }>("/api/peers");
export const listViewers = () => getJson<{ viewers: ViewerRow[] }>("/api/access/viewers");
export const listPresence = () => getJson<{ presence: PresenceRow[] }>("/api/presence");
export const listSessions = () => getJson<{ sessions: SessionRow[] }>("/api/sessions");
export const listPairingRequests = () => getJson<{ requests: PairingRequest[] }>("/api/pair/incoming");
export const listAccessRequests = () => getJson<{ requests: AccessRequest[] }>("/api/access/pending");
export const listNotifications = () => getJson<{ events: NotificationEvent[] }>("/api/notifications");
export const getDeviceInfo = () => getJson<DeviceInfo>("/api/device");
