import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeGitRemote, resolveWorkspace, slugifyWorkspace, WORKSPACE_CONFIG_FILE } from "./workspace.js";

const root = await mkdtemp(join(tmpdir(), "docket-workspace-test-"));
test.after(() => rm(root, { recursive: true, force: true }));

/** A repo on disk, with as much or as little of a real one as the case under test needs. */
async function makeRepo(name: string, options: { remote?: string; config?: string; git?: boolean } = {}): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  if (options.git !== false) {
    await mkdir(join(dir, ".git"), { recursive: true });
    const remoteBlock = options.remote ? `[remote "origin"]\n\turl = ${options.remote}\n\tfetch = +refs/heads/*\n` : "";
    await writeFile(join(dir, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n${remoteBlock}`);
  }
  if (options.config) await writeFile(join(dir, WORKSPACE_CONFIG_FILE), options.config);
  return dir;
}

test("resolve: DOCKET_WORKSPACE wins over everything else", async () => {
  const dir = await makeRepo("env-repo", { remote: "git@gitlab.com:acme/backend.git", config: '{"workspace":"from-file"}' });
  const resolved = await resolveWorkspace(dir, { DOCKET_WORKSPACE: "explicit" });
  assert.equal(resolved.workspace, "explicit");
  assert.equal(resolved.source, "env");
});

test("resolve: .docket.json at the repo root wins over the git remote", async () => {
  const dir = await makeRepo("config-repo", { remote: "git@gitlab.com:acme/backend.git", config: '{"workspace":"monorepo-api"}' });
  const resolved = await resolveWorkspace(dir, {});
  assert.equal(resolved.workspace, "monorepo-api");
  assert.equal(resolved.source, "config");
});

test("resolve: a malformed .docket.json falls through instead of failing startup", async () => {
  const dir = await makeRepo("broken-config-repo", { remote: "git@gitlab.com:acme/backend.git", config: "{not json" });
  const resolved = await resolveWorkspace(dir, {});
  assert.equal(resolved.workspace, "gitlab.com/acme/backend");
  assert.equal(resolved.source, "git-remote");
});

test("resolve: the git remote is used, and reached from a subdirectory too", async () => {
  const dir = await makeRepo("remote-repo", { remote: "git@gitlab.com:acme/backend.git" });
  const nested = join(dir, "src", "deep");
  await mkdir(nested, { recursive: true });
  const resolved = await resolveWorkspace(nested, {});
  assert.equal(resolved.workspace, "gitlab.com/acme/backend");
  assert.equal(resolved.source, "git-remote");
  assert.equal(resolved.root, dir, "resolution anchors on the git root, not the directory it was called from");
});

test("resolve: SSH and HTTPS clones of the same repo normalise to the same workspace", async () => {
  // The reason the remote is preferred over the path at all: two machines, two clone URLs,
  // two directory layouts — one workspace, or sync produces two half-lists.
  const ssh = await makeRepo("clone-ssh", { remote: "git@gitlab.com:acme/backend.git" });
  const https = await makeRepo("clone-https", { remote: "https://someone@gitlab.com/acme/backend.git" });
  const a = await resolveWorkspace(ssh, {});
  const b = await resolveWorkspace(https, {});
  assert.equal(a.workspace, b.workspace);
  assert.equal(a.workspace, "gitlab.com/acme/backend");
});

test("resolve: a repo with no remote falls back to the git root's basename", async () => {
  const dir = await makeRepo("Local Only Repo");
  const resolved = await resolveWorkspace(dir, {});
  assert.equal(resolved.workspace, "local-only-repo");
  assert.equal(resolved.source, "git-root");
});

test("resolve: outside a git repo, the cwd basename is used", async () => {
  const dir = join(root, "no-git-here");
  await mkdir(dir, { recursive: true });
  const resolved = await resolveWorkspace(dir, {});
  assert.equal(resolved.workspace, "no-git-here");
  assert.equal(resolved.source, "cwd");
});

test("resolve: no cwd at all means no workspace — never a guess", async () => {
  const resolved = await resolveWorkspace("", {});
  assert.equal(resolved.workspace, null);
  assert.equal(resolved.source, "none");
});

test("normalizeGitRemote: keeps host/owner/repo across every URL shape", () => {
  const cases: Array<[string, string | null]> = [
    ["git@gitlab.com:acme/backend.git", "gitlab.com/acme/backend"],
    ["git@github.com:Acme/Backend", "github.com/acme/backend"],
    ["https://github.com/acme/backend.git", "github.com/acme/backend"],
    ["https://user:token@github.com/acme/backend.git", "github.com/acme/backend"],
    ["ssh://git@ssh.github.com:443/acme/backend.git", "ssh.github.com/acme/backend"],
    // A nested GitLab group is part of the identity, not noise to trim: two teams whose
    // "platform/backend" both collapsed to the same slug had their lists silently merged.
    ["https://gitlab.com/acme/group/backend.git", "gitlab.com/acme/group/backend"],
    ["https://gitlab.company/team-a/platform/backend.git", "gitlab.company/team-a/platform/backend"],
    ["https://gitlab.company/team-b/platform/backend.git", "gitlab.company/team-b/platform/backend"],
    // The whole point of carrying the host: these two are different projects.
    ["git@gitlab.com:acme/backend.git", "gitlab.com/acme/backend"],
    ["git@github.com:acme/backend.git", "github.com/acme/backend"],
    // A remote with no host at all has nothing better to key on.
    ["/srv/git/backend.git", "git/backend"],
    ["", null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeGitRemote(input), expected, `normalizeGitRemote(${JSON.stringify(input)})`);
  }
});

test("slugifyWorkspace: the same project named two ways lands on one slug", () => {
  assert.equal(slugifyWorkspace("Acme Backend"), "acme-backend");
  assert.equal(slugifyWorkspace("  my_project  "), "my_project");
  assert.equal(slugifyWorkspace("acme//backend"), "acme/backend");
  assert.equal(slugifyWorkspace("!!!"), null);
});

// --- 2.4: the resolution table, exhaustively -------------------------------------------

test("resolve: an empty or whitespace-only DOCKET_WORKSPACE falls through instead of blanking the project", async () => {
  const dir = await makeRepo("env-blank", { remote: "git@gitlab.com:acme/backend.git" });
  for (const value of ["", "   ", "\t\n"]) {
    const resolved = await resolveWorkspace(dir, { DOCKET_WORKSPACE: value });
    assert.equal(resolved.workspace, "gitlab.com/acme/backend", `"${value}" should not have won the resolution`);
    assert.equal(resolved.source, "git-remote");
  }
});

test("resolve: an env value that slugifies to nothing falls through rather than unfiling everything", async () => {
  const dir = await makeRepo("env-junk", { remote: "git@gitlab.com:acme/backend.git" });
  const resolved = await resolveWorkspace(dir, { DOCKET_WORKSPACE: "!!!" });
  assert.equal(resolved.workspace, "gitlab.com/acme/backend");
});

test("resolve: a .docket.json without a workspace key is ignored, not treated as null", async () => {
  const dir = await makeRepo("config-no-key", { remote: "git@gitlab.com:acme/backend.git", config: '{"somethingElse":true}' });
  const resolved = await resolveWorkspace(dir, {});
  assert.equal(resolved.workspace, "gitlab.com/acme/backend");
  assert.equal(resolved.source, "git-remote");
});

test("resolve: a .docket.json with a non-string workspace is ignored", async () => {
  const dir = await makeRepo("config-wrong-type", { remote: "git@gitlab.com:acme/backend.git", config: '{"workspace":42}' });
  assert.equal((await resolveWorkspace(dir, {})).workspace, "gitlab.com/acme/backend");
});

test("resolve: every URL shape of the same remote normalises to one workspace", async () => {
  // The promise the feature makes: the same project on two machines is ONE workspace,
  // however each machine happens to have cloned it.
  const shapes = [
    "git@gitlab.com:acme/backend.git",
    "git@gitlab.com:acme/backend",
    "https://gitlab.com/acme/backend.git",
    "https://gitlab.com/acme/backend",
    "https://gitlab.com/acme/backend/",
    "https://user:token@gitlab.com/acme/backend.git",
    "ssh://git@gitlab.com:2222/acme/backend.git",
    "https://GitLab.COM/Acme/Backend.git",
  ];
  const resolved = new Set<string | null>();
  for (const [i, remote] of shapes.entries()) {
    const dir = await makeRepo(`shape-${i}`, { remote });
    resolved.add((await resolveWorkspace(dir, {})).workspace);
  }
  assert.deepEqual([...resolved], ["gitlab.com/acme/backend"], `these clone URLs split into ${resolved.size} workspaces: ${[...resolved].join(", ")}`);
});

test("resolve: with several remotes, origin wins; without origin, the first defined one is used", async () => {
  const dir = await makeRepo("multi-remote", { git: false });
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(
    join(dir, ".git", "config"),
    '[remote "upstream"]\n\turl = git@gitlab.com:upstream/project.git\n[remote "origin"]\n\turl = git@gitlab.com:acme/backend.git\n',
  );
  assert.equal((await resolveWorkspace(dir, {})).workspace, "gitlab.com/acme/backend", "origin must win however late it appears");

  const noOrigin = await makeRepo("no-origin", { git: false });
  await mkdir(join(noOrigin, ".git"), { recursive: true });
  await writeFile(join(noOrigin, ".git", "config"), '[remote "fork"]\n\turl = git@gitlab.com:someone/fork.git\n');
  assert.equal((await resolveWorkspace(noOrigin, {})).workspace, "gitlab.com/someone/fork");
});

test("resolve: a worktree resolves to the same workspace as the checkout it belongs to", async () => {
  // `.git` is a file in a linked worktree, and the remotes live in the main checkout's
  // common directory. Landing in a different workspace would split one project in two.
  const main = await makeRepo("wt-main", { remote: "git@gitlab.com:acme/backend.git" });
  await mkdir(join(main, ".git", "worktrees", "feature"), { recursive: true });
  await writeFile(join(main, ".git", "worktrees", "feature", "commondir"), "../..\n");

  const worktree = join(root, "wt-feature");
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`);

  const resolved = await resolveWorkspace(worktree, {});
  assert.equal(resolved.workspace, "gitlab.com/acme/backend", "a worktree must not become its own workspace");
});

