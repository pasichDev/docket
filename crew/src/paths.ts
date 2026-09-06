import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * The Crew state tree (spec §31):
 *
 *   ~/.docket/crew/
 *     config.yml      — profiles + automation settings (config.ts)
 *     state.json      — daemon state, single writer (state.ts)
 *     events.jsonl    — append-only event log (events.ts)
 *     logs/           — raw per-run runtime output + daemon log
 *     worktrees/      — assignment isolation checkouts (worktrees.ts, Agent 3)
 *
 * `DOCKET_CREW_HOME` overrides the root wholesale. That override is load-bearing: every
 * test and live smoke run points Crew at a scratch directory through it, so nothing here
 * may cache the root at module load — the env var is consulted on every call.
 */

export interface CrewPaths {
  root: string;
  configFile: string;
  stateFile: string;
  eventsFile: string;
  logsDir: string;
  worktreesDir: string;
  /** Daemon liveness record {pid, port, startedAt}. Inside the root like everything else. */
  daemonFile: string;
  /**
   * Single-writer lock on the crew home. Held for the daemon's whole life, taken with O_EXCL
   * before anything else so a second `__daemon` cannot touch this home at all (see
   * acquireCrewHomeLock).
   */
  lockFile: string;
}

/** The Crew root: `DOCKET_CREW_HOME` when set, else `~/.docket/crew`. */
export function crewHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DOCKET_CREW_HOME?.trim();
  return resolve(override || join(homedir(), ".docket", "crew"));
}

export function crewPaths(root: string = crewHome()): CrewPaths {
  const r = resolve(root);
  return {
    root: r,
    configFile: join(r, "config.yml"),
    stateFile: join(r, "state.json"),
    eventsFile: join(r, "events.jsonl"),
    logsDir: join(r, "logs"),
    worktreesDir: join(r, "worktrees"),
    daemonFile: join(r, "daemon.json"),
    lockFile: join(r, "daemon.lock"),
  };
}

/**
 * Create the whole tree. Idempotent; returns the paths it ensured.
 *
 * 0700 throughout, and re-applied to an existing root: everything under here — prompts,
 * agent output, the agent token, state.json — is at the same trust level as an SSH key, and
 * the root used to be created 0755 while the files inside it were 0600. Best-effort, because
 * a permission fix is not worth refusing to start over.
 */
export async function ensureCrewTree(paths: CrewPaths = crewPaths()): Promise<CrewPaths> {
  await mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.worktreesDir, { recursive: true, mode: 0o700 });
  for (const dir of [paths.root, paths.logsDir, paths.worktreesDir]) {
    await chmod(dir, 0o700).catch(() => {});
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Single-writer lock on the crew home
// ---------------------------------------------------------------------------

export class CrewHomeLockedError extends Error {
  constructor(
    readonly holderPid: number,
    readonly file: string,
  ) {
    super(
      `crew: this crew home is already owned by daemon pid ${holderPid} (${file}). ` +
        `Two daemons over one home corrupt each other's state — refusing to start a second one.`,
    );
    this.name = "CrewHomeLockedError";
  }
}

export interface CrewHomeLock {
  file: string;
  pid: number;
  /** Remove the lock, but only while it is still ours. Never throws. */
  release(): Promise<void>;
}

interface LockRecord {
  pid: number;
  startedAt: string;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and is somebody else's — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockRecord(file: string): Promise<LockRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as LockRecord;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Take the crew home for this process, or fail loudly.
 *
 * This is the enforcement of the documented single-writer invariant, and it must be the
 * daemon's FIRST act. Before it existed, a second `__daemon` — which `docket-crew start`
 * would spawn on its own whenever a 1.5 s health probe timed out — ran restart recovery,
 * rewrote state.json, killed the live daemon's in-flight assignment with a fabricated
 * "interrupted" result, wrote phantom failures into the shared event log and rotated the
 * agent token (401 for every subsequent turn) before finally dying on EADDRINUSE. Nothing
 * about binding a port protects a directory; this does.
 *
 * A lock naming a dead pid is stale and is reclaimed — a SIGKILLed daemon must not lock its
 * own home out forever.
 */
export async function acquireCrewHomeLock(paths: CrewPaths, pid: number = process.pid): Promise<CrewHomeLock> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(paths.lockFile, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid, startedAt: new Date().toISOString() } satisfies LockRecord) + "\n");
      await handle.close();
      return {
        file: paths.lockFile,
        pid,
        release: async () => {
          const current = await readLockRecord(paths.lockFile);
          if (current && current.pid !== pid) return; // a successor owns it now — leave it alone
          await rm(paths.lockFile, { force: true }).catch(() => {});
        },
      };
    } catch (err) {
      await handle?.close().catch(() => {});
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = await readLockRecord(paths.lockFile);
      if (holder && holder.pid !== pid && pidIsAlive(holder.pid)) {
        throw new CrewHomeLockedError(holder.pid, paths.lockFile);
      }
      // Stale (dead holder), unreadable, or already ours: clear it and try once more.
      await rm(paths.lockFile, { force: true }).catch(() => {});
    }
  }
  throw new Error(`crew: could not acquire ${paths.lockFile} — another process is racing for this crew home`);
}

/**
 * Guard for "never write outside the root". Every module that derives a path from
 * user-influenced input (a runId becoming a log file name, say) funnels it through this.
 */
export function assertInsideRoot(paths: CrewPaths, target: string): string {
  const resolved = resolve(target);
  if (resolved !== paths.root && !resolved.startsWith(paths.root + sep)) {
    throw new Error(`crew: refusing to touch ${resolved} — outside the crew root ${paths.root}`);
  }
  return resolved;
}

/**
 * Temp-file + fsync + rename, the same discipline as Docket Core's fs-atomic.ts (not
 * imported — separate package). A reader sees either the previous contents or the complete
 * new ones; the file fsync makes a successful return survive a power cut. The directory
 * fsync is best-effort: some platforms refuse it, and failing the write over a sharpening
 * of durability would be worse than the sharpening is worth.
 */
export async function atomicWriteFile(path: string, data: Buffer | string, mode = 0o600): Promise<void> {
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(tmpPath, "wx", mode);
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle?.close().catch(() => {});
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
  await handle.close();
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
  await syncDirectory(dirname(path));
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Best-effort — see atomicWriteFile.
  } finally {
    await handle?.close().catch(() => {});
  }
}
