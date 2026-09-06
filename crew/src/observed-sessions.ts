import { resolve, sep } from "node:path";
import { listDocketSessions, type DocketSession } from "./docket.js";
import type { Orchestrator } from "./orchestrator.js";
import { listDescendantPids } from "./supervisor.js";

/**
 * "See the whole room" — the discovery half of spec §17.
 *
 * The safety half already existed (observed agents are refused by every control path). What
 * was missing is the thing that makes the Office's window ever show anything: something that
 * actually LOOKS at the Docket MCP sessions running on this machine and mirrors them into
 * Crew state as `CrewAgent{origin:"observed"}`.
 *
 * Three properties this file exists to guarantee:
 *
 *  1. It is a MIRROR, not a ledger. Every tick reconciles the whole set — a session that is
 *     gone is deleted, never left as a ghost that outlives its process.
 *  2. It never mistakes one of Crew's OWN workers for a bystander. A spawned worker also talks
 *     to Docket and therefore also appears in that registry; counting it twice would put every
 *     managed agent on the board AND on the glass. See CrewOwnedSessions.
 *  3. It fails quiet and INERT. If Docket cannot be read at all, the tick makes no change
 *     rather than clearing the window — "cannot tell" is not "nobody there".
 */

/** How often the daemon reconciles. Docket's own heartbeat debounce is 20s, so a few seconds is already finer-grained than the data can change. */
export const DEFAULT_OBSERVE_INTERVAL_MS = 5_000;

/** Namespaced so an observed id can never collide with a spawned agent's 8-hex-char uuid slice. */
export const OBSERVED_ID_PREFIX = "docket:";

export function observedAgentId(sessionToken: string): string {
  return `${OBSERVED_ID_PREFIX}${sessionToken}`;
}

/**
 * What the ghost is called on the glass: the host that introduced itself, plus where it is
 * working. `agent` is null until the MCP client sends `initialize`, and `workspace` is a slug
 * like "github.com/pasichdev/docket" — too long for a name tag, so only its last segment is
 * used, falling back to the cwd's basename.
 */
