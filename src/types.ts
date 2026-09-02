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
  createdAt: string;
  /** Bumped on every mutation. Used as the fallback conflict resolver for fields with no per-field timestamp (old data, or fields not covered by FIELD_KEYS in mutations.ts). */
  updatedAt: string;
  /** Per-field last-write-wins timestamps, keyed by field name (see FIELD_KEYS in mutations.ts). Lets two independent edits to DIFFERENT fields both survive a merge instead of one clobbering the other. Missing/partial on data from before this existed — those fields fall back to `updatedAt`. */
  fieldTimestamps: Partial<Record<string, string>>;
  completedAt: string | null;
  /** Which physical device this item was created on (see src/device.ts). Null for items from before device-sync existed. */
  deviceId: string | null;
  deviceName: string | null;
  /** Append-only audit log: every create/edit/claim/release/complete, by whom (agent, including "web" for manual UI edits). */
  history: HistoryEntry[];
}

/** A deletion, recorded so a paired device doesn't resurrect the item on next sync. Pruned after RETENTION (see sync.ts). */
export interface Tombstone {
  uuid: string;
  deletedAt: string;
  deviceId: string | null;
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
  lastSyncAt: string | null;
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
}
