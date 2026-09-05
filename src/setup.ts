#!/usr/bin/env node
import { resolveDataDirectory } from "./data-dir.js";
import { execFile, type ExecFileException } from "node:child_process";
import { appendFile, cp, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createLineReader, type LineReader } from "./cli-prompt.js";
import { writeDataDirectoryConfig, writeDeploymentConfig } from "./config.js";
import { isOnPath } from "./hooks/install.js";
import { getDeviceName } from "./device.js";
import { loadRemoteCredentials } from "./remote/credentials.js";
import { beginServerPairing, finishServerPairing, PairingError, probeServer } from "./remote/enrolment.js";
import { atomicWriteFile } from "./fs-atomic.js";

const execFileAsync = promisify(execFile);

function usage(): never {
  console.error("Usage: docket-setup [--data-dir PATH | --remote SERVER_URL] [--yes]");
  process.exit(2);
}

export function parseDataDirectoryArg(args: string[]): string | undefined {
  const index = args.findIndex((arg) => arg === "--data-dir");
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("-")) usage();
  return value;
}

/** Non-interactive/scripted path into the remote setup flow (RFC §11) — same idea as --data-dir for local mode. Optional: without it, an interactive terminal is asked instead. */
export function parseRemoteUrlArg(args: string[]): string | undefined {
  const index = args.findIndex((arg) => arg === "--remote");
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("-")) usage();
  return value;
}

async function installStatsIntegration(dataDirectory: string): Promise<void> {
  const configDir = `${homedir()}/.config/docket`;
  const integration = `${configDir}/stats.sh`;
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await atomicWriteFile(
    integration,
    `# docket terminal helpers\n# Usage: todo_stats (or add it to your shell prompt/tmux status)\ntodo_stats() {\n  npx --yes --prefix /tmp --package=@pasichdev/docket docket stats\n}\nexport DOCKET_DATA_DIR=${JSON.stringify(dataDirectory)}\n`,
  );
  const shellRc = process.env.SHELL?.endsWith("zsh") ? `${homedir()}/.zshrc` : `${homedir()}/.bashrc`;
  let alreadySourced = false;
  try {
    const { readFile } = await import("node:fs/promises");
    alreadySourced = (await readFile(shellRc, "utf8")).includes(`source "${integration}"`);
  } catch { /* shell rc may not exist yet */ }
  if (!alreadySourced) await appendFile(shellRc, `\n# docket terminal stats\nsource "${integration}"\n`);
  console.log(`Installed todo_stats in ${integration} and sourced it from ${shellRc}.`);
}

async function installSkill(): Promise<void> {
  try {
    const marketplace = await execFileAsync("claude", ["plugin", "marketplace", "add", "pasichDev/docket"]);
    if (marketplace.stdout) process.stdout.write(marketplace.stdout);
    if (marketplace.stderr) process.stderr.write(marketplace.stderr);
    const install = await execFileAsync("claude", ["plugin", "install", "docket@docket"]);
    if (install.stdout) process.stdout.write(install.stdout);
    if (install.stderr) process.stderr.write(install.stderr);
    console.log("Installed the docket Claude Code skill.");
  } catch (error) {
    const detail = error as ExecFileException;
    console.warn(`Could not install the skill automatically (${detail.message ?? "Claude Code not found"}).`);
    console.warn("Run these in Claude Code when it is available:");
    console.warn("  /plugin marketplace add pasichDev/docket");
    console.warn("  /plugin install docket@docket");
  }
}

// ~/.agents/skills/<name>/SKILL.md is the shared, cross-agent convention (Codex CLI and
// other AGENTS.md-ecosystem tools read from it) — NOT ~/.codex/skills, which doesn't exist.
async function installAgentsSkill(): Promise<void> {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const source = join(packageRoot, "skills", "docket");
  const destination = join(homedir(), ".agents", "skills", "docket");
  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(source, destination, { recursive: true, force: true });
    console.log(`Installed the docket skill at ${destination}.`);
  } catch (error) {
    // Most likely cause: running inside an agent sandbox that restricts writes to
    // $HOME outside the current workspace (e.g. Codex's default workspace-write mode).
    // That's an environment permission boundary, not something this command can force —
    // report it plainly instead of pretending to succeed.
    console.warn(
      `Could not install the skill at ${destination}: ${(error as Error).message}\n` +
        `  If this is running inside a sandboxed agent session, re-run with broader ` +
        `filesystem access, or copy skills/docket from the package yourself.`,
    );
  }
}

// Reuses the hook installer's PATH scan rather than shelling out to `which`, which costs a
// subprocess and does not exist on Windows.
const commandExists = isOnPath;

