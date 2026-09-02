#!/usr/bin/env node
import { resolveDataDirectory } from "./data-dir.js";
import { execFile, type ExecFileException } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

function usage(): never {
  console.error("Usage: todo-mcp-setup [--data-dir PATH] [--yes]");
  process.exit(2);
}

export function parseDataDirectoryArg(args: string[]): string | undefined {
  const index = args.findIndex((arg) => arg === "--data-dir");
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("-")) usage();
  return value;
}

async function ask(rl: ReturnType<typeof createInterface>, question: string, fallback: string): Promise<string> {
  const answer = (await rl.question(`${question} [${fallback}] `)).trim();
  return answer || fallback;
}

async function askYesNo(rl: ReturnType<typeof createInterface>, question: string, fallback = true): Promise<boolean> {
  const answer = (await rl.question(`${question} [${fallback ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

async function installStatsIntegration(dataDirectory: string): Promise<void> {
  const configDir = `${homedir()}/.config/todo-mcp`;
  const integration = `${configDir}/stats.sh`;
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    integration,
    `# todo-mcp terminal helpers\n# Usage: todo_stats (or add it to your shell prompt/tmux status)\ntodo_stats() {\n  npx --yes --prefix /tmp --package=@pasichdev/todo-mcp todo-mcp stats\n}\nexport TODO_MCP_DATA_DIR=${JSON.stringify(dataDirectory)}\n`,
    { mode: 0o600 },
  );
  const shellRc = process.env.SHELL?.endsWith("zsh") ? `${homedir()}/.zshrc` : `${homedir()}/.bashrc`;
  let alreadySourced = false;
  try {
    const { readFile } = await import("node:fs/promises");
    alreadySourced = (await readFile(shellRc, "utf8")).includes(`source "${integration}"`);
  } catch { /* shell rc may not exist yet */ }
  if (!alreadySourced) await appendFile(shellRc, `\n# todo-mcp terminal stats\nsource "${integration}"\n`);
  console.log(`Installed todo_stats in ${integration} and sourced it from ${shellRc}.`);
}

async function installClaimSkill(): Promise<void> {
  try {
    const marketplace = await execFileAsync("claude", ["plugin", "marketplace", "add", "pasichDev/todo-mcp"]);
    if (marketplace.stdout) process.stdout.write(marketplace.stdout);
    if (marketplace.stderr) process.stderr.write(marketplace.stderr);
    const install = await execFileAsync("claude", ["plugin", "install", "todo-mcp-claim@todo-mcp"]);
    if (install.stdout) process.stdout.write(install.stdout);
    if (install.stderr) process.stderr.write(install.stderr);
    console.log("Installed the todo-mcp-claim Claude Code skill.");
  } catch (error) {
    const detail = error as ExecFileException;
    console.warn(`Could not install the skill automatically (${detail.message ?? "Claude Code not found"}).`);
    console.warn("Run these in Claude Code when it is available:");
    console.warn("  /plugin marketplace add pasichDev/todo-mcp");
    console.warn("  /plugin install todo-mcp-claim@todo-mcp");
  }
}

// ~/.agents/skills/<name>/SKILL.md is the shared, cross-agent convention (Codex CLI and
// other AGENTS.md-ecosystem tools read from it) — NOT ~/.codex/skills, which doesn't exist.
async function installAgentsSkill(): Promise<void> {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const source = join(packageRoot, "skills", "todo-mcp-claim");
  const destination = join(homedir(), ".agents", "skills", "todo-mcp-claim");
  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(source, destination, { recursive: true, force: true });
    console.log(`Installed the todo-mcp-claim skill at ${destination}.`);
  } catch (error) {
    // Most likely cause: running inside an agent sandbox that restricts writes to
    // $HOME outside the current workspace (e.g. Codex's default workspace-write mode).
    // That's an environment permission boundary, not something this command can force —
    // report it plainly instead of pretending to succeed.
    console.warn(
      `Could not install the skill at ${destination}: ${(error as Error).message}\n` +
        `  If this is running inside a sandboxed agent session, re-run with broader ` +
        `filesystem access, or copy skills/todo-mcp-claim from the package yourself.`,
    );
  }
}

async function commandExists(command: string): Promise<boolean> {
  try { await execFileAsync("which", [command]); return true; } catch { return false; }
}

