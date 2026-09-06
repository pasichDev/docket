import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AssignmentResult, AssignmentWorktree, RuntimeId } from "./types.js";

/**
 * Isolated git worktrees for coding workers (spec §27/§28/§29).
 *
 *   <worktreesDir>/<repo>/<assignment>/   on branch  crew/<assignment>-<runtime>
 *
 * Two hard rules enforced here:
 *
 *  - §28: a worker is never spawned into an isolated checkout while the human's repo has
 *    uncommitted changes — the worker would branch from HEAD and silently work on a
 *    DIFFERENT tree than the one the human is looking at. That is a loud failure, not a
 *    warning.
 *
 *  - §29: Crew NEVER merges. A finished assignment's branch/worktree/diffstat/commit/tests
 *    are recorded for a human to inspect (collectResult); removing the worktree keeps the
 *    branch — the branch IS the deliverable.
 */

export class WorktreeDirtyError extends Error {
  constructor(repoDir: string, statusLines: string[]) {
    super(
      `crew: repository ${repoDir} has uncommitted changes — refusing to spawn an isolated worker.\n` +
        `The worker would branch from HEAD and silently miss the uncommitted work you are looking at,\n` +
        `so its result would describe a different tree than the one in your editor.\n` +
        `Commit or stash first, then reassign.\n` +
        `Do NOT retry this with isolate:false — running in the human's own checkout is the very\n` +
        `hazard this refusal exists to prevent, and an agent is not allowed to choose it.\n` +
        `Dirty paths:\n${statusLines.map((l) => `  ${l}`).join("\n")}`,
    );
    this.name = "WorktreeDirtyError";
  }
}

export class GitCommandError extends Error {
  constructor(
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = "GitCommandError";
  }
}

/**
 * Plain data, and deliberately the SAME type the assignment record stores (types.ts):
 * bookkeeping that lived only in a Map died with the daemon, taking with it the record of
 * which branch a finished assignment's work is on. One shape, one place it is written.
 */
export type WorktreeInfo = AssignmentWorktree;

/** Direct spawn, no shell (spec §30). */
export function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new GitCommandError(args, code, stderr));
    });
  });
}

/**
 * Spec §28 gate. `git status --porcelain` must come back empty; anything else — staged,
 * unstaged, untracked — fails loudly with the paths listed.
 */
export async function ensureCleanRepo(repoDir: string): Promise<void> {
  const out = await git(["status", "--porcelain"], repoDir);
  const lines = out.split("\n").filter((l) => l.trim());
  if (lines.length > 0) throw new WorktreeDirtyError(repoDir, lines);
}

/**
 * Is this directory a real git working tree? Asked before refusing a non-isolated
 * assignment (orchestrator.assign): the guard exists to protect a repository the human is
 * working in, so a plain directory — where isolation is not even possible — must not be
 * turned into a dead end by it. Cached: the answer cannot change while the daemon runs
 * without the workspace itself being replaced underneath it.
 */
const gitRepoCache = new Map<string, boolean>();

export async function isGitRepo(dir: string): Promise<boolean> {
  const cached = gitRepoCache.get(dir);
  if (cached !== undefined) return cached;
  let inside = false;
  try {
    inside = (await git(["rev-parse", "--is-inside-work-tree"], dir)).trim() === "true";
  } catch {
    inside = false; // not a repo, or no git at all
  }
  gitRepoCache.set(dir, inside);
  return inside;
}

export interface CreateWorktreeInput {
  repoDir: string;
  assignmentId: string;
  runtime: RuntimeId;
  /** Root for all crew worktrees — `crewPaths().worktreesDir` in the daemon. */
  worktreesDir: string;
}

function sanitize(part: string): string {
  const safe = part.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!safe) throw new Error(`crew: cannot derive a safe path segment from "${part}"`);
  return safe;
}

