import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLineReader } from "../cli-prompt.js";
import { atomicWriteFile } from "../fs-atomic.js";

/**
 * How an entry is recognised as ours — and nothing else is ever touched.
 *
 * It has to be the ARGUMENTS, not the word "docket": the command is written either as
 * `docket hook claude session-start` or, when docket isn't on PATH, as an absolute
 * interpreter + launcher path that contains no such word. Matching the executable would
 * mean `uninstall` and `doctor` couldn't recognise entries `install` had just written.
 */
const OWNED_COMMAND_MARKER = "hook claude session-start";

/**
 * Above this, the hook is worth turning off rather than tolerating.
 *
 * The budget that matters is the REQUEST — a loopback call to an already-running server,
 * which lands in single-digit milliseconds. What `doctor` measures is the whole command,
 * and most of that is Node's own process startup, which no hook implemented as a command
 * can avoid. So this threshold is set where a person actually notices a session pausing,
 * not at the request budget, and the point of reporting it is to make the escape hatch
 * findable at the moment someone is wondering why sessions feel slow.
 */
const HOOK_SLOW_MS = 250;

/**
 * The command written into settings.json.
 *
 * `docket hook …` only works if `docket` is actually on PATH, and the documented quick
 * start installs via `npx`, which puts nothing there. A hook whose executable doesn't
 * exist fails open in the sense that nothing breaks — and never works, silently, which is
 * the failure this tool is least able to notice about itself. So: use the short form when
 * it will resolve, and otherwise pin the interpreter and this launcher by absolute path.
 *
 * The absolute form is the more fragile of the two if the install later moves, which is
 * why it isn't the default and why `install` says out loud when it had to use it.
 */
export async function sessionStartCommand(): Promise<{ command: string | null; onPath: boolean; reason?: string }> {
  const launcher = fileURLToPath(new URL("../launcher.js", import.meta.url));

  // Checked BEFORE the PATH lookup, deliberately. `npx` puts the package's binaries on PATH
  // for the duration of its own invocation, so `docket` resolves here and then does not
  // exist when Claude Code actually runs the hook — and npm is free to evict the cache
  // anyway. Either way we would be writing a command into long-lived user config whose
  // lifetime is shorter than the config's, and the failure mode is a hook that quietly
  // stops firing: exactly what this tool is least able to notice about itself.
  if (/[\\/]_npx[\\/]/.test(launcher)) {
    return {
      command: null,
      onPath: false,
      reason:
        "this copy of docket is running from npm's npx cache, which exists only for this command.\n" +
        "Install it properly first, then run this again:\n\n  npm install -g @pasichdev/docket",
    };
  }

  if (await isOnPath("docket")) return { command: `docket ${OWNED_COMMAND_MARKER}`, onPath: true };
  return { command: `"${process.execPath}" "${launcher}" ${OWNED_COMMAND_MARKER}`, onPath: false };
}

