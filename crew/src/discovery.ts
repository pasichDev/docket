import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { RuntimeCapabilities, RuntimeDetection, RuntimeId } from "./types.js";

/**
 * Real detection of the three runtimes (spec §5): find the binary on PATH, run `--version`,
 * and probe capabilities from the actual `--help` output of the installed binary — never
 * assumed from a version number. The flag names probed for are the ones proven by real runs
 * in docs/RUNTIME-CONTRACTS.md.
 */

const execFileP = promisify(execFile);

async function runCommand(exe: string, args: string[], timeoutMs = 10_000): Promise<{ stdout: string; stderr: string }> {
  // shell:false always (spec §30); stdin ignored so codex-style "waiting on stdin" can't hang us.
  return execFileP(exe, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
}

/** PATH scan, no shell. An explicit path (contains a separator) is checked directly. */
export async function findOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const check = async (candidate: string) => {
    try {
      await access(candidate, constants.X_OK);
      return (await stat(candidate)).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes("/")) {
    const abs = resolve(cmd);
    return (await check(abs)) ? abs : null;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    if (await check(candidate)) return candidate;
  }
  return null;
}

export async function detectRuntime(id: RuntimeId): Promise<RuntimeDetection> {
  const executable = await findOnPath(id);
  if (!executable) return { id, installed: false, error: `"${id}" not found on PATH` };
  try {
    const { stdout, stderr } = await runCommand(executable, ["--version"]);
    const version = (stdout || stderr).trim().split("\n")[0]?.trim();
    return { id, installed: true, executable, version };
  } catch (err) {
    return { id, installed: false, executable, error: `\`${id} --version\` failed: ${(err as Error).message}` };
  }
}

/**
 * Probe what the installed binary can actually do by reading its own help text.
 *
 * claude: top-level help carries the print-mode flags. codex: the non-interactive surface
 * lives under `codex exec`, so that subcommand's help is what gets probed. opencode: same,
 * under `opencode run`.
 */
export async function probeCapabilities(id: RuntimeId, executable: string): Promise<RuntimeCapabilities> {
  const helpArgs: Record<RuntimeId, string[]> = {
    claude: ["--help"],
    codex: ["exec", "--help"],
    opencode: ["run", "--help"],
  };
  let help = "";
  try {
    const { stdout, stderr } = await runCommand(executable, helpArgs[id]);
    help = stdout + "\n" + stderr;
  } catch (err) {
    // Help refusing to print means nothing can be assumed — report everything false rather
    // than guessing (spec §5).
    void err;
    return {
      nonInteractive: false,
      structuredOutput: false,
      resume: false,
      workingDirectoryFlag: false,
      modelSelection: false,
      providerSelection: false,
    };
  }
  const has = (flag: string) => help.includes(flag);
  switch (id) {
    case "claude":
      return {
        nonInteractive: has("--print"),
        structuredOutput: has("--output-format"),
        resume: has("--resume"),
        // claude has no cwd flag — it inherits the child process cwd (adapters spawn with {cwd}).
        workingDirectoryFlag: false,
        modelSelection: has("--model"),
        providerSelection: false,
      };
    case "codex":
      return {
        nonInteractive: true, // `codex exec --help` answered, so the subcommand exists
        structuredOutput: has("--json"),
        resume: has("resume") || (await subcommandExists(executable, ["exec", "resume", "--help"])),
        workingDirectoryFlag: has("--cd"),
        modelSelection: has("--model"),
        providerSelection: false,
      };
    case "opencode":
      return {
        nonInteractive: true, // `opencode run --help` answered
        structuredOutput: has("--format"),
        resume: has("--session") || has("--continue"),
        workingDirectoryFlag: has("--dir"),
        modelSelection: has("--model"),
        // opencode's -m takes provider/model — its help says so explicitly.
        providerSelection: has("provider/model") || has("--model"),
      };
  }
}

async function subcommandExists(executable: string, args: string[]): Promise<boolean> {
  try {
    await runCommand(executable, args);
    return true;
  } catch {
    return false;
  }
}

export interface DetectedRuntime extends RuntimeDetection {
  capabilities?: RuntimeCapabilities;
}

export async function detectAllRuntimes(): Promise<Record<RuntimeId, DetectedRuntime>> {
  const ids: RuntimeId[] = ["claude", "codex", "opencode"];
  const detections = await Promise.all(
    ids.map(async (id): Promise<DetectedRuntime> => {
      const detection = await detectRuntime(id);
      if (!detection.installed || !detection.executable) return detection;
      return { ...detection, capabilities: await probeCapabilities(id, detection.executable) };
    }),
  );
  return Object.fromEntries(detections.map((d) => [d.id, d])) as Record<RuntimeId, DetectedRuntime>;
}

/** Providers OpenCode can route through, for `docket-crew doctor` (spec §5 example output). */
export async function listOpencodeProviders(executable: string): Promise<string[]> {
  try {
    const { stdout, stderr } = await runCommand(executable, ["providers", "list"], 20_000);
    const text = (stdout + "\n" + stderr).replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI colour
    const providers: string[] = [];
    for (const line of text.split("\n")) {
      const match = /^[│\s]*[●○]\s+(.+?)(?:\s{2,}|\s+api\b|$)/u.exec(line.trim().replace(/^[│|]\s*/, ""));
      if (match && match[1].trim()) providers.push(match[1].trim());
    }
    return providers;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Docket Core detection
// ---------------------------------------------------------------------------

export interface DocketDetection {
  /** Absolute path of the `docket` CLI when installed on PATH. */
  cli: string | null;
  /** Whether a Docket web server answered on the given port. */
  webReachable: boolean;
  webUrl: string;
}

export async function detectDocket(port = Number(process.env.DOCKET_WEB_PORT ?? 8787)): Promise<DocketDetection> {
  const cli = await findOnPath("docket");
  const webUrl = `http://127.0.0.1:${port}`;
  let webReachable = false;
  try {
    const res = await fetch(webUrl + "/", { signal: AbortSignal.timeout(1500) });
    webReachable = res.status > 0;
  } catch {
    webReachable = false;
  }
  return { cli, webReachable, webUrl };
}

// ---------------------------------------------------------------------------
// Workspace resolution — the same rules as Docket Core's src/workspace.ts.
//
// Deliberately REPLICATED, not imported and not shelled out: importing across the package
// boundary is forbidden (Crew must not reach into Docket Core's dist), and the `docket` CLI
// is not reliably on PATH (it isn't on this machine — proven during development). The rule
// set below is Core's documented, stable contract: env → .docket.json → git remote →
// git-root basename → cwd basename → null. If Core ever changes these rules, this copy must
// follow — the whole point is that Crew and Core name the same checkout identically.
// ---------------------------------------------------------------------------

export type WorkspaceSource = "env" | "config" | "git-remote" | "git-root" | "cwd" | "none";

export interface WorkspaceResolution {
  workspace: string | null;
  source: WorkspaceSource;
  root: string | null;
}

export function slugifyWorkspace(raw: string): string | null {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\/{2,}/g, "/");
  return slug || null;
}

export function normalizeGitRemote(url: string): string | null {
  const trimmed = url.trim().replace(/\.git\/?$/, "");
  if (!trimmed) return null;
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
  const parts = host ? [host, ...segments] : segments.slice(-2);
  return slugifyWorkspace(parts.join("/"));
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

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
    // No commondir: already the real git directory.
  }
  return join(gitDir, "config");
}

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
    const parsed = JSON.parse(await readFile(join(root, ".docket.json"), "utf8")) as { workspace?: unknown };
    return typeof parsed.workspace === "string" ? parsed.workspace : null;
  } catch {
    return null;
  }
}

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
