#!/usr/bin/env node
import { resolveDataDirectory } from "./data-dir.js";
import { execFile, type ExecFileException } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

function usage(): never {
  console.error("Usage: todo-mcp-setup [--data-dir PATH]");
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
    await configure("claude", ["mcp", "add", "--scope", "user", "-e", envArg, "todo-mcp", "--", "npx", ...serverArgs], "Claude Code MCP");
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

export async function runInteractiveSetup(args: string[] = process.argv.slice(3)): Promise<void> {
  const configured = parseDataDirectoryArg(args);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const defaultDirectory = configured ?? process.env.TODO_MCP_DATA_DIR ?? `${homedir()}/.todo-mcp`;
    const chosen = configured ?? (await ask(rl, "Shared durable data directory", defaultDirectory));
    const environment = { ...process.env, TODO_MCP_DATA_DIR: chosen };
    const dataDirectory = await resolveDataDirectory({ environment, warn: (message) => process.stderr.write(message) });

    console.log(`\ntodo-mcp data directory: ${dataDirectory}`);
    if (process.stdin.isTTY && await askYesNo(rl, "Configure detected MCP agents automatically?")) await configureHosts(dataDirectory);
    if (process.stdin.isTTY && await askYesNo(rl, "Install the optional todo-mcp-claim skill for Claude Code?")) await installClaimSkill();
    if (process.stdin.isTTY && await askYesNo(rl, "Install the todo_stats terminal helper and shell startup entry?")) await installStatsIntegration(dataDirectory);
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