test("resolve: a submodule uses its own remote, not its parent's", async () => {
  const parent = await makeRepo("sub-parent", { remote: "git@gitlab.com:acme/parent.git" });
  await mkdir(join(parent, ".git", "modules", "lib"), { recursive: true });
  await writeFile(join(parent, ".git", "modules", "lib", "config"), '[remote "origin"]\n\turl = git@gitlab.com:acme/lib.git\n');

  const submodule = join(parent, "lib");
  await mkdir(submodule, { recursive: true });
  await writeFile(join(submodule, ".git"), `gitdir: ${join(parent, ".git", "modules", "lib")}\n`);

  assert.equal((await resolveWorkspace(submodule, {})).workspace, "gitlab.com/acme/lib");
});

test("resolve: a .git file pointing nowhere degrades to the directory name, not a crash", async () => {
  const dir = await makeRepo("broken-gitdir", { git: false });
  await writeFile(join(dir, ".git"), "gitdir: /nowhere/at/all\n");
  const resolved = await resolveWorkspace(dir, {});
  assert.equal(resolved.workspace, "broken-gitdir");
  assert.equal(resolved.source, "git-root", "it is still a repo root, just one whose config is unreadable");
});

test("resolve: an unreadable .git/config degrades to the repo's directory name", async () => {
  const dir = await makeRepo("unreadable-config", { git: false });
  await mkdir(join(dir, ".git", "config"), { recursive: true }); // a directory where a file belongs
  const resolved = await resolveWorkspace(dir, {});
  assert.equal(resolved.workspace, "unreadable-config");
});

