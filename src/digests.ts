import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decryptFromBuffer, encryptToBuffer } from "./crypto.js";
import { dataPath } from "./data-dir.js";
import { isSafeUrl, shortId } from "./mutations.js";
import { withRegistry } from "./registry.js";
import type { Tombstone } from "./types.js";
import { uuidv7 } from "./uuid7.js";

/**
 * Digests: a snapshot an agent writes after reading the user's tickets, merge requests and
 * pull requests, so the dashboard can show "what is going on" without the server ever
 * holding a Notion or GitHub credential. The agent does the reading; Docket only keeps the
 * result and carries it to every paired device.
 *
 * Kept in its own file, with its own sequence counter, rather than inside todos.json.enc:
 *
 *  - The todo store is rewritten, whole, on every edit. A year of daily digests is
 *    megabytes, and every checkbox click would pay to re-encrypt them.
 *  - Its own sequence space means its own sync cursor. A peer running a build that has
 *    never heard of digests cannot move a cursor it does not have, so when that peer is
 *    upgraded it starts from 0 and receives every digest. Sharing the todo counter would
 *    have let an old peer step its cursor straight over digest records it ignored — the
 *    same silent, permanent gap protocol v2 was built to close.
 *  - The todo store's format stays at v8, so nothing about downgrading changes.
 *
 * A digest is immutable once published: it records what was true when the agent looked.
 * That makes the merge a set union by uuid plus deletions — there are no field conflicts
 * to resolve, because nobody edits one.
 */

const DIGESTS_PATH = await dataPath("digests.json.enc");
const LOCK_PATH = `${DIGESTS_PATH}.lock`;

export const DIGEST_FORMAT_VERSION = 1;

export const DIGEST_ITEM_KINDS = ["pr", "mr", "issue", "ticket", "commit", "release", "todo", "doc", "note"] as const;
export type DigestItemKind = (typeof DIGEST_ITEM_KINDS)[number];

export const DIGEST_TONES = ["good", "warn", "bad", "info", "neutral"] as const;
export type DigestTone = (typeof DIGEST_TONES)[number];

export interface DigestItem {
  kind: DigestItemKind;
  title: string;
  url: string | null;
  /** The handle a human recognises: "!154", "#12", "VPQ-680", "v3.0.1". */
  ref: string | null;
  repo: string | null;
  /** As the source names it: "merged", "In review", "Blocked". */
  status: string | null;
  tone: DigestTone | null;
  /** The user has to do something about this one — review it, unblock it, answer it. */
  attention: boolean;
  /** One line of the agent's own judgement: why it matters, what changed. */
  note: string | null;
  updatedAt: string | null;
}

export interface DigestSection {
  title: string;
  items: DigestItem[];
}

export interface DigestMetric {
  label: string;
  value: string;
  tone: DigestTone | null;
}

export interface DigestSource {
  name: string;
  ok: boolean;
  /** What was read ("12 MRs in vploq/*"), or why it could not be. */
  detail: string | null;
}

export interface Digest {
  uuid: string;
  title: string;
  /** Markdown. The paragraph a human reads first. */
  summary: string;
  highlights: string[];
  metrics: DigestMetric[];
  sections: DigestSection[];
  sources: DigestSource[];
  /** The period the agent looked at. ISO date or timestamp; null when it did not say. */
  windowFrom: string | null;
  windowTo: string | null;
  workspace: string | null;
  agent: string | null;
  deviceId: string | null;
  deviceName: string | null;
  createdAt: string;
  /** Delivery cursor, in THIS file's sequence space — see the note at the top. */
  localSeq: number;
}

export interface DigestStore {
  formatVersion: number;
  /** This file's incarnation, minted on its first write. See digestPageEpoch in sync/digests.ts. */
  epoch?: string;
  seqCounter: number;
  digests: Digest[];
  deleted: Tombstone[];
}

/**
 * Bounds on one digest. The publish path rejects anything over them so the agent hears
 * why; the sync path clamps instead, because a peer's record that is merely long is still
 * worth having.
 */
export const DIGEST_LIMITS = {
  title: 200,
  summary: 12_000,
  highlights: 12,
  highlight: 400,
  metrics: 8,
  metricLabel: 60,
  metricValue: 40,
  sections: 16,
  sectionTitle: 120,
  items: 300,
  itemTitle: 300,
  itemNote: 600,
  ref: 60,
  repo: 120,
  status: 60,
  sources: 16,
  sourceName: 60,
  sourceDetail: 300,
  url: 2048,
} as const;

