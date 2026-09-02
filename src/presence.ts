import { formatAgentIdentity } from "./mutations.js";
import type { TodoStore } from "./types.js";

/** An entry more recent than this reads as "active"; older reads as "idle Nm/Nh". */
const ACTIVE_WINDOW_MS = 5 * 60_000;

export interface AgentPresence {
  agent: string | null;
  deviceName: string | null;
  identity: string;
  lastActiveAt: string;
  active: boolean;
}

/**
 * Derived entirely from existing history entries — no separate live-presence tracker to
 * keep in sync or leak state from. "Presence" here means "most recent thing this
 * agent@device did", which is enough for "active" / "idle 3m" without inventing a new
 * subsystem for something this lightweight.
 */
export function computeAgentPresence(store: TodoStore): AgentPresence[] {
  const latest = new Map<string, AgentPresence>();
  const now = Date.now();
  for (const todo of store.todos) {
    for (const h of todo.history ?? []) {
      if (h.action === "synced") continue; // an automatic merge record, not something an agent/human did
      const key = `${h.agent ?? ""}|${h.deviceName ?? ""}`;
      const existing = latest.get(key);
      if (existing && h.at <= existing.lastActiveAt) continue;
      latest.set(key, {
        agent: h.agent,
        deviceName: h.deviceName,
        identity: formatAgentIdentity(h.agent, h.deviceName),
        lastActiveAt: h.at,
        active: now - Date.parse(h.at) < ACTIVE_WINDOW_MS,
      });
    }
  }
  return [...latest.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}