export async function createWorktree(input: CreateWorktreeInput): Promise<WorktreeInfo> {
  const repoDir = resolve(input.repoDir);
  await ensureCleanRepo(repoDir);

  const repoName = sanitize(basename(repoDir));
  const assignment = sanitize(input.assignmentId);
  const branch = `crew/${assignment}-${input.runtime}`;
  const path = join(resolve(input.worktreesDir), repoName, assignment);
  const baseCommit = (await git(["rev-parse", "HEAD"], repoDir)).trim();

  await mkdir(join(resolve(input.worktreesDir), repoName), { recursive: true });
  await git(["worktree", "add", "-b", branch, path, "HEAD"], repoDir);
  return { repoDir, assignmentId: input.assignmentId, branch, path, baseCommit };
}

/**
 * Spec §29: never auto-merge. This gathers what a human needs to inspect the work —
 * branch, worktree, diffstat against the base, HEAD commit, dirty-state note — and it is
 * stored on the assignment result. Merging is a human act, elsewhere.
 */
export async function collectResult(info: WorktreeInfo): Promise<Pick<AssignmentResult, "branch" | "worktree" | "diffStat" | "commit">> {
  const commit = (await git(["rev-parse", "HEAD"], info.path)).trim();
  let diffStat = (await git(["diff", "--stat", `${info.baseCommit}..HEAD`], info.path)).trim();
  const dirty = (await git(["status", "--porcelain"], info.path)).trim();
  if (dirty) {
    diffStat = `${diffStat}${diffStat ? "\n" : ""}(worktree still has uncommitted changes:\n${dirty})`;
  }
  return {
    branch: info.branch,
    worktree: info.path,
    diffStat: diffStat || "(no committed changes)",
    commit,
  };
}

export interface RemoveWorktreeOptions {
  /** Remove even if the worktree has uncommitted changes. Default false — those changes are somebody's work. */
  force?: boolean;
}

/**
 * Clean teardown: detach the worktree from the repo and delete the checkout directory.
 * The BRANCH is deliberately kept — deleting it would destroy the only record of the work
 * (spec §29). Refuses (via git itself) to remove a dirty worktree unless forced.
 */
export async function removeWorktree(info: WorktreeInfo, options: RemoveWorktreeOptions = {}): Promise<void> {
  const args = ["worktree", "remove"];
  if (options.force) args.push("--force");
  args.push(info.path);
  await git(args, info.repoDir);
  await git(["worktree", "prune"], info.repoDir);
  // git worktree remove already deletes the directory; this sweeps an empty parent.
  await rm(info.path, { recursive: true, force: true }).catch(() => {});
}

/**
 * Every `crew/*` branch in the repo, oldest commit first.
 *
 * These are the deliverable (§29 keeps the branch when the worktree goes) and NOTHING deletes
 * them: they accumulate for the life of the repository, one per isolated assignment. `doctor`
 * reports the count so that growth is visible rather than discovered a year later — the
 * cleanup itself stays a human act, because a crew branch may be the only record of work
 * nobody has merged yet.
 */
export async function listCrewBranches(repoDir: string): Promise<Array<{ branch: string; lastCommit: string }>> {
  const out = await git(["for-each-ref", "--format=%(refname:short)%09%(committerdate:iso8601)", "refs/heads/crew/"], repoDir);
  return out
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0].trim()))
    .map(([branch, lastCommit]) => ({ branch: branch.trim(), lastCommit: lastCommit.trim() }))
    .sort((a, b) => a.lastCommit.localeCompare(b.lastCommit));
}

/** All crew-created worktrees currently attached to a repo, for `docket-crew doctor`/Office. */
export async function listWorktrees(repoDir: string): Promise<Array<{ path: string; branch: string | null }>> {
  const out = await git(["worktree", "list", "--porcelain"], repoDir);
  const entries: Array<{ path: string; branch: string | null }> = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (current) entries.push(current);
  return entries.filter((e) => e.branch?.startsWith("crew/"));
}