/** What an agent hands to digest_publish: the content, without identity or provenance. */
export interface DigestInput {
  title: string;
  summary: string;
  highlights?: string[];
  metrics?: Array<{ label: string; value: string; tone?: DigestTone | null }>;
  sections?: Array<{
    title: string;
    items: Array<{
      kind: DigestItemKind;
      title: string;
      url?: string | null;
      ref?: string | null;
      repo?: string | null;
      status?: string | null;
      tone?: DigestTone | null;
      attention?: boolean;
      note?: string | null;
      updatedAt?: string | null;
    }>;
  }>;
  sources?: Array<{ name: string; ok: boolean; detail?: string | null }>;
  windowFrom?: string | null;
  windowTo?: string | null;
}

export interface DigestContext {
  agent: string | null;
  deviceId: string;
  deviceName: string;
  workspace: string | null;
}

export class DigestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigestValidationError";
  }
}

/** "D-7K2F9A" — the same hash as a todo's short id, under its own prefix so the two can never be confused. */
export function digestShortId(uuid: string): string {
  return `D-${shortId(uuid).slice(2)}`;
}

/** Items across all sections that ask something of the user. */
export function attentionCount(digest: Pick<Digest, "sections">): number {
  return digest.sections.reduce((n, s) => n + s.items.filter((i) => i.attention).length, 0);
}

export function itemCount(digest: Pick<Digest, "sections">): number {
  return digest.sections.reduce((n, s) => n + s.items.length, 0);
}

// ---- Validation ------------------------------------------------------------------------

const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isIsoish(v: unknown): v is string {
  return typeof v === "string" && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
}

type Mode = "strict" | "lenient";

/**
 * One shape check for both directions. `strict` (publish) throws on the first violation,
 * naming it, so the agent can fix its call; `lenient` (sync) truncates text and drops
 * what does not fit, and only reports failure for a record that is not a digest at all.
 */
function text(v: unknown, max: number, field: string, mode: Mode, required: true): string;
function text(v: unknown, max: number, field: string, mode: Mode, required?: false): string | null;
function text(v: unknown, max: number, field: string, mode: Mode, required = false): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw new DigestValidationError(`${field} is required`);
    return null;
  }
  if (typeof v !== "string") {
    // A peer on a newer build may send a shape this one doesn't know. Drop the field, keep
    // the digest — one odd value must not hold the whole cursor back for good.
    if (mode === "lenient") {
      if (typeof v === "number" && Number.isFinite(v)) return text(String(v), max, field, mode, required as false);
      if (required) throw new DigestValidationError(`${field} is required`);
      return null;
    }
    throw new DigestValidationError(`${field} must be a string`);
  }
  const trimmed = v.trim();
  if (required && !trimmed) throw new DigestValidationError(`${field} is required`);
  if (trimmed.length > max) {
    if (mode === "strict") throw new DigestValidationError(`${field} is ${trimmed.length} characters; the limit is ${max}`);
    return trimmed.slice(0, max);
  }
  return trimmed || null;
}

function list<T>(v: unknown, max: number, field: string, mode: Mode): T[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    if (mode === "lenient") return [];
    throw new DigestValidationError(`${field} must be an array`);
  }
  if (v.length > max) {
    if (mode === "strict") throw new DigestValidationError(`${field} has ${v.length} entries; the limit is ${max}`);
    return v.slice(0, max) as T[];
  }
  return v as T[];
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string, mode: Mode, fallback: T | null): T | null {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  if (mode === "strict") throw new DigestValidationError(`${field} must be one of ${allowed.join(", ")}`);
  return fallback;
}

/**
 * http(s) only: these become hrefs on the dashboard, and a javascript: URL is a stored XSS
 * that HTML escaping does nothing about. On the sync path a bad link is dropped rather than
 * the whole record — the item is still worth reading without it.
 */
function url(v: unknown, field: string, mode: Mode): string | null {
  const value = text(v, DIGEST_LIMITS.url, field, mode);
  if (value === null) return null;
  if (isSafeUrl(value)) return value;
  if (mode === "strict") throw new DigestValidationError(`${field} must be an http:// or https:// URL`);
  return null;
}

function when(v: unknown, field: string, mode: Mode): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (isIsoish(v)) return v;
  if (mode === "strict") throw new DigestValidationError(`${field} must be an ISO date (YYYY-MM-DD) or timestamp`);
  return null;
}

