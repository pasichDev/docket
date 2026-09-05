import { readFile, stat } from "node:fs/promises";
import type { Todo } from "./types.js";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Where a resolved workspace came from. Reported by `docket status` and logged once at startup, so a mis-resolution is visible instead of mysterious. */
export type WorkspaceSource = "env" | "config" | "git-remote" | "git-root" | "cwd" | "none";

export interface WorkspaceResolution {
  /** The slug items get stamped with, or null when there is no project context at all. */
  workspace: string | null;
  source: WorkspaceSource;
  /** The directory the resolution was anchored at — the git root when there is one, otherwise cwd. */
  root: string | null;
}

/** Project-root override file. One key, deliberately: this is an escape hatch, not a config system. */
export const WORKSPACE_CONFIG_FILE = ".docket.json";

/**
 * Folds the many ways to write the same project name onto one slug: lowercase, with runs of
 * anything outside `[a-z0-9._-]` collapsed to a single dash. `/` survives because git
 * remotes are naturally `owner/repo` and that separator carries real meaning.
 *
 * Applied to EVERY source, including the explicit env var and `.docket.json`, so that
 * "Acme Backend" typed on one machine and "acme-backend" on another don't quietly become
 * two workspaces. The cost is that an explicit name is not preserved byte-for-byte; the
 * benefit is that the one thing this feature promises — the same project is one workspace —
 * doesn't depend on typing it identically everywhere.
 */
export function slugifyWorkspace(raw: string): string | null {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\/{2,}/g, "/");
  return slug || null;
}

/**
 * Turns a git remote URL into `owner/repo`.
 *
 * The remote, not the path, is what makes this feature work across machines: the same
 * project cloned to ~/src/backend on a laptop and /work/backend on a desktop has to land in
 * ONE workspace, or sync produces two half-lists. Only the last two path segments are kept,
 * so the same repo reached over SSH and over HTTPS — different hosts, credentials, ports —
 * still normalises to the same slug.
 */
export function normalizeGitRemote(url: string): string | null {
  const trimmed = url.trim().replace(/\.git\/?$/, "");
  if (!trimmed) return null;

  // scp-style `[user@]host:path`, which is not a URL and never parses as one.
  const scp = /^[^/\s]+@([^/:\s]+):(.+)$/.exec(trimmed);
  let path: string;
  let host: string | null = null;
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname || null;
      path = parsed.pathname;
    } catch {
      path = trimmed;
    }
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  /*
   * The host is part of the identity, not decoration. "owner/repo" alone collides the
   * moment two forges share a namespace — a GitLab group and a GitHub org with the same
   * name, a self-hosted mirror of a public repo, a fork on a company server — and the
   * failure mode is two unrelated projects quietly sharing one list.
   *
   * A remote with no host at all (a plain local path) keeps the last two segments, because
   * there is nothing better to key on.
   */
  const parts = host ? [host, ...segments.slice(-2)] : segments.slice(-2);
  return slugifyWorkspace(parts.join("/"));
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Nearest ancestor containing `.git`. Walks the tree rather than shelling out to
 * `git rev-parse`: this runs at MCP startup, in a process a host is waiting on, and
 * spawning a subprocess to answer a question the filesystem already answers is a cost paid
 * on every session for nothing.
 */