async function configureHosts(dataDirectory: string): Promise<void> {
  const serverArgs = ["-y", "--prefix", "/tmp", "--package=@pasichdev/todo-mcp", "todo-mcp"];
  const envArg = `TODO_MCP_DATA_DIR=${dataDirectory}`;
  const configure = async (command: string, args: string[], label: string): Promise<void> => {
    try {
      const result = await execFileAsync(command, args);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      console.log(`Configured ${label}.`);
    } catch (error) {
      console.warn(`Skipped ${label}: ${(error as ExecFileException).message ?? "command failed"}`);
    }
  };
  if (await commandExists("codex")) {
    await execFileAsync("codex", ["mcp", "remove", "todo-mcp"]).catch(() => undefined);
    await configure("codex", ["mcp", "add", "todo-mcp", "--env", envArg, "--", "npx", ...serverArgs], "Codex");
  }
  if (await commandExists("claude")) {
    await execFileAsync("claude", ["mcp", "remove", "--scope", "user", "todo-mcp"]).catch(() => undefined);
    // `claude mcp add` takes the name as a bare positional right after "add" — -e/--env
    // is variadic (`-e KEY=v1 KEY2=v2 ...`) and swallows whatever non-flag tokens follow
    // it, so putting the name after -e makes it try to consume "todo-mcp" as a second
    // (invalid) env var instead of the server name.
    await configure("claude", ["mcp", "add", "todo-mcp", "--scope", "user", "-e", envArg, "--", "npx", ...serverArgs], "Claude Code MCP");
  }

  for (const target of [`${homedir()}/.cursor/mcp.json`, `${homedir()}/.codeium/windsurf/mcp_config.json`]) {
    try {
      const { dirname } = await import("node:path");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      let config: Record<string, unknown> = {};
      try { config = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>; } catch { /* new file */ }
      const servers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
      servers["todo-mcp"] = { command: "npx", args: serverArgs, env: { TODO_MCP_DATA_DIR: dataDirectory } };
      config.mcpServers = servers;
      await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      console.log(`Configured ${target}.`);
    } catch { /* host is not installed or config is not writable */ }
  }
}

// A human at a real terminal gets asked (and can decline); an agent driving this
// non-interactively gets everything attempted by default — "skip because nobody was
// there to answer a prompt" is indistinguishable from "silently do nothing," which is
// exactly the gap that left automated setups doing nothing but printing snippets.
// --yes forces the same always-attempt behavior even in an interactive terminal.
export function automationDefault(args: string[]): boolean {
  return !process.stdin.isTTY || args.includes("--yes") || args.includes("-y");
}

async function shouldAutomate(rl: ReturnType<typeof createInterface>, question: string, args: string[]): Promise<boolean> {
  if (automationDefault(args)) return true;
  return askYesNo(rl, question);
}

export async function runInteractiveSetup(args: string[] = process.argv.slice(3)): Promise<void> {
  const configured = parseDataDirectoryArg(args);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const defaultDirectory = configured ?? process.env.TODO_MCP_DATA_DIR ?? `${homedir()}/.todo-mcp`;
    const chosen = configured ?? (process.stdin.isTTY ? await ask(rl, "Shared durable data directory", defaultDirectory) : defaultDirectory);
    const environment = { ...process.env, TODO_MCP_DATA_DIR: chosen };
    const dataDirectory = await resolveDataDirectory({ environment, warn: (message) => process.stderr.write(message) });

    console.log(`\ntodo-mcp data directory: ${dataDirectory}`);
    if (await shouldAutomate(rl, "Configure detected MCP agents automatically?", args)) await configureHosts(dataDirectory);
    if (await shouldAutomate(rl, "Install the todo-mcp-claim skill for Claude Code?", args)) await installClaimSkill();
    if (await shouldAutomate(rl, "Install the todo-mcp-claim skill (Codex and other AGENTS.md-ecosystem agents)?", args)) await installAgentsSkill();
    if (await shouldAutomate(rl, "Install the todo_stats terminal helper and shell startup entry?", args)) await installStatsIntegration(dataDirectory);
    console.log("\nUse this same directory in every MCP host that should share the list:\n");
    console.log("Codex (config.toml):");
    console.log("[mcp_servers.todo-mcp.env]");
    console.log(`TODO_MCP_DATA_DIR = ${JSON.stringify(dataDirectory)}\n`);
    console.log("Claude Desktop / Cursor / Windsurf / Zed:");
    console.log(JSON.stringify({ env: { TODO_MCP_DATA_DIR: dataDirectory } }, null, 2));
    console.log("\nStart the server with: npx -y @pasichdev/todo-mcp");
  } finally {
    rl.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runInteractiveSetup(process.argv.slice(2)).catch((error) => {
    console.error(`todo-mcp setup failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