export function observedAgentName(session: DocketSession): string {
  const host = session.agent?.trim() || "docket session";
  const slug = session.workspace?.trim();
  const where = (slug || session.cwd || "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  return where ? `${host} (${where})` : host;
}

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

export interface CrewOwnedOptions {
  /** The crew daemon's own pid; every runtime it spawns is a descendant of this. */
  rootPid?: number;
  /** paths.worktreesDir — nothing but a Crew-isolated assignment ever runs in there. */
  worktreesDir?: string;
  /** Injected for tests; defaults to the supervisor's pgrep walk. */
  descendants?: (rootPid: number) => Promise<number[]>;
}

export interface SessionPartition {
  /** Sessions that belong to somebody else — these become ghosts. */
  observed: DocketSession[];
  /** Sessions Crew itself is responsible for — these are already on the board as managed agents. */
  owned: DocketSession[];
}

/**
 * The managed-vs-observed discriminator.
 *
 * Nothing in a session record distinguishes the two on its face: a Crew-spawned `claude`
 * reports the same `agent: "claude-code"` as the human's own terminal, and a non-isolated
 * assignment runs in the same cwd. The one thing that IS structurally true is process
 * ancestry — Crew's runtime children, and therefore the Docket MCP servers those children
 * spawn, are descendants of the crew daemon, and a session the human started is not. So:
 *
 *   1. pid is the daemon itself, or a descendant of it  → Crew's.
 *   2. cwd is inside the crew worktrees directory       → Crew's. A second, independent
 *      signal, because the pgrep walk in (1) degrades to "no children found" on a machine
 *      without pgrep, and the failure mode of getting this wrong is double-counting.
 *   3. once Crew's, always Crew's, for as long as the session lives. A runtime that leaks its
 *      MCP server past the turn gets reparented away from the daemon; without this it would
 *      flip into a ghost the moment it was orphaned. Session tokens are unique per MCP
 *      process run, so a dead token can never come back — the memo is pruned to the live set
 *      each pass and cannot grow without bound.
 */
export class CrewOwnedSessions {
  private known = new Set<string>();

  constructor(private readonly opts: CrewOwnedOptions = {}) {}

  private get rootPid(): number {
    return this.opts.rootPid ?? process.pid;
  }

  async partition(sessions: DocketSession[]): Promise<SessionPartition> {
    const observed: DocketSession[] = [];
    const owned: DocketSession[] = [];
    // Computed at most once per pass, and only if a session actually needs deciding. When the
    // daemon has no children this is a single `pgrep -P <pid>` that exits 1 immediately.
    let descendants: Set<number> | null = null;
    const isDescendant = async (pid: number): Promise<boolean> => {
      descendants ??= new Set(await (this.opts.descendants ?? listDescendantPids)(this.rootPid));
      return descendants.has(pid);
    };

    for (const session of sessions) {
      const mine =
        this.known.has(session.session) ||
        session.pid === this.rootPid ||
        (this.opts.worktreesDir !== undefined && session.cwd !== undefined && isInside(session.cwd, this.opts.worktreesDir)) ||
        (await isDescendant(session.pid));
      if (mine) owned.push(session);
      else observed.push(session);
    }

    this.known = new Set(owned.map((s) => s.session));
    return { observed, owned };
  }
}

export interface ObservedTick {
  /** Ids of ghosts that were not in state before this pass. */
  appeared: string[];
  /** Ids of ghosts whose session is gone and whose record was deleted. */
  disappeared: string[];
  /** Ids of every observed agent in state after this pass. */
  observed: string[];
  /** Sessions recognised as Crew's own and deliberately NOT mirrored. */
  ownedByCrew: number;
  /** True when Docket could not be read and the pass changed nothing. */
  skipped: boolean;
}

export interface ObservedSessionsOptions {
  orchestrator: Orchestrator;
  /** Injected for tests; defaults to the Docket bridge's `listDocketSessions`. */
  readSessions?: () => Promise<DocketSession[] | null>;
  owned?: CrewOwnedSessions;
  intervalMs?: number;
  /** Surfaced so a caller can log a repeatedly failing reconcile; never throws out of tick(). */
  onError?: (err: Error) => void;
}

export class ObservedSessions {
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<ObservedTick> | null = null;
  private readonly readSessions: () => Promise<DocketSession[] | null>;
  private readonly owned: CrewOwnedSessions;

  constructor(private readonly opts: ObservedSessionsOptions) {
    this.readSessions = opts.readSessions ?? listDocketSessions;
    this.owned = opts.owned ?? new CrewOwnedSessions();
  }

  /**
   * One reconcile. Safe to call directly (tests, and the first pass at startup) and
   * self-serializing: a slow pass can never overlap the next timer fire.
   */
  tick(): Promise<ObservedTick> {
    this.inflight ??= this.reconcile().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async reconcile(): Promise<ObservedTick> {
    const empty: ObservedTick = { appeared: [], disappeared: [], observed: [], ownedByCrew: 0, skipped: true };
    let sessions: DocketSession[] | null;
    try {
      sessions = await this.readSessions();
    } catch (err) {
      this.opts.onError?.(err as Error);
      return empty;
    }
    // null = Docket Core unreachable. Leave the window exactly as it is (see the file header).
    if (sessions === null) return empty;

    const { observed, owned } = await this.owned.partition(sessions);
    const live = new Map(observed.map((s) => [observedAgentId(s.session), s]));

    const before = await this.opts.orchestrator.state();
    const disappeared: string[] = [];
    for (const agent of Object.values(before.agents)) {
      if (agent.origin !== "observed" || live.has(agent.id)) continue;
      if (await this.opts.orchestrator.removeObservedAgent(agent.id)) disappeared.push(agent.id);
    }

    const appeared: string[] = [];
    for (const [id, session] of live) {
      if (before.agents[id] === undefined) appeared.push(id);
      await this.opts.orchestrator.registerObservedAgent({
        id,
        name: observedAgentName(session),
        workspace: session.workspace ?? undefined,
        cwd: session.cwd,
        pid: session.pid,
        startedAt: session.startedAt,
        lastSeenAt: session.lastSeenAt,
      });
    }

    return { appeared, disappeared, observed: [...live.keys()], ownedByCrew: owned.length, skipped: false };
  }

  /**
   * Start the loop. The interval is `unref`'d on purpose: discovery is decoration, and a
   * pending timer that keeps the Node event loop alive would turn "the CLI finished" into
   * "the CLI hangs". An interval of 0 means "do not poll" — the caller drives tick() itself.
   */
  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? DEFAULT_OBSERVE_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.opts.onError?.(err as Error));
    }, interval);
    this.timer.unref?.();
  }

  /** Stop the loop and wait for any pass already in flight to finish. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inflight?.catch(() => {});
  }
}