/**
 * `list().map()`, except that in lenient mode one malformed entry is dropped instead of
 * failing the record. Strict mode still throws, naming the entry, so the agent can fix it.
 */
function each<T, R>(values: T[], mode: Mode, fn: (value: T, index: number) => R): R[] {
  const out: R[] = [];
  values.forEach((value, index) => {
    try {
      out.push(fn(value, index));
    } catch (err) {
      if (mode === "lenient" && err instanceof DigestValidationError) return;
      throw err;
    }
  });
  return out;
}

type Body = Pick<Digest, "title" | "summary" | "highlights" | "metrics" | "sections" | "sources" | "windowFrom" | "windowTo">;

function normalizeBody(raw: unknown, mode: Mode): Body {
  if (!raw || typeof raw !== "object") throw new DigestValidationError("a digest must be an object");
  const r = raw as Record<string, unknown>;
  const L = DIGEST_LIMITS;

  const sections = each(list<Record<string, unknown>>(r.sections, L.sections, "sections", mode), mode, (s, si) => {
    if (!s || typeof s !== "object") throw new DigestValidationError(`sections[${si}] must be an object`);
    return {
      title: text(s.title, L.sectionTitle, `sections[${si}].title`, mode, true),
      items: each(list<Record<string, unknown>>(s.items, L.items, `sections[${si}].items`, mode), mode, (i, ii) => {
        const at = `sections[${si}].items[${ii}]`;
        if (!i || typeof i !== "object") throw new DigestValidationError(`${at} must be an object`);
        return {
          kind: oneOf(i.kind, DIGEST_ITEM_KINDS, `${at}.kind`, mode, "note") as DigestItemKind,
          title: text(i.title, L.itemTitle, `${at}.title`, mode, true),
          url: url(i.url, `${at}.url`, mode),
          ref: text(i.ref, L.ref, `${at}.ref`, mode),
          repo: text(i.repo, L.repo, `${at}.repo`, mode),
          status: text(i.status, L.status, `${at}.status`, mode),
          tone: oneOf(i.tone, DIGEST_TONES, `${at}.tone`, mode, null),
          attention: i.attention === true,
          note: text(i.note, L.itemNote, `${at}.note`, mode),
          updatedAt: when(i.updatedAt, `${at}.updatedAt`, mode),
        };
      }),
    };
  });

  // The item cap is across the whole digest, not per section: it bounds the record.
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  if (total > L.items) {
    if (mode === "strict") throw new DigestValidationError(`the digest has ${total} items; the limit is ${L.items} across all sections`);
    let budget = L.items;
    for (const s of sections) {
      s.items = s.items.slice(0, Math.max(0, budget));
      budget -= s.items.length;
    }
  }

  return {
    title: text(r.title, L.title, "title", mode, true),
    summary: text(r.summary, L.summary, "summary", mode) ?? "",
    highlights: each(list<unknown>(r.highlights, L.highlights, "highlights", mode), mode, (h, i) => text(h, L.highlight, `highlights[${i}]`, mode))
      .filter((h): h is string => h !== null),
    metrics: each(list<Record<string, unknown>>(r.metrics, L.metrics, "metrics", mode), mode, (m, i) => {
      if (!m || typeof m !== "object") throw new DigestValidationError(`metrics[${i}] must be an object`);
      return {
        label: text(m.label, L.metricLabel, `metrics[${i}].label`, mode, true),
        // Numbers are what agents naturally send here; a metric is displayed, never computed with.
        value: text(typeof m.value === "number" ? String(m.value) : m.value, L.metricValue, `metrics[${i}].value`, mode, true),
        tone: oneOf(m.tone, DIGEST_TONES, `metrics[${i}].tone`, mode, null),
      };
    }),
    sections,
    sources: each(list<Record<string, unknown>>(r.sources, L.sources, "sources", mode), mode, (s, i) => {
      if (!s || typeof s !== "object") throw new DigestValidationError(`sources[${i}] must be an object`);
      return {
        name: text(s.name, L.sourceName, `sources[${i}].name`, mode, true),
        ok: s.ok !== false,
        detail: text(s.detail, L.sourceDetail, `sources[${i}].detail`, mode),
      };
    }),
    windowFrom: when(r.windowFrom, "windowFrom", mode),
    windowTo: when(r.windowTo, "windowTo", mode),
  };
}