export async function findGitRoot(startDir: string): Promise<string | null> {
  let dir = resolve(startDir);
  for (;;) {
    try {
      await stat(join(dir, ".git"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

/**
 * `.git` is usually a directory, but in a linked worktree or a submodule it is a file
 * pointing elsewhere, and the config that holds the remotes lives in the COMMON directory
 * shared with the main checkout. Following both hops means a worktree resolves to the same
 * workspace as the checkout it belongs to, which is the whole point.
 */
async function gitConfigPath(gitRoot: string): Promise<string | null> {
  const dotGit = join(gitRoot, ".git");
  if (await isDirectory(dotGit)) return join(dotGit, "config");
  let gitDir: string;
  try {
    const pointer = await readFile(dotGit, "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(pointer);
    if (!match) return null;
    gitDir = isAbsolute(match[1].trim()) ? match[1].trim() : resolve(gitRoot, match[1].trim());
  } catch {
    return null;
  }
  try {
    const common = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
    gitDir = isAbsolute(common) ? common : resolve(gitDir, common);
  } catch {
    // No commondir: `gitDir` is already the real git directory (a submodule, typically).
  }
  return join(gitDir, "config");
}

/**
 * Reads the remote URL straight out of `.git/config` — `origin` if present, otherwise the
 * first remote defined. A hand-rolled read of two INI keys, not a general git config parser:
 * anything more would be a dependency or a bug farm, and this is the only question asked.
 */
export async function readGitRemote(gitRoot: string): Promise<string | null> {
  const configPath = await gitConfigPath(gitRoot);
  if (!configPath) return null;
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return null;
  }
  const remotes = new Map<string, string>();
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line);
    if (section) {
      current = section[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    const url = current && /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (url && !remotes.has(current!)) remotes.set(current!, url[1]);
  }
  return remotes.get("origin") ?? [...remotes.values()][0] ?? null;
}

async function readWorkspaceConfig(root: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(join(root, WORKSPACE_CONFIG_FILE), "utf8")) as { workspace?: unknown };
    return typeof parsed.workspace === "string" ? parsed.workspace : null;
  } catch {
    // Missing is the common case; malformed is the user's own file and not worth failing
    // startup over — the next resolution step gives a workable answer either way.
    return null;
  }
}

/**
 * Resolution order, first hit wins:
 *
 *  1. `DOCKET_WORKSPACE` — explicit, always wins.
 *  2. `.docket.json` at the git root (or cwd): the escape hatch for monorepos, and for two
 *     unrelated projects whose directories happen to share a basename.
 *  3. The git remote, normalised — the only source that is stable across machines.
 *  4. The git root's basename — a repo with no remote is still a project.
 *  5. cwd's basename.
 *  6. null — no project context at all (a bare Claude Desktop session, say). Deliberately
 *     not guessed: an item filed under a wrong workspace is hidden somewhere its author
 *     will never look, which is strictly worse than a visible "Unfiled".
 */
export async function resolveWorkspace(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<WorkspaceResolution> {
  const fromEnv = env.DOCKET_WORKSPACE ? slugifyWorkspace(env.DOCKET_WORKSPACE) : null;
  if (fromEnv) return { workspace: fromEnv, source: "env", root: cwd || null };
  if (!cwd) return { workspace: null, source: "none", root: null };

  const gitRoot = await findGitRoot(cwd);
  const root = gitRoot ?? cwd;

  const configured = await readWorkspaceConfig(root);
  const fromConfig = configured ? slugifyWorkspace(configured) : null;
  if (fromConfig) return { workspace: fromConfig, source: "config", root };

  if (gitRoot) {
    const remote = await readGitRemote(gitRoot);
    const fromRemote = remote ? normalizeGitRemote(remote) : null;
    if (fromRemote) return { workspace: fromRemote, source: "git-remote", root };
    const fromRoot = slugifyWorkspace(basename(gitRoot));
    if (fromRoot) return { workspace: fromRoot, source: "git-root", root };
  }

  const fromCwd = slugifyWorkspace(basename(resolve(cwd)));
  if (fromCwd) return { workspace: fromCwd, source: "cwd", root };
  return { workspace: null, source: "none", root };
}

/**
 * Process-wide resolution, computed once. Every MCP host spawns its own `node dist/index.js`
 * per session, so the answer is fixed for the life of a session — except when the host tells
 * us its roots changed, which is what `invalidateWorkspace` is for. Re-resolving on every
 * tool call would mean a filesystem walk per call for an answer that essentially never moves.
 */
let cached: Promise<WorkspaceResolution> | null = null;
let anchorDir: string | null = null;

export function currentWorkspace(): Promise<WorkspaceResolution> {
  cached ??= resolveWorkspace(anchorDir ?? process.cwd());
  return cached;
}

/** Re-anchor on a directory the host told us about (MCP `roots`), and re-resolve on next use. */
export function setWorkspaceRoot(dir: string | null): void {
  anchorDir = dir;
  cached = null;
}

/** What an item with no project is called, everywhere it is shown. It used to be spelled three different ways. */
export const UNFILED_LABEL = "unfiled";

export interface WorkspaceSummary {
  name: string;
  open: number;
  total: number;
  /** The most recent `updatedAt` in this workspace — "which project did I last touch?". */
  lastActivity: string;
}

/**
 * Groups items by project, busiest first. One fold, used by `docket stats`, `docket
 * workspaces` and the status line — they previously each rebuilt it, and had already
 * drifted on what to call an item with no project.
 */
export function summarizeWorkspaces(todos: Todo[]): WorkspaceSummary[] {
  const byName = new Map<string, WorkspaceSummary>();
  for (const todo of todos) {
    const name = todo.workspace ?? UNFILED_LABEL;
    const entry = byName.get(name) ?? { name, open: 0, total: 0, lastActivity: "" };
    entry.total += 1;
    if (!todo.done) entry.open += 1;
    if (todo.updatedAt > entry.lastActivity) entry.lastActivity = todo.updatedAt;
    byName.set(name, entry);
  }
  // Unfiled sorts last whatever its size: it is a holding pen, not a project.
  return [...byName.values()].sort(
    (a, b) =>
      Number(a.name === UNFILED_LABEL) - Number(b.name === UNFILED_LABEL) || b.open - a.open || a.name.localeCompare(b.name),
  );
}
