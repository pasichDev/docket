import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Where Crew touches Docket Core (spec §26): Docket stays the canonical task store, and Crew
 * never grows a competing one — an assignment carries a `docketTodoId` REFERENCE, nothing more.
 *
 * This module is deliberately READ-ONLY and small. Task MUTATION does not happen here: every
 * spawned agent is handed Docket's own MCP server (runtime.ts → buildMcpServerSpecs), so a
 * worker claims and completes its own todo through the real `todo_*` tools and Docket's history
 * attributes the change to the agent that did the work rather than to the daemon. A
 * daemon-side write path would be a second way to mutate the same store, with different
 * provenance — so there isn't one.
 *
 * What is left is locating Docket Core and reading its live MCP sessions, both of which the
 * daemon genuinely needs. Both load the BUILT modules (`<repo>/dist/*.js`) by dynamic import
 * rather than calling the web API, because the web server is optional and sessions exist
 * whether or not it is running (see loadSessions).
 *
 * DOCKET_DATA_DIR is honoured by Docket's own data-dir resolution (memoized per PROCESS,
 * env wins) — tests point it at a scratch dir before first use and never touch ~/.docket.
 */

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locate the built Docket Core. `CREW_DOCKET_DIST` overrides (tests, and any layout where
 * crew's own build output doesn't sit inside the repo); otherwise walk up from this module
 * and from cwd looking for the repo's package.json (`@pasichdev/docket`) with a dist/.
 */
export async function findDocketDist(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const override = env.CREW_DOCKET_DIST?.trim();
  if (override) {
    if (await isDir(override)) return resolve(override);
    throw new Error(`crew: CREW_DOCKET_DIST=${override} is not a directory`);
  }
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let dir = resolve(start);
    for (;;) {
      try {
        const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: string };
        if (pkg.name === "@pasichdev/docket" && (await isDir(join(dir, "dist")))) return join(dir, "dist");
      } catch {
        // keep walking
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    "crew: cannot find the built Docket Core (dist/). Run `npm run build` in the Docket repo, or set CREW_DOCKET_DIST.",
  );
}

// ---------------------------------------------------------------------------
// Live Docket MCP sessions (spec §17 — the observed half)
// ---------------------------------------------------------------------------

/**
 * One row of Docket Core's `sessions.json`, exactly as `src/sessions.ts` writes it. Kept as a
 * structural view for the same reason DocketTodo is: crew/ must not compile against the parent
 * package's types.
 */
export interface DocketSession {
  /** The MCP session token — one per host process run (Docket's `sessionToken`). */
  session: string;
  /** clientInfo.name as the host reported it ("claude-code", "codex", …), null before initialize. */
  agent: string | null;
  workspace: string | null;
  cwd: string;
  pid: number;
  startedAt: string;
  lastSeenAt: string;
}

interface SessionsModule {
  listSessions: () => Promise<DocketSession[]>;
}

let sessionsPromise: Promise<SessionsModule> | null = null;

/**
 * Loaded on the same terms as the TodoService above — the BUILT `dist/sessions.js`, not the
 * web API — and for a sharper reason:
 *
 *  - `GET http://127.0.0.1:8787/api/sessions` only answers while the Docket WEB SERVER happens
 *    to be running. Sessions exist whether or not it is, so hanging ghost discovery off it
 *    would make the Office's window empty for reasons that have nothing to do with sessions.
 *  - `listSessions()` already applies Docket's own liveness rule (`lastSeenAt` within
 *    SESSION_TTL_MS **and** the pid still alive) — the exact rule the rest of Docket uses, so
 *    Crew cannot drift into a second, subtly different definition of "still there".
 *  - It is a pure READ: `listSessions` filters in memory and deliberately does not take the
 *    lock or rewrite the file, so pointing Crew at the user's real ~/.docket cannot disturb it.
 *  - It honours DOCKET_DATA_DIR through Docket's own resolution, so a scratch store works.
 */
async function loadSessions(): Promise<SessionsModule> {
  sessionsPromise ??= (async () => {
    const dist = await findDocketDist();
    return (await import(pathToFileURL(join(dist, "sessions.js")).href)) as SessionsModule;
  })();
  return sessionsPromise;
}

/**
 * Live Docket MCP sessions on this machine, most recently active first.
 *
 * Returns null — not an empty array — when Docket Core cannot be reached at all (not built,
 * or its module failed to load). The distinction is load-bearing: "no sessions" means the
 * window is empty, "cannot tell" must leave whatever the Office is already showing alone
 * rather than flapping every ghost off the glass.
 */
export async function listDocketSessions(): Promise<DocketSession[] | null> {
  try {
    const mod = await loadSessions();
    const sessions = await mod.listSessions();
    return Array.isArray(sessions) ? sessions : [];
  } catch {
    return null;
  }
}