/**
 * Writes `env` (DOCKET_DATA_DIR for local mode, or DOCKET_MODE+DOCKET_SERVER_URL for
 * remote — RFC §11) into every detected MCP host's config. Generalized from a single
 * `dataDirectory` string so both deployment modes share one implementation instead of
 * setup.ts growing a second, near-identical host-configuration function for remote.
 */
/**
 * The exact package spec generated host configs should run.
 *
 * Bare `@pasichdev/docket` resolves to the `latest` dist-tag at the moment the agent starts.
 * For a release candidate — published under `next`, precisely so `latest` keeps pointing at
 * the last stable build — that means a user who ran the RC's own setup gets host configs
 * that launch the STABLE version instead: v2 code opening a v3 data directory and config,
 * with nothing anywhere saying so. Pinning the running version is the only invocation that
 * is true of the thing the user actually installed.
 */
export async function packageSpec(): Promise<string> {
  try {
    const { getCurrentVersion } = await import("./update.js");
    const version = await getCurrentVersion(fileURLToPath(import.meta.url));
    return `@pasichdev/docket@${version}`;
  } catch {
    // No package.json above this file (an unusual install layout): an unpinned spec is still
    // better than failing setup outright, and it is what every pre-3.0 install already used.
    return "@pasichdev/docket";
  }
}

/** The exact invocation written into every host config — one function, so what the tests check is what the hosts get. */
export function hostInvocation(spec: string, env: Record<string, string>): { command: string; args: string[]; env: Record<string, string> } {
  return { command: "npx", args: ["-y", "--prefix", "/tmp", `--package=${spec}`, "docket"], env };
}