/** Validates an agent's digest, throwing a DigestValidationError that names the first problem. */
export function validateDigestInput(raw: unknown): Body {
  return normalizeBody(raw, "strict");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A digest as it arrives from a peer, made safe to store and render — or null when it is
 * not a digest at all. Identity and provenance fields are checked for shape only; a peer
 * is authenticated, but its records are still input.
 */
export function sanitizeRemoteDigest(raw: unknown): Digest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.uuid !== "string" || !UUID_RE.test(r.uuid)) return null;
  if (!isIsoish(r.createdAt)) return null;
  let body: Body;
  try {
    body = normalizeBody(raw, "lenient");
  } catch {
    return null;
  }
  const short = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  return {
    uuid: r.uuid.toLowerCase(),
    ...body,
    workspace: short(r.workspace),
    agent: short(r.agent, 120),
    deviceId: short(r.deviceId, 120),
    deviceName: short(r.deviceName, 120),
    createdAt: r.createdAt,
    localSeq: 0, // re-stamped on arrival; a peer's number means nothing in this file
  };
}

function sanitizeDigestTombstone(raw: unknown): Tombstone | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.uuid !== "string" || !UUID_RE.test(r.uuid)) return null;
  if (!isIsoish(r.deletedAt)) return null;
  return { uuid: r.uuid.toLowerCase(), deletedAt: r.deletedAt, deviceId: typeof r.deviceId === "string" ? r.deviceId.slice(0, 120) : null, localSeq: 0 };
}

// ---- Storage ---------------------------------------------------------------------------

function emptyStore(): DigestStore {
  return { formatVersion: DIGEST_FORMAT_VERSION, seqCounter: 0, digests: [], deleted: [] };
}

export async function readDigestStore(): Promise<DigestStore> {
  let encrypted: Buffer;
  try {
    encrypted = await readFile(DIGESTS_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw err;
  }
  const parsed = JSON.parse(await decryptFromBuffer(encrypted)) as Partial<DigestStore>;
  if ((parsed.formatVersion ?? 0) > DIGEST_FORMAT_VERSION) {
    // Same rule as the todo store: refuse to read a newer shape rather than guess at it,
    // because the next write would strip whatever this build does not know about.
    throw new Error(
      `docket: digests.json.enc is format v${parsed.formatVersion}, this process only understands v${DIGEST_FORMAT_VERSION} — it is running stale code. Update docket and restart it.`,
    );
  }
  return {
    formatVersion: DIGEST_FORMAT_VERSION,
    epoch: parsed.epoch,
    seqCounter: parsed.seqCounter ?? 0,
    digests: parsed.digests ?? [],
    deleted: parsed.deleted ?? [],
  };
}

/** Locked read-modify-write with the same lease and content fencing as every other registry. */
export function withDigestStore<R>(fn: (store: DigestStore) => R | Promise<R>): Promise<R> {
  return withRegistry(
    {
      path: DIGESTS_PATH,
      lockPath: LOCK_PATH,
      name: "the digest store",
      load: async () => {
        const store = await readDigestStore();
        // Minted here, inside the lock, so exactly one writer ever chooses it.
        store.epoch ??= randomUUID();
        return store;
      },
      serialize: (store) => encryptToBuffer(JSON.stringify(store)),
    },
    fn,
  );
}

function stamp(store: DigestStore, rec: { localSeq: number }): void {
  store.seqCounter += 1;
  rec.localSeq = store.seqCounter;
}

/** By uuid, or by the D- short id (case-insensitive, prefix optional). */
export function findDigest(store: DigestStore, id: string): Digest | undefined {
  const raw = id.trim();
  if (UUID_RE.test(raw)) return store.digests.find((d) => d.uuid === raw.toLowerCase());
  const normalized = raw.toUpperCase();
  const wanted = normalized.startsWith("D-") ? normalized : `D-${normalized}`;
  const matches = store.digests.filter((d) => digestShortId(d.uuid) === wanted);
  // A collision is possible, if unlikely: refuse to pick one, exactly as todos do.
  if (matches.length > 1) {
    throw new DigestValidationError(`"${wanted}" matches ${matches.length} digests — use the full uuid: ${matches.map((d) => d.uuid).join(", ")}`);
  }
  return matches[0];
}

/** Newest first. */
export function sortDigests(digests: readonly Digest[]): Digest[] {
  return [...digests].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.uuid.localeCompare(a.uuid));
}