/**
 * The collision the `.docket.json` override exists for. Two unrelated projects that happen
 * to share a directory name, neither with a remote, resolve to the SAME workspace — items
 * from one appear in the other's list. That is the documented limitation, so it is pinned
 * here rather than left to be discovered, along with the way out.
 */
test("resolve: two projects sharing a basename collide, and .docket.json resolves it", async () => {
  const a = join(root, "clientA", "api");
  const b = join(root, "clientB", "api");
  await mkdir(join(a, ".git"), { recursive: true });
  await mkdir(join(b, ".git"), { recursive: true });
  await writeFile(join(a, ".git", "config"), "[core]\n");
  await writeFile(join(b, ".git", "config"), "[core]\n");

  assert.equal((await resolveWorkspace(a, {})).workspace, (await resolveWorkspace(b, {})).workspace, "precondition: they collide");

  await writeFile(join(b, WORKSPACE_CONFIG_FILE), '{"workspace":"clientB-api"}');
  assert.notEqual((await resolveWorkspace(a, {})).workspace, (await resolveWorkspace(b, {})).workspace);
  assert.equal((await resolveWorkspace(b, {})).workspace, "clientb-api");
});

test("resolve: the reported source names which rule actually fired, for every rule", async () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    [(await makeRepo("src-env", { remote: "git@x.com:a/b.git" })), { DOCKET_WORKSPACE: "chosen" }, "env"],
    [(await makeRepo("src-config", { remote: "git@x.com:a/b.git", config: '{"workspace":"c"}' })), {}, "config"],
    [(await makeRepo("src-remote", { remote: "git@x.com:a/b.git" })), {}, "git-remote"],
    [(await makeRepo("src-root")), {}, "git-root"],
  ];
  for (const [dir, env, expected] of cases) {
    assert.equal((await resolveWorkspace(dir, env)).source, expected, `${dir} reported the wrong rule`);
  }
});
