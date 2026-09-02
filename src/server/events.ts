import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

/** RFC "Local and Self-Hosted Backend Modes" §20's suggested event types. */
export type ServerEventType =
  | "todo.created"
  | "todo.updated"
  | "todo.completed"
  | "todo.deleted"
  | "claim.acquired"
  | "claim.released"
  | "server.version";

export interface ServerEvent {
  id: string;
  type: ServerEventType;
  timestamp: string;
  deviceId: string | null;
  todoUuid: string | null;
  /** Only set for events with no natural todoUuid (currently just server.version, carrying the version string). */
  data?: unknown;
}

/** Every open GET /api/v1/events connection — module state, same shape as sseClients in web/server.ts. */
export const sseClients = new Set<ServerResponse>();

function writeEvent(client: ServerResponse, event: ServerEvent): void {
  try {
    client.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    sseClients.delete(client);
  }
}

/** Pushes one typed event to every open /api/v1/events connection. Called by routes.ts right after a mutation commits. */
export function broadcastServerEvent(type: ServerEventType, todoUuid: string | null, deviceId: string | null): void {
  const event: ServerEvent = { id: randomUUID(), type, timestamp: new Date().toISOString(), deviceId, todoUuid };
  for (const client of sseClients) writeEvent(client, event);
}

/** Sent to a single newly-connected client right away, so it doesn't have to wait for the next mutation to learn it's talking to a live, compatible server. */
export function sendServerVersionEvent(client: ServerResponse, serverVersion: string): void {
  writeEvent(client, { id: randomUUID(), type: "server.version", timestamp: new Date().toISOString(), deviceId: null, todoUuid: null, data: serverVersion });
}
