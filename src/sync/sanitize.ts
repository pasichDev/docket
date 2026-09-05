import { FIELD_KEYS, isSafeUrl } from "../mutations.js";
import type { Todo, Tombstone } from "../types.js";

/**
 * The boundary every byte from a peer crosses before it can reach the store.
 *
 * A peer is not a local caller: it is a remote process that may be running different code,
 * older code, or code an attacker chose. Nothing below trusts a type annotation — each
 * field is checked, clamped, or dropped, and unknown keys never survive.
 */

// Per-ITEM history cap, not a delivery limit: a genuine guard against a peer (buggy or
// hostile) stuffing an unbounded history array into one record. Delivery is bounded by
// PAGE_SIZE and the caller's page loop instead — see pullFromPeer.
const MAX_HISTORY_ENTRIES = 2000;

/** What a peer is allowed to hand us over the wire — reject anything else before it touches the store. */
function isPlausibleTodo(t: unknown): t is Todo {
  if (typeof t !== "object" || t === null) return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o.uuid === "string" &&
    typeof o.title === "string" &&
    typeof o.done === "boolean" &&
    (o.list === "todo" || o.list === "backlog") &&
    // Not merely strings: these two steer the merge resolver AND get arithmetic done on
    // them. mutations.ts computes `new Date(Date.parse(updatedAt) + 1).toISOString()` when
    // it has to step a timestamp forward, and an unparseable value there throws RangeError
    // on the next ordinary edit or delete — long after the sync that accepted it, with
    // nothing left to say where the bad value came from.
    isIsoTimestamp(o.createdAt) &&
    isIsoTimestamp(o.updatedAt) &&
    Array.isArray(o.history)
  );
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// Same safe-charset shape as every action string this codebase produces. The web UI renders
// history actions without HTML-escaping them, so anything outside this never enters the store.
const HISTORY_ACTION_RE = /^[a-z][a-z-]{0,31}$/;

function nullableString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Shape AND parse. The regex alone is not enough: "2026-13-45T99:99:99Z" has the right
 * shape and Date.parse still returns NaN for it, which is precisely the value that makes
 * the arithmetic in mutations.ts throw.
 */
function isIsoTimestamp(v: unknown): v is string {
  return typeof v === "string" && ISO_TIMESTAMP_RE.test(v) && Number.isFinite(Date.parse(v));
}

/**
 * For the optional timestamps. Same reasoning as the required ones in isPlausibleTodo, but
 * these do not justify rejecting the whole record: an unreadable completedAt costs a
 * "done at" label, while an unreadable updatedAt costs the merge its ordering.
 */
function isoOrNull(v: unknown): string | null {
  return isIsoTimestamp(v) ? v : null;
}

function sanitizeHistory(entries: unknown[]): Todo["history"] {
  const out: Todo["history"] = [];
  for (const e of entries.slice(0, MAX_HISTORY_ENTRIES)) {
    if (typeof e !== "object" || e === null) continue;
    const h = e as Record<string, unknown>;
    if (typeof h.at !== "string" || !ISO_TIMESTAMP_RE.test(h.at) || typeof h.detail !== "string") continue;
    if (typeof h.action !== "string" || !HISTORY_ACTION_RE.test(h.action)) continue;
    out.push({
      at: h.at,
      agent: nullableString(h.agent),
      deviceName: nullableString(h.deviceName),
      action: h.action as Todo["history"][number]["action"],
      detail: h.detail,
    });
  }
  return out;
}

function sanitizeFieldTimestamps(v: unknown): Todo["fieldTimestamps"] {
  if (typeof v !== "object" || v === null) return {};
  const out: Todo["fieldTimestamps"] = {};
  for (const key of FIELD_KEYS) {
    const val = (v as Record<string, unknown>)[key];
    // A per-field timestamp that cannot be parsed would win or lose merges arbitrarily
    // depending on how it string-compares. Dropping the entry falls back to updatedAt.
    if (isIsoTimestamp(val)) out[key] = val;
  }
  return out;
}

/**
 * isPlausibleTodo only guarantees the core identity fields. Everything else a peer sends
 * is clamped here field-by-field, because a buggy (or compromised) peer could otherwise
 * smuggle values the rest of the codebase never produces: wrong types that crash history
 * rendering, bogus enum values, an unsafe `javascript:` sourceUrl, or markup in fields the
 * web UI renders without escaping (dueDate, priority, history at/action). Also strips any
 * unknown extra keys so they can't silently persist and re-sync forever.
 */
function sanitizeRemoteTodo(t: Todo): Todo {
  const o = t as unknown as Record<string, unknown>;
  return {
    id: 0, // replaced with a fresh local id on insert; never merged onto an existing item
    uuid: t.uuid,
    title: t.title,
    description: nullableString(o.description),
    done: t.done,
    list: t.list,
    category: nullableString(o.category),
    priority: o.priority === "low" || o.priority === "medium" || o.priority === "high" ? o.priority : null,
    dueDate: typeof o.dueDate === "string" && DATE_ONLY_RE.test(o.dueDate) ? o.dueDate : null,
    sourceUrl: typeof o.sourceUrl === "string" && isSafeUrl(o.sourceUrl) ? o.sourceUrl : null,
    agent: nullableString(o.agent),
    session: nullableString(o.session),
    workspace: nullableString(o.workspace),
    workingAgent: nullableString(o.workingAgent),
    workingSince: isoOrNull(o.workingSince),
    workingSession: nullableString(o.workingSession),
    workingLeaseExpiresAt: isoOrNull(o.workingLeaseExpiresAt),
    workingDeviceId: nullableString(o.workingDeviceId),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    revision: typeof o.revision === "number" && Number.isInteger(o.revision) && o.revision > 0 ? o.revision : 1,
    fieldTimestamps: sanitizeFieldTimestamps(o.fieldTimestamps),
    completedAt: isoOrNull(o.completedAt),
    deviceId: nullableString(o.deviceId),
    deviceName: nullableString(o.deviceName),
    history: sanitizeHistory(t.history),
    // Deliberately NOT copied from the wire: a peer's sequence numbers are meaningless in
    // this store, and adopting one would put the record at an arbitrary point in our own
    // delivery order. mergeSyncPayload stamps it from our counter on the way in.
    localSeq: 0,
  };
}

/** Tombstones get the same treatment: only the exact expected shape enters the store. */
function sanitizeTombstone(t: unknown): Tombstone | null {
  if (typeof t !== "object" || t === null) return null;
  const o = t as Record<string, unknown>;
  if (typeof o.uuid !== "string" || typeof o.deletedAt !== "string") return null;
  return { uuid: o.uuid, deletedAt: o.deletedAt, deviceId: nullableString(o.deviceId), localSeq: 0 }; // localSeq re-stamped locally, same as todos
}

export { isPlausibleTodo, sanitizeRemoteTodo, sanitizeTombstone };