async function configureHosts(env: Record<string, string>): Promise<void> {
  const serverArgs = hostInvocation(await packageSpec(), env).args;
  const envPairs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
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
    await execFileAsync("codex", ["mcp", "remove", "docket"]).catch(() => undefined);
    const codexEnvArgs = envPairs.flatMap((pair) => ["--env", pair]);
    await configure("codex", ["mcp", "add", "docket", ...codexEnvArgs, "--", "npx", ...serverArgs], "Codex");
  }
  if (await commandExists("claude")) {
    await execFileAsync("claude", ["mcp", "remove", "--scope", "user", "docket"]).catch(() => undefined);
    // `claude mcp add` takes the name as a bare positional right after "add" — -e/--env
    // is variadic (`-e KEY=v1 KEY2=v2 ...`) and swallows whatever non-flag tokens follow
    // it, so putting the name after -e makes it try to consume "docket" as a second
    // (invalid) env var instead of the server name.
    await configure("claude", ["mcp", "add", "docket", "--scope", "user", "-e", ...envPairs, "--", "npx", ...serverArgs], "Claude Code MCP");
  }

  for (const target of [`${homedir()}/.cursor/mcp.json`, `${homedir()}/.codeium/windsurf/mcp_config.json`]) {
    try {
      const { dirname } = await import("node:path");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      let config: Record<string, unknown> = {};
      try { config = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>; } catch { /* new file */ }
      const servers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
      servers["docket"] = { command: "npx", args: serverArgs, env };
      config.mcpServers = servers;
      // Read-modify-write of a config that already holds the user's other MCP servers.
      await atomicWriteFile(target, `${JSON.stringify(config, null, 2)}\n`);
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

async function shouldAutomate(reader: LineReader, question: string, args: string[]): Promise<boolean> {
  if (automationDefault(args)) return true;
  return reader.askYesNo(question, true);
}

/** RFC §11: "Where should docket keep your workspace? > Local on this device / Self-hosted docket server". Non-interactive/automated runs (no TTY, --yes) default to local — unless --remote was explicitly given — so scripted setups keep today's zero-config local behaviour instead of unexpectedly needing a pairing code. */
async function askDeploymentChoice(reader: LineReader, args: string[]): Promise<"local" | "remote"> {
  if (parseRemoteUrlArg(args) !== undefined) return "remote";
  if (automationDefault(args)) return "local";
  console.log("\nWhere should docket keep your workspace?\n");
  console.log("  1) Local on this device");
  console.log("  2) Self-hosted docket server\n");
  const answer = (await reader.next("Choice [1]: ")).trim();
  return answer === "2" ? "remote" : "local";
}

async function runLocalSetup(reader: LineReader, args: string[]): Promise<void> {
  const configured = parseDataDirectoryArg(args);
  const defaultDirectory = configured ?? process.env.DOCKET_DATA_DIR ?? `${homedir()}/.docket`;
  const chosen = configured ?? (process.stdin.isTTY ? await reader.ask("Shared durable data directory", defaultDirectory) : defaultDirectory);
  const environment = { ...process.env, DOCKET_DATA_DIR: chosen };
  const dataDirectory = await resolveDataDirectory({ environment, warn: (message) => process.stderr.write(message) });

  console.log(`\ndocket data directory: ${dataDirectory}`);
  // Written to ~/.config/docket/config.json, not only into each host's env. A directory that
  // exists only in the hosts' configs and a shell rc is invisible to a plain terminal, so
  // `docket backup` in one backed up an empty ~/.docket and reported success.
  await writeDataDirectoryConfig(dataDirectory);
  await writeDeploymentConfig({ mode: "local" });
  if (await shouldAutomate(reader, "Configure detected MCP agents automatically?", args)) await configureHosts({ DOCKET_DATA_DIR: dataDirectory });
  if (await shouldAutomate(reader, "Install the docket skill for Claude Code?", args)) await installSkill();
  if (await shouldAutomate(reader, "Install the docket skill (Codex and other AGENTS.md-ecosystem agents)?", args)) await installAgentsSkill();
  if (await shouldAutomate(reader, "Install the todo_stats terminal helper and shell startup entry?", args)) await installStatsIntegration(dataDirectory);
  console.log("\nUse this same directory in every MCP host that should share the list:\n");
  console.log("Codex (config.toml):");
  console.log("[mcp_servers.docket.env]");
  console.log(`DOCKET_DATA_DIR = ${JSON.stringify(dataDirectory)}\n`);
  console.log("Claude Desktop / Cursor / Windsurf / Zed:");
  console.log(JSON.stringify({ env: { DOCKET_DATA_DIR: dataDirectory } }, null, 2));
  console.log("\nStart the server with: npx -y @pasichdev/docket");
}

/**
 * Looks at what is already on this device before its source of truth is switched away, and
 * refuses to proceed until the user has actually chosen what happens to it.
 *
 * Returns false when the user cancelled — the caller must then change nothing at all.
 */
async function offerLocalWorkspaceTransition(reader: LineReader, serverUrl: string, args: string[]): Promise<boolean> {
  const { readStore } = await import("./storage.js");
  const { LocalTodoRepository } = await import("./repository.js");
  const { transferWorkspace, stopLocalDaemon } = await import("./backend.js");

  const local = await readStore();
  if (local.todos.length === 0) {
    await stopLocalDaemon();
    return true;
  }

  const completed = local.todos.filter((t) => t.done).length;
  console.log(`\nThis device already has a local workspace: ${local.todos.length} todo(s), ${completed} completed.`);
  console.log("Switching to a server does not delete it, but it does stop being what docket shows you.\n");

  if (automationDefault(args)) {
    // Non-interactive: never guess. Uploading someone's workspace to a server they have
    // just paired with is not a decision a --yes flag can stand in for, and neither is
    // hiding it. Stop, and name both commands that resolve it.
    console.error("Refusing to switch modes non-interactively while this device has local data.");
    console.error("Run `docket backend use <serverUrl>` to choose explicitly (upload, or keep local data and use the server anyway).");
    process.exitCode = 1;
    return false;
  }

  const answer = (await reader.next("  1) Upload it to the server\n  2) Use the server, leave the local workspace where it is\n  3) Cancel\nChoice [3]: ")).trim();
  if (answer === "1") {
    const remote = await remoteRepositoryFor(serverUrl);
    if (!remote) return false;
    const existing = await remote.list({ filter: "all", list: "all" }).catch(() => null);
    if (existing === null) {
      console.error("Could not read the server's workspace — not switching modes.");
      process.exitCode = 1;
      return false;
    }
    if (existing.length > 0) {
      console.error("The server already has data. Merging two populated workspaces needs an explicit decision — run `docket backend use` instead.");
      process.exitCode = 1;
      return false;
    }
    try {
      const result = await transferWorkspace(new LocalTodoRepository(), remote);
      console.log(`Uploaded ${result.imported} todo(s), with project structure, history and item identities intact.`);
    } catch (err) {
      console.error(`Upload failed: ${(err as Error).message}`);
      console.error("Nothing was switched over. Run `docket setup --remote` again — the transfer resumes rather than duplicating what arrived.");
      process.exitCode = 1;
      return false;
    }
  } else if (answer !== "2") {
    console.log("Cancelled. Nothing was changed.");
    return false;
  }

  await stopLocalDaemon();
  return true;
}

async function remoteRepositoryFor(serverUrl: string) {
  const { RemoteTodoRepository } = await import("./remote/client.js");
  const { getDeviceId } = await import("./device.js");
  const creds = await loadRemoteCredentials();
  if (!creds || creds.serverUrl !== serverUrl) {
    console.error("Internal error: pairing reported success but no credentials for this server were saved.");
    process.exitCode = 1;
    return null;
  }
  return new RemoteTodoRepository({ serverUrl, deviceId: await getDeviceId(), deviceName: await getDeviceName(), secret: creds.secret });
}

/** RFC §11's remote branch — probe → (pair if not already) → write ~/.config/docket/config.json → configure hosts. Reuses remote/pairing.ts's exact building blocks `docket pair` already uses (Phase 2-3), rather than a second pairing implementation. */
async function runRemoteSetup(reader: LineReader, args: string[]): Promise<void> {
  const flagUrl = parseRemoteUrlArg(args);
  const serverUrl = (flagUrl ?? (await reader.ask("Server address", ""))).trim();
  if (!serverUrl) {
    console.error("Error: a server address is required.");
    process.exitCode = 1;
    return;
  }
  const allowInsecureRemote = process.env.DOCKET_ALLOW_INSECURE_REMOTE === "1" || process.env.DOCKET_ALLOW_INSECURE_REMOTE === "true";

  console.log("\nConnecting...\n");
  let probe: Awaited<ReturnType<typeof probeServer>>;
  try {
    probe = await probeServer(serverUrl, allowInsecureRemote);
  } catch (err) {
    console.error(`Error: ${err instanceof PairingError ? err.message : (err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  console.log("✓ Server reachable");
  console.log(`✓ docket server v${probe.serverVersion}`);
  console.log("✓ Protocol compatible");

  const existingCreds = await loadRemoteCredentials();
  if (existingCreds?.serverUrl === serverUrl) {
    console.log("\nThis device is already paired with this server.");
  } else {
    console.log("\nThis device is not paired.\n");
    // device.ts derives the name from the machine hostname on first run; there is no
    // separate rename operation yet (out of scope here — see the final report), so this
    // shows the identity that will actually be used rather than pretending it's editable.
    console.log(`Device name: ${await getDeviceName()}`);
    const code = (await reader.next("\nPairing code: ")).trim();
    if (!code) {
      console.error("Error: a pairing code is required.");
      process.exitCode = 1;
      return;
    }
    let step: Awaited<ReturnType<typeof beginServerPairing>>;
    try {
      step = await beginServerPairing(serverUrl, code, allowInsecureRemote);
    } catch (err) {
      console.error(`Error: ${err instanceof PairingError ? err.message : (err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nConfirmation code: ${step.sas} — verify this matches on the server before approving.`);
    console.log("\nWaiting for approval...");
    const result = await finishServerPairing(serverUrl, step);
    if (result.outcome !== "approved") {
      console.error(result.outcome === "denied" ? "Pairing was denied on the server." : "Timed out waiting for approval — the pairing code may have expired.");
      process.exitCode = 1;
      return;
    }
    console.log("\n✓ Device paired");
    console.log("✓ Connection authenticated");
    console.log("✓ Remote workspace ready");
  }

  /*
   * Pairing establishes trust. Switching which store this machine reads is a separate
   * decision, and it used to be made silently: setup wrote remote mode without ever looking
   * at the local store, so a user with a year of local todos ran `docket setup --remote`,
   * saw success, and found an empty workspace. The data was still on disk — it had simply
   * stopped being part of the product, with nothing saying so.
   */
  if (!(await offerLocalWorkspaceTransition(reader, serverUrl, args))) return;

  await writeDeploymentConfig({ mode: "remote", serverUrl });

  console.log("");
  /*
   * Deliberately NO deployment env in the generated host configs.
   *
   * The resolver's priority is env > config, so DOCKET_MODE baked into each host pinned that
   * host to remote for ever: `docket backend localize` would update the central config, say
   * "deployment mode set to local", and every agent would carry on talking to the server
   * because its own env still said otherwise. The user's only way out was to hand-edit four
   * host config files they never knew had been written.
   *
   * The central config is the source of truth. The env override still exists for a container
   * or a single command; setup just stops silently claiming it on the user's behalf.
   */
  if (await shouldAutomate(reader, "Configure detected MCP agents automatically?", args)) {
    await configureHosts({});
  }
  if (await shouldAutomate(reader, "Install the docket skill for Claude Code?", args)) await installSkill();
  if (await shouldAutomate(reader, "Install the docket skill (Codex and other AGENTS.md-ecosystem agents)?", args)) await installAgentsSkill();

  console.log(`\nRecorded in ~/.config/docket/config.json — every MCP host, CLI and dashboard on this machine reads it.`);
  console.log("Nothing further to paste into host configs; switch back at any time with `docket backend localize`.");
  console.log(`\nTo override for one command or one container only: DOCKET_MODE=remote DOCKET_SERVER_URL=${JSON.stringify(serverUrl)}`);
}

export async function runInteractiveSetup(args: string[] = process.argv.slice(3)): Promise<void> {
  const reader = createLineReader();
  try {
    const deployment = await askDeploymentChoice(reader, args);
    if (deployment === "remote") await runRemoteSetup(reader, args);
    else await runLocalSetup(reader, args);
  } finally {
    reader.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runInteractiveSetup(process.argv.slice(2)).catch((error) => {
    console.error(`docket setup failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
