import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectResult, createWorktree, ensureCleanRepo, git, removeWorktree, WorktreeDirtyError } from "./worktrees.js";

/**
 * Real git, in a scratch repo under the OS temp dir. Never the user's repository and never
 * ~/.docket — spec §28's whole point is that Crew must not silently work on a tree other
 * than the one the human is looking at, and a test that reached into their repo to prove
 * that would be its own violation.
 */
async function scratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crew-worktree-test-"));
  await git(["init", "-b", "main"], dir);
  await git(["config", "user.email", "crew@test.local"], dir);
  await git(["config", "user.name", "Crew Test"], dir);
  await git(["config", "commit.gpgsign", "false"], dir);
  await writeFile(join(dir, "README.md"), "seed\n");
  await git(["add", "README.md"], dir);
  await git(["commit", "-m", "seed"], dir);
  return dir;
}

test("a clean repo passes the gate", async () => {
  await ensureCleanRepo(await scratchRepo()); // must not throw
});

test("createWorktree REFUSES a repo with uncommitted changes, loudly and with the paths", async () => {
  const repo = await scratchRepo();
  await writeFile(join(repo, "README.md"), "edited but not committed\n");

  const worktrees = await mkdtemp(join(tmpdir(), "crew-wt-root-"));
  await assert.rejects(
    () => createWorktree({ repoDir: repo, assignmentId: "a1", runtime: "codex", worktreesDir: worktrees }),
    (err: unknown) => {
      assert.ok(err instanceof WorktreeDirtyError);
      assert.match(err.message, /uncommitted changes/);
      assert.match(err.message, /README\.md/, "the dirty paths are named so the human can act");
      assert.match(err.message, /Commit or stash first/);
      return true;
    },
  );

  // And nothing was created behind the failure — no half-made worktree, no branch.
  const branches = await git(["branch", "--list", "crew/*"], repo);
  assert.equal(branches.trim(), "", "a refused isolation leaves no crew branch behind");
});

test("an untracked file is dirty too — it would be invisible to the worker's branch", async () => {
  const repo = await scratchRepo();
  await writeFile(join(repo, "scratch.txt"), "not added\n");
  await assert.rejects(() => ensureCleanRepo(repo), WorktreeDirtyError);
});

test("createWorktree makes an isolated checkout on a crew/ branch, and collectResult reports the diff", async () => {
  const repo = await scratchRepo();
  const worktrees = await mkdtemp(join(tmpdir(), "crew-wt-root-"));
  const info = await createWorktree({ repoDir: repo, assignmentId: "a1b2c3", runtime: "codex", worktreesDir: worktrees });

  assert.equal(info.branch, "crew/a1b2c3-codex");
  assert.match(info.path, /a1b2c3$/);

  // The worker does its work in the isolated tree only.
  await writeFile(join(info.path, "CHANGELOG.md"), "# Changelog\n");
  await git(["add", "CHANGELOG.md"], info.path);
  await git(["commit", "-m", "add changelog"], info.path);

  const result = await collectResult(info);
  assert.equal(result.branch, "crew/a1b2c3-codex");
  assert.match(result.diffStat ?? "", /CHANGELOG\.md/);
  assert.notEqual(result.commit, info.baseCommit);

  // The human's checkout is untouched — that is the entire point of the isolation.
  assert.equal((await git(["status", "--porcelain"], repo)).trim(), "");
  assert.equal((await git(["rev-parse", "HEAD"], repo)).trim(), info.baseCommit);
});

test("collectResult flags uncommitted work in the worker's tree rather than reporting a clean diff", async () => {
  const repo = await scratchRepo();
  const worktrees = await mkdtemp(join(tmpdir(), "crew-wt-root-"));
  const info = await createWorktree({ repoDir: repo, assignmentId: "d4e5", runtime: "claude", worktreesDir: worktrees });
  await writeFile(join(info.path, "half-done.txt"), "wip\n");

  const result = await collectResult(info);
  assert.match(result.diffStat ?? "", /still has uncommitted changes/);
  assert.match(result.diffStat ?? "", /half-done\.txt/);
});

test("removeWorktree deletes the checkout but KEEPS the branch — the branch is the deliverable", async () => {
  const repo = await scratchRepo();
  const worktrees = await mkdtemp(join(tmpdir(), "crew-wt-root-"));
  const info = await createWorktree({ repoDir: repo, assignmentId: "f6a7", runtime: "codex", worktreesDir: worktrees });
  await writeFile(join(info.path, "work.txt"), "done\n");
  await git(["add", "work.txt"], info.path);
  await git(["commit", "-m", "work"], info.path);

  await removeWorktree(info);
  const branches = await git(["branch", "--list", "crew/f6a7-codex"], repo);
  assert.match(branches, /crew\/f6a7-codex/, "Crew never destroys the record of the work (spec §29)");
});
