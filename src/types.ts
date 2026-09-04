import type { HistoryEntry } from "./history.js";

export type TodoList = "todo" | "backlog";
export type TodoPriority = "low" | "medium" | "high";

export interface Todo {
  id: number;
  /** Globally-unique, immutable identity used to match the same item across paired devices. Local `id` is per-machine only. */
  uuid: string;
  title: string;
  description: string | null;
  done: boolean;
  list: TodoList;
  category: string | null;
  priority: TodoPriority | null;
  /** ISO date only, e.g. "2026-09-15" — no time component. */
  dueDate: string | null;
  /** Optional link back to where this item came from — a GitHub issue/PR, a Notion page, an Obsidian note, a Slack thread, anything with a URL. */
  sourceUrl: string | null;
  /** MCP client name self-reported at connect time (clientInfo.name), or "web" for the HTTP UI. */
  agent: string | null;
  /** Per-connection token — one per MCP server process run (roughly one host session). Not a claude.ai session URL; that isn't exposed over MCP. */
  session: string | null;
  /** Set by todo_claim: which agent is actively working on this right now. Advisory, not a lock. */
  workingAgent: string | null;
  workingSince: string | null;
  /** Set by todo_claim: the claiming connection's session token (see `session` above) — lets two claims from the same agent name but different host sessions be told apart in the display. */
  workingSession: string | null;
  /** Set by todo_claim: the claim auto-expires at this time unless renewed, so a claim from a device that vanished (crashed, offline for months) doesn't haunt the list forever. */
  workingLeaseExpiresAt: string | null;
  /** Set by todo_claim: the claiming device's id (see src/device.ts). Unlike `agent`/`session`, this is the one claim field a remote server can check against its own AUTHENTICATED caller identity (context.deviceId) rather than a self-reported header — see repository.ts's claim() requireFree check. */
  workingDeviceId: string | null;
  createdAt: string;
  /** Bumped on every mutation. Used as the fallback conflict resolver for fields with no per-field timestamp (old data, or fields not covered by FIELD_KEYS in mutations.ts). */
  updatedAt: string;
  /** Per-field last-write-wins timestamps, keyed by field name (see FIELD_KEYS in mutations.ts). Lets two independent edits to DIFFERENT fields both survive a merge instead of one clobbering the other. Missing/partial on data from before this existed — those fields fall back to `updatedAt`. */
  fieldTimestamps: Partial<Record<string, string>>;
  completedAt: string | null;
  /** Bumped on every mutation (see touch() in mutations.ts). Optimistic-concurrency counter — a future remote server uses it for If-Match/409 checks; local mode doesn't check it against anything yet. Legacy items default to 1 on migration (see storage.ts). */
  revision: number;
  /** Which physical device this item was created on (see src/device.ts). Null for items from before device-sync existed. */
  deviceId: string | null;
  deviceName: string | null;
  /** Append-only audit log: every create/edit/claim/release/complete, by whom (agent, including "web" for manual UI edits). */
  history: HistoryEntry[];
  /** Monotonic per-device counter, bumped on EVERY local write to this record — including
   *  accepting a peer's change during merge. This is the delivery cursor; `updatedAt` is the
   *  merge resolver. Never mix the two: `updatedAt` describes when the AUTHOR changed the
   *  record and travels between devices, so a merged record lands in the past and slips
   *  underneath a third peer's cursor. `localSeq` is meaningful only in the store that
   *  assigned it and is re-stamped on arrival, never copied off the wire. */
  localSeq: number;
  /** Which project/context this item belongs to (see src/workspace.ts). A stable slug,
   *  resolved from the git remote where possible so the same repo cloned to different paths
   *  on two machines lands in ONE workspace — which only matters because sync exists.
   *  Null for pre-v8 items and for anything created with no project context (a bare
   *  Claude Desktop session, say); nulls stay visible rather than being guessed at. */
  workspace: string | null;
}

/** A deletion, recorded so a paired device doesn't resurrect the item on next sync. Kept indefinitely, never purged by age — see the note at the end of mergeSyncPayload in sync.ts for why age-based GC would resurrect deletions. */
export interface Tombstone {
  uuid: string;
  deletedAt: string;
  deviceId: string | null;
  /** Same delivery cursor as Todo.localSeq — tombstones page off the same sequence space,
   *  so a deletion can't be skipped by a cursor that advanced past it. */
  localSeq: number;
}

/**
 * A device this instance has paired with. `secret` authenticates AND encrypts sync
 * traffic (HMAC signing + AES-256-GCM) — it is never transmitted: both sides derive
 * the identical value independently via X25519 ECDH on the public keys exchanged
 * during pairing (see device.ts / sync.ts), then HKDF. Never logged.
 */
export interface Peer {
  id: string;
  name: string;
  url: string;
  secret: string;
  pairedAt: string;
  /** Display only ("last synced 4m ago") since v3.0 — NOT a cursor. Delivery is tracked by
   *  `lastSeq` below; a wall-clock cursor is what made a third device's edits vanish. */
  lastSyncAt: string | null;
  /** How far into this peer's OWN localSeq space we have merged. Advances only to what was
   *  actually merged, never to "wherever the peer is now". Absent on peers paired before v3.0
   *  and on peers still speaking sync protocol v1, both treated as 0 (full re-sync). */
  lastSeq?: number;
  /** Which incarnation of the peer's store `lastSeq` counts in. When the peer reports a
   *  different one — it restored a backup, so its counter went backwards — the cursor is
   *  meaningless and resets to 0. Absent until the first sync with a v3.0 peer. */
  epoch?: string;
  lastSyncOk: boolean;
  /** Explicitly blocks sync without losing the pairing/secret — see peers.ts revokePeer/restorePeer. Absent on records from before this field existed, treated as false. */
  revoked?: boolean;
  /** The last sync protocol version this peer reported (see sync.ts SYNC_PROTOCOL_VERSION); null until the first successful sync. */
  protocolVersion?: number | null;
  /** Reason the most recent sync attempt failed, or null if it succeeded (or none has run yet). */
  lastError?: string | null;
  /** peer's reported clock minus ours, at the most recent sync — a large value is worth surfacing, see peerTrustState() in peers.ts. */
  clockSkewMs?: number | null;
  /** The peer's X25519 public key, as verified at pairing time — public by design, safe to display. Used only to derive a human-checkable fingerprint (see peerFingerprint() in peers.ts); never used to re-derive the secret. Absent on peers paired before this field existed. */
  publicKeyX?: string;
}

export interface TodoStore {
  /** Data shape version. Missing/0 means pre-versioning data. A file version newer than
   * the running code understands is a hard error, not a silent guess. */
  formatVersion: number;
  nextId: number;
  todos: Todo[];
  /** Deletions from this device or merged in from a peer, for tombstone-based sync. */
  deletedUuids: Tombstone[];
  /** High-water mark for `localSeq` on this device. Never decreases, never resets — a peer's
   *  cursor into this store is a number from this counter, so reusing one would silently
   *  hide the record that got the duplicate. */
  seqCounter: number;
}
