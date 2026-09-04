import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dataPath } from "./data-dir.js";
import { withFileLock } from "./filelock.js";
import { log } from "./log.js";

const SESSIONS_PATH = await dataPath("sessions.json");
const LOCK_PATH = `${SESSIONS_PATH}.lock`;

/** A session unheard from for this long is assumed gone, even if its pid check is inconclusive. */
export const SESSION_TTL_MS = 10 * 60_000;
/**
 * How stale a heartbeat may get before a tool call actually rewrites the file. Every tool
 * call touching disk would be a real cost for a value the TTL only reads at minute
 * resolution; a third of a minute keeps "idle 2m" honest for a fraction of the writes.
 */
const HEARTBEAT_DEBOUNCE_MS = 20_000;

export interface LiveSession {
  /** The MCP session token — one per host process run (see sessionToken in index.ts). */
  session: string;
  /** clientInfo.name as the host reported it: "claude-code", "codex", … */
  agent: string | null;
  workspace: string | null;
  cwd: string;
  pid: number;
  startedAt: string;
  lastSeenAt: string;
}

/**
 * Which agent sessions are open right now, and where.
 *
 * Deliberately NOT encrypted and NOT synced. It holds no user content — just process
 * metadata about this machine — and a session on one device tells you nothing useful on
 * another, since you can't switch to a terminal that isn't in front of you. Keeping it out
 * of the encrypted store also keeps it out of the store's lock, so a heartbeat can never
 * contend with a real write.
 */
async function readSessions(): Promise<LiveSession[]> {
  try {
    const parsed = JSON.parse(await readFile(SESSIONS_PATH, "utf8")) as LiveSession[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Missing or corrupt: presence is a convenience, and failing a tool call over it would
    // trade something useful for something decorative.
    return [];
  }
}

async function writeSessions(sessions: LiveSession[]): Promise<void> {
  const tmpPath = `${SESSIONS_PATH}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(sessions, null, 2), { mode: 0o600 });
  await rename(tmpPath, SESSIONS_PATH);
}

/**
 * A pid that no longer exists means the terminal is gone — report it immediately rather
 * than letting it haunt the list for the full TTL, which is precisely the window in which
 * someone would try to "go back to" a session that closed. EPERM means the process exists
 * but belongs to another user, which is still alive as far as this question goes.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isLive(session: LiveSession, now: number): boolean {
  if (now - Date.parse(session.lastSeenAt) > SESSION_TTL_MS) return false;
  return isProcessAlive(session.pid);
}

async function updateSessions(mutate: (sessions: LiveSession[]) => LiveSession[]): Promise<void> {
  await withFileLock(LOCK_PATH, async () => {
    const now = Date.now();
    // Reaped here rather than on a timer: registration, heartbeat and shutdown all pass
    // through this one write, which is often enough to keep the file honest without a
    // background job whose only purpose is tidying.
    const live = (await readSessions()).filter((s) => isLive(s, now));
    await writeSessions(mutate(live));
  });
}

export async function registerSession(session: Omit<LiveSession, "startedAt" | "lastSeenAt">): Promise<void> {
  const now = new Date().toISOString();
  await updateSessions((sessions) => [
    ...sessions.filter((s) => s.session !== session.session),
    { ...session, startedAt: now, lastSeenAt: now },
  ]).catch((err) => log(`sessions: could not register ${session.session}: ${(err as Error).message}`));
}

let lastHeartbeatAt = 0;

/**
 * Called from the seam every tool handler already passes through. Debounced — see
 * HEARTBEAT_DEBOUNCE_MS.
 *
 * It also carries `identity`, so a record registered before the host had introduced itself
 * (or from a directory the host later corrected) is repaired by the first tool call rather
 * than staying wrong for the life of the session.
 */
export async function touchSession(
  sessionToken: string,
  identity?: { agent: string | null; workspace: string | null },
): Promise<void> {
  if (Date.now() - lastHeartbeatAt < HEARTBEAT_DEBOUNCE_MS) return;
  lastHeartbeatAt = Date.now();
  const now = new Date().toISOString();
  await updateSessions((sessions) =>
    sessions.map((s) => (s.session === sessionToken ? { ...s, ...identity, lastSeenAt: now } : s)),
  ).catch((err) => log(`sessions: heartbeat failed for ${sessionToken}: ${(err as Error).message}`));
}

export async function endSession(sessionToken: string): Promise<void> {
  await updateSessions((sessions) => sessions.filter((s) => s.session !== sessionToken)).catch(() => {});
}

/**
 * Live sessions, most recently active first. Filters in memory and does NOT write — a read
 * shouldn't need the lock, and the next registration or heartbeat persists the same
 * reaping anyway.
 *
 * Liveness is "heard from recently AND its pid still exists". Pid reuse can in principle
 * make a dead session look alive, but only inside its TTL and only if the OS recycled that
 * exact number in that window; the cost of being wrong is one stale line in a presence
 * list, which is not worth a heavier liveness check.
 */
export async function listSessions(): Promise<LiveSession[]> {
  const now = Date.now();
  const live = (await readSessions()).filter((s) => isLive(s, now));
  return live.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

/** Used by `docket restore` and the test suite: forget every recorded session on this device. */
export async function clearSessions(): Promise<void> {
  await rm(SESSIONS_PATH, { force: true });
}