/** Deliberately a PATH scan rather than shelling out to `which`/`where` — one fewer subprocess, and it behaves the same on both. */
export async function isOnPath(name: string): Promise<boolean> {
  const entries = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const candidates = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const dir of entries) {
    for (const candidate of candidates) {
      try {
        await access(join(dir, candidate), constants.X_OK);
        return true;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return false;
}

/**
 * The always-on snippet `install` offers to append to CLAUDE.md / AGENTS.md.
 *
 * Under 40 tokens, and that ceiling is the point: this text is in context for every turn of
 * every session, so it buys its place only by being shorter than the confusion it prevents.
 * Everything else — fields, workspace scoping, the claim workflow — lives in the skill, which
 * loads only when an agent actually reaches for the tools.
 */
export const ALWAYS_ON_SNIPPET =
  "Docket is one shared list across your tools and projects. Capture anything worth not " +
  "forgetting — it files under the current project automatically.";

interface HookEntry {
  type?: string;
  command?: string;
}
interface HookMatcher {
  matcher?: string;
  hooks?: HookEntry[];
}
interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

export function settingsPath(scope: "project" | "global", cwd: string = process.cwd()): string {
  return scope === "global" ? join(homedir(), ".claude", "settings.json") : join(cwd, ".claude", "settings.json");
}

async function readSettings(path: string): Promise<{ settings: ClaudeSettings; existed: boolean }> {
  try {
    return { settings: JSON.parse(await readFile(path, "utf8")) as ClaudeSettings, existed: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, existed: false };
    // Refusing to touch a file we can't parse is the only safe move: this file holds the
    // user's OWN hooks, and rewriting it from a partial understanding would eat them.
    throw new Error(`docket: ${path} exists but isn't valid JSON — fix or move it, then run this again.`);
  }
}

function ownsEntry(entry: HookEntry): boolean {
  return typeof entry.command === "string" && entry.command.includes(OWNED_COMMAND_MARKER);
}

/**
 * Merges the SessionStart hook into whatever is already there.
 *
 * Never overwrites: people already have their own hooks in this file, and an installer that
 * replaces the block is an installer that silently deletes someone's work. Idempotent for
 * the same reason — running it twice, or after an upgrade, must not stack duplicate entries.
 */
export function addSessionStartHook(settings: ClaudeSettings, command: string): ClaudeSettings {
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const existing = next.hooks!.SessionStart ?? [];
  if (existing.some((matcher) => (matcher.hooks ?? []).some(ownsEntry))) return next; // already ours
  next.hooks!.SessionStart = [...existing, { hooks: [{ type: "command", command }] }];
  return next;
}

/** Removes only entries this tool owns, leaving every other hook — and every other event — exactly as it was. */
export function removeDocketHooks(settings: ClaudeSettings): ClaudeSettings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookMatcher[]> = {};
  for (const [event, matchers] of Object.entries(settings.hooks)) {
    const kept = matchers
      .map((matcher) => ({ ...matcher, hooks: (matcher.hooks ?? []).filter((entry) => !ownsEntry(entry)) }))
      .filter((matcher) => (matcher.hooks ?? []).length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  const next: ClaudeSettings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

/**
 * A minimal added/removed diff of the two serialisations — enough to answer the only
 * question that matters before writing to someone's config: what is about to change?
 *
 * Structural punctuation is dropped, because a naive line diff of reindented JSON reports
 * a stray `},` as a change and buries the one line the reader actually needs to see.
 */
export function diffLines(before: string, after: string): string {
  const meaningful = (line: string) => /[A-Za-z0-9]/.test(line);
  const beforeLines = new Set(before.split("\n"));
  const afterLines = new Set(after.split("\n"));
  const added = after.split("\n").filter((l) => !beforeLines.has(l) && meaningful(l));
  const removed = before.split("\n").filter((l) => !afterLines.has(l) && meaningful(l));
  return [...removed.map((l) => `- ${l.trim()}`), ...added.map((l) => `+ ${l.trim()}`)].join("\n");
}

/**
 * settings.json is the user's, not ours, and this is a read-modify-write of it: a bare
 * writeFile truncates first, so a crash between the truncate and the last byte leaves them
 * with an empty or half-written Claude settings file — every hook, permission and MCP entry
 * gone, from a command that only meant to add one hook.
 */
async function writeSettings(path: string, settings: ClaudeSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, `${JSON.stringify(settings, null, 2)}\n`, 0o644);
}

/**
 * The shared shape of both commands: read, transform, show what would change, ask, write.
 * They were two copies and had already drifted on one message; the only genuine differences
 * are the transform and what is printed afterwards.
 */
async function editSettings(
  args: string[],
  step: {
    transform: (settings: ClaudeSettings) => ClaudeSettings;
    requireExisting?: boolean;
    unchanged: string;
    done: (path: string) => void;
  },
): Promise<void> {
  const path = settingsPath(args.includes("--global") ? "global" : "project");
  const { settings, existed } = await readSettings(path);
  if (step.requireExisting && !existed) {
    console.log(`No ${path} — nothing to uninstall.`);
    return;
  }

  const before = JSON.stringify(settings, null, 2);
  const after = JSON.stringify(step.transform(settings), null, 2);
  if (before === after) {
    console.log(`${step.unchanged} in ${path} — nothing to change.`);
    return;
  }

  console.log(`${existed ? "Updating" : "Creating"} ${path}:\n`);
  console.log(diffLines(before, after));
  console.log("");
  const reader = createLineReader();
  let approved: boolean;
  try {
    approved = await reader.askYesNo("Write this?", false);
  } finally {
    reader.close();
  }
  if (!approved) {
    console.log("Nothing written.");
    return;
  }
  await writeSettings(path, JSON.parse(after) as ClaudeSettings);
  step.done(path);
}

export async function runHookInstall(args: string[]): Promise<void> {
  const { command, onPath, reason } = await sessionStartCommand();
  if (!command) {
    console.error(`Can't install a durable hook: ${reason}`);
    process.exitCode = 1;
    return;
  }
  await editSettings(args, {
    transform: (settings) => addSessionStartHook(settings, command),
    unchanged: "Already installed",
    done: () => {
      console.log(`Installed. Claude Code will run \`${command}\` when a session starts in this project.`);
      if (!onPath) {
        console.log("");
        console.log("Note: `docket` isn't on your PATH, so the hook is pinned to this exact install.");
        console.log("      Run `npm install -g @pasichdev/docket` and re-run this to use the short, portable form.");
      }
      console.log("");
      console.log("Optionally add this to your CLAUDE.md / AGENTS.md so agents know the list exists:\n");
      console.log(`  ${ALWAYS_ON_SNIPPET}`);
    },
  });
}

export async function runHookUninstall(args: string[]): Promise<void> {
  await editSettings(args, {
    transform: removeDocketHooks,
    requireExisting: true,
    unchanged: "No docket hooks",
    done: () => console.log("Removed docket's hook entries. Your other hooks were left alone."),
  });
}

/**
 * Proves the hook actually fires end to end.
 *
 * It runs the command as it is written in settings.json, through a shell, exactly as Claude
 * Code would — not the hook function in-process. That distinction is the whole point: the
 * single most likely thing to be wrong is that the configured executable isn't on PATH, and
 * an in-process check is structurally incapable of noticing it.
 */
export async function runHookDoctor(): Promise<void> {
  const { resolveWorkspace } = await import("../workspace.js");
  const { spawn } = await import("node:child_process");

  let configured: string | null = null;
  for (const scope of ["project", "global"] as const) {
    const path = settingsPath(scope);
    const { settings, existed } = await readSettings(path).catch(() => ({ settings: {} as ClaudeSettings, existed: false }));
    const owned = Object.values(settings.hooks ?? {})
      .flat()
      .flatMap((m) => m.hooks ?? [])
      .find(ownsEntry);
    configured ??= owned?.command ?? null;
    console.log(`${scope.padEnd(8)} ${path}: ${!existed ? "no settings file" : owned ? "hook installed" : "no docket hook"}`);
  }

  const { workspace, source } = await resolveWorkspace(process.cwd());
  console.log(`workspace ${workspace ?? "(unfiled)"} — resolved via ${source}`);

  if (!configured) {
    const { command, reason } = await sessionStartCommand();
    console.log(command ? `\nNot installed here. \`docket hook install\` would add: ${command}` : `\nNot installed here, and cannot be: ${reason}`);
    return;
  }
  if (process.env.DOCKET_HOOKS === "off") {
    console.log("DOCKET_HOOKS=off — the hook will exit silently. Unset it to re-enable.");
    return;
  }

  const started = Date.now();
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(configured!, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => resolve({ code: null, stdout: "", stderr: err.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    // A command that can't start never reads its stdin, and the write then raises EPIPE on
    // an unhandled 'error' event — which would crash the very tool whose job is to report
    // that failure calmly. Diagnosing a broken hook must not itself be a broken experience.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ cwd: process.cwd(), session_id: "doctor", hook_event_name: "SessionStart" }));
  });
  const elapsed = Date.now() - started;

  if (result.code !== 0) {
    console.log(`\ncommand  ${configured}`);
    console.log(`FAILED   exit ${result.code ?? "could not start"} after ${elapsed}ms${result.stderr ? ` — ${result.stderr.trim()}` : ""}`);
    console.log("         Claude Code would see this as a broken hook. Re-run `docket hook install` to repair the command.");
    return;
  }
  console.log(`command  ${configured}`);
  console.log(`ran in   ${elapsed}ms (includes Node startup, which any command hook pays)`);
  if (elapsed > HOOK_SLOW_MS) {
    console.log(`SLOW     over ${HOOK_SLOW_MS}ms — you would feel this at the start of every session.`);
    console.log(`         Turn it off without editing any config:  export DOCKET_HOOKS=off`);
    console.log(`         (the hook then exits silently; nothing else about docket changes)`);
  }
  if (!result.stdout.trim()) {
    console.log("output   none — either nothing is open in this project, or the docket web server isn't running (`docket web`).");
    return;
  }
  console.log(`\nWhat a session would see:\n${result.stdout.trimEnd()}`);
}