export function createDigest(store: DigestStore, input: unknown, ctx: DigestContext): Digest {
  const body = validateDigestInput(input);
  const digest: Digest = {
    uuid: uuidv7(),
    ...body,
    workspace: ctx.workspace,
    agent: ctx.agent,
    deviceId: ctx.deviceId,
    deviceName: ctx.deviceName,
    createdAt: new Date().toISOString(),
    localSeq: 0,
  };
  stamp(store, digest);
  store.digests.push(digest);
  return digest;
}

export function deleteDigestRecord(store: DigestStore, digest: Digest, deviceId: string | null): void {
  store.digests = store.digests.filter((d) => d.uuid !== digest.uuid);
  const tomb: Tombstone = { uuid: digest.uuid, deletedAt: new Date().toISOString(), deviceId, localSeq: 0 };
  stamp(store, tomb);
  store.deleted.push(tomb);
}

export async function publishDigest(input: unknown, ctx: DigestContext): Promise<Digest> {
  // Validated before the lock as well as inside it, so a bad call costs no lock round trip.
  validateDigestInput(input);
  return withDigestStore((store) => createDigest(store, input, ctx));
}

export async function listDigests(limit = 30): Promise<{ digests: Digest[]; total: number }> {
  const store = await readDigestStore();
  return { digests: sortDigests(store.digests).slice(0, limit), total: store.digests.length };
}

export async function getDigest(id: string): Promise<Digest | null> {
  return findDigest(await readDigestStore(), id) ?? null;
}

export async function deleteDigest(id: string, deviceId: string | null): Promise<Digest | null> {
  return withDigestStore((store) => {
    const found = findDigest(store, id);
    if (!found) return null;
    deleteDigestRecord(store, found, deviceId);
    return found;
  });
}

// ---- Sync ------------------------------------------------------------------------------

/** Digests are larger than todos, so a page holds fewer of them. A tuning knob, not a limit. */
export const DIGEST_PAGE_SIZE = 50;
const MAX_INCOMING_DIGESTS = 1_000;

export interface DigestSyncPage {
  digests: Digest[];
  deleted: Tombstone[];
  maxSeq: number;
  hasMore: boolean;
  epoch?: string;
  serverTime: string;
}

/**
 * One page of what a peer is owed, by this file's sequence numbers. The same promise rule
 * as buildSyncPayload: when either stream is truncated, `maxSeq` stops at that stream's
 * last row, so the caller never steps over a record the other stream still owes.
 */
export function buildDigestPage(store: DigestStore, sinceSeq: number, epoch?: string): DigestSyncPage {
  const bySeq = (a: { localSeq: number }, b: { localSeq: number }) => a.localSeq - b.localSeq;
  const digestCandidates = store.digests.filter((d) => d.localSeq > sinceSeq).sort(bySeq);
  const tombCandidates = store.deleted.filter((t) => t.localSeq > sinceSeq).sort(bySeq);
  const digests = digestCandidates.slice(0, DIGEST_PAGE_SIZE);
  const deleted = tombCandidates.slice(0, DIGEST_PAGE_SIZE);
  const digestsTruncated = digestCandidates.length > DIGEST_PAGE_SIZE;
  const tombsTruncated = tombCandidates.length > DIGEST_PAGE_SIZE;
  const ceiling = (page: Array<{ localSeq: number }>, truncated: boolean) => (truncated ? page[page.length - 1].localSeq : store.seqCounter);
  return {
    digests,
    deleted,
    maxSeq: Math.max(sinceSeq, Math.min(ceiling(digests, digestsTruncated), ceiling(deleted, tombsTruncated))),
    hasMore: digestsTruncated || tombsTruncated,
    epoch,
    serverTime: new Date().toISOString(),
  };
}

/**
 * Merges one page into the local file. Every record accepted is re-stamped with a local
 * sequence number — that is what hands it on to a third device whose cursor into THIS
 * device is already past the number the record had where it came from.
 *
 * A deletion always wins: a digest is never edited, so there is no newer version of it
 * that a deletion could be older than.
 */
