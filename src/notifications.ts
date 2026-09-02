/**
 * A short activity feed of pairing + viewer-access requests — both currently pending
 * ones and recently resolved/expired ones — so the host can see what it missed, not
 * just what's actionable right now. Ephemeral and in-memory, same as the pairing state
 * in sync.ts: this is a convenience log, not data worth persisting across a restart.
 */
export type NotificationKind = "pairing" | "access";
export type NotificationStatus = "pending" | "approved" | "denied" | "expired";

export interface NotificationEvent {
  id: string;
  kind: NotificationKind;
  label: string;
  status: NotificationStatus;
  createdAt: number;
  resolvedAt: number | null;
}

const MAX_EVENTS = 30;
const events: NotificationEvent[] = [];

export function recordCreated(id: string, kind: NotificationKind, label: string): void {
  events.unshift({ id, kind, label, status: "pending", createdAt: Date.now(), resolvedAt: null });
  events.length = Math.min(events.length, MAX_EVENTS);
}

export function recordResolved(id: string, status: "approved" | "denied"): void {
  const e = events.find((e) => e.id === id);
  if (e && e.status === "pending") {
    e.status = status;
    e.resolvedAt = Date.now();
  }
}

/**
 * Any event still marked "pending" whose id isn't among the live pending ids has fallen
 * out of sync.ts/access.ts's own TTL-reaped maps — the only way that happens is it expired
 * unanswered, so mark it that way lazily here rather than needing a hook into every reaper.
 */
export function listEvents(livePendingIds: ReadonlySet<string>): NotificationEvent[] {
  const now = Date.now();
  for (const e of events) {
    if (e.status === "pending" && !livePendingIds.has(e.id)) {
      e.status = "expired";
      e.resolvedAt = now;
    }
  }
  return events;
}