export function mergeDigestPage(store: DigestStore, page: Partial<DigestSyncPage>): { inserted: number; deleted: number; rejectedBelow: number | null } {
  let inserted = 0;
  let deleted = 0;
  let rejectedBelow: number | null = null;
  const noteRejected = (record: unknown): void => {
    const seq = (record as { localSeq?: unknown } | null)?.localSeq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return;
    if (rejectedBelow === null || seq < rejectedBelow) rejectedBelow = seq;
  };

  const tombs = new Map(store.deleted.map((t) => [t.uuid, t]));
  const present = new Set(store.digests.map((d) => d.uuid));

  const rawTombs = Array.isArray(page.deleted) ? page.deleted.slice(0, MAX_INCOMING_DIGESTS) : [];
  for (const raw of rawTombs) {
    const clean = sanitizeDigestTombstone(raw);
    if (!clean) {
      noteRejected(raw);
      continue;
    }
    if (tombs.has(clean.uuid)) continue;
    stamp(store, clean);
    store.deleted.push(clean);
    tombs.set(clean.uuid, clean);
    if (present.delete(clean.uuid)) deleted += 1;
  }
  if (deleted > 0) store.digests = store.digests.filter((d) => present.has(d.uuid));

  const rawDigests = Array.isArray(page.digests) ? page.digests.slice(0, MAX_INCOMING_DIGESTS) : [];
  for (const raw of rawDigests) {
    const clean = sanitizeRemoteDigest(raw);
    if (!clean) {
      noteRejected(raw);
      continue;
    }
    if (tombs.has(clean.uuid) || present.has(clean.uuid)) continue;
    stamp(store, clean);
    store.digests.push(clean);
    present.add(clean.uuid);
    inserted += 1;
  }
  return { inserted, deleted, rejectedBelow };
}

const isSeq = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The cursor rules of cursorAfterPage (sync/payload.ts), applied to a digest page. */
export function digestCursorAfterPage(page: Partial<DigestSyncPage>, current: number, rejectedBelow: number | null): number {
  if (!isSeq(page.maxSeq)) throw new Error(`peer sent digest maxSeq ${JSON.stringify(page.maxSeq)}, which is not a sequence number`);
  const delivered: number[] = [];
  for (const record of [...(page.digests ?? []), ...(page.deleted ?? [])]) {
    const seq = (record as { localSeq?: unknown } | null)?.localSeq;
    if (isSeq(seq)) delivered.push(seq);
  }
  let promised = delivered.length > 0 ? Math.min(page.maxSeq, Math.max(...delivered)) : page.maxSeq;
  if (rejectedBelow !== null) promised = Math.min(promised, rejectedBelow - 1);
  return Math.max(current, promised);
}

// ---- Text, for the MCP tools -----------------------------------------------------------

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "?");

/** One line: `D-7K2F9A  2026-10-04  Daily digest  · 14 items · 3 need you  ← claude-code@mac`. */
export function formatDigestLine(d: Digest): string {
  const need = attentionCount(d);
  const n = itemCount(d);
  const parts = [n === 1 ? "1 item" : `${n} items`, need ? `${need} need you` : null, d.workspace ? `@${d.workspace}` : null].filter(Boolean);
  const who = [d.agent, d.deviceName].filter(Boolean).join("@");
  return `${digestShortId(d.uuid)}  ${day(d.createdAt)}  ${d.title}  · ${parts.join(" · ")}${who ? `  ← ${who}` : ""}`;
}

/** The whole digest as plain text — what an agent reads to say what changed since last time. */
export function formatDigest(d: Digest): string {
  const out: string[] = [formatDigestLine(d)];
  if (d.windowFrom || d.windowTo) out.push(`window: ${day(d.windowFrom)} → ${day(d.windowTo)}`);
  if (d.summary) out.push("", d.summary);
  if (d.highlights.length) out.push("", ...d.highlights.map((h) => `• ${h}`));
  if (d.metrics.length) out.push("", d.metrics.map((m) => `${m.label}: ${m.value}`).join(" | "));
  for (const s of d.sections) {
    out.push("", `## ${s.title}`);
    for (const i of s.items) {
      const head = [i.attention ? "!" : "-", `[${i.kind}]`, i.ref, i.title, i.status ? `(${i.status})` : null, i.repo ? `— ${i.repo}` : null].filter(Boolean).join(" ");
      out.push(head + (i.url ? `  ${i.url}` : ""));
      if (i.note) out.push(`    ${i.note}`);
    }
  }
  if (d.sources.length) out.push("", `sources: ${d.sources.map((s) => `${s.name} ${s.ok ? "ok" : "FAILED"}${s.detail ? ` (${s.detail})` : ""}`).join("; ")}`);
  return out.join("\n");
}
