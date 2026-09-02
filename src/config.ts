import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * DeploymentMode config system (RFC "Local and Self-Hosted Backend Modes" §10). Read once
 * at MCP/CLI startup to decide LocalTodoRepository vs RemoteTodoRepository — deliberately
 * NOT re-read mid-process (RFC §22: switching mode on the fly is exactly the kind of
 * silent-fallback behaviour that's prohibited).
 */

export type DeploymentMode = "local" | "remote";

export interface ConfigFileDeployment {
  mode: DeploymentMode;
  serverUrl?: string;
}

/** The on-disk shape of ~/.config/docket/config.json. */
export interface ConfigFile {
  version: number;
  deployment: ConfigFileDeployment;
  allowInsecureRemote?: boolean;
}

export interface DeploymentConfig {
  mode: DeploymentMode;
  /** Non-null whenever mode === "remote" (resolveDeploymentConfig guarantees this — see below). */
  serverUrl: string | null;
  allowInsecureRemote: boolean;
  /** Where `mode` actually came from — surfaced for `docket status` (RFC §33) and tests, never used to change behaviour. */
  source: "cli" | "env" | "config" | "default";
}

export class DeploymentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentConfigError";
  }
}

export interface ResolveDeploymentConfigOptions {
  /** Environment values to use instead of process.env; useful for tests and embedders — same pattern as data-dir.ts's ResolveDataDirectoryOptions. */
  environment?: NodeJS.ProcessEnv;
  /** Home directory to resolve ~/.config/docket against, instead of the real one. */
  homeDirectory?: string;
  /** CLI-supplied overrides — the highest-priority tier (RFC §10: "CLI > environment > config > defaults"). No `docket` entry point has flags for this yet (index.ts's MCP startup takes none), but the priority chain is implemented in full so one can be added without redoing this function. */
  cli?: { mode?: DeploymentMode; serverUrl?: string };
}

export function configFilePath(options: ResolveDeploymentConfigOptions = {}): string {
  const home = options.homeDirectory ?? homedir();
  return join(home, ".config", "docket", "config.json");
}

/** Null when there's no config file yet (the overwhelmingly common case — every existing install) — any other read/parse failure is a real error, not silently ignored, since guessing at a corrupt config could silently change which server a mutation lands on. */
async function loadConfigFile(path: string): Promise<ConfigFile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new DeploymentConfigError(`docket: cannot read ${path}: ${(err as Error).message}`);
  }
  let parsed: ConfigFile;
  try {
    parsed = JSON.parse(raw) as ConfigFile;
  } catch (err) {
    throw new DeploymentConfigError(`docket: ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed?.deployment?.mode !== "local" && parsed?.deployment?.mode !== "remote") {
    throw new DeploymentConfigError(`docket: ${path} has an invalid or missing deployment.mode (must be "local" or "remote")`);
  }
  return parsed;
}

function parseEnvMode(raw: string | undefined, source: string): DeploymentMode | undefined {
  if (raw === undefined) return undefined;
  if (raw === "local" || raw === "remote") return raw;
  throw new DeploymentConfigError(`docket: ${source}=${raw} is invalid — must be "local" or "remote"`);
}

/**
 * RFC §15: HTTPS is required for a non-localhost remote server unless the operator has
 * explicitly opted into HTTP via DOCKET_ALLOW_INSECURE_REMOTE / allowInsecureRemote.
 * Never silently downgrades or relaxes this — an invalid combination is a startup error,
 * not a warning, so a misconfigured install can't quietly send plaintext credentials.
 */
export function assertSecureRemoteUrl(serverUrl: string, allowInsecureRemote: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new DeploymentConfigError(`docket: "${serverUrl}" is not a valid server URL`);
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol !== "http:") {
    throw new DeploymentConfigError(`docket: server URL must be http:// or https://, got "${parsed.protocol}"`);
  }
  const bare = parsed.hostname.replace(/^\[|\]$/g, "");
  const isLoopback = bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
  if (isLoopback) return; // RFC §15 "Trusted LAN development" doesn't even require the opt-in for plain loopback
  if (allowInsecureRemote) return;
  throw new DeploymentConfigError(
    `docket: refusing an insecure http:// remote server URL ("${serverUrl}") — use https://, or set DOCKET_ALLOW_INSECURE_REMOTE=1 / config "allowInsecureRemote": true to opt in for trusted-LAN development (RFC §15). Never silently downgraded.`,
  );
}

/**
 * Resolves the effective deployment mode/server URL, per RFC §10's CLI > env > config >
 * defaults priority, evaluated independently per field. Existing installs have no config
 * file and no DOCKET_MODE/DOCKET_SERVER_URL — every field falls through to its default,
 * `mode: "local"`, so behaviour is unchanged (RFC's own compatibility goal, and this
 * project's `npm test` acceptance bar for Phase 0).
 */
export async function resolveDeploymentConfig(options: ResolveDeploymentConfigOptions = {}): Promise<DeploymentConfig> {
  const env = options.environment ?? process.env;
  const configFile = await loadConfigFile(configFilePath(options));

  const envMode = parseEnvMode(env.DOCKET_MODE, "DOCKET_MODE");
  const envServerUrl = env.DOCKET_SERVER_URL || undefined;
  const envAllowInsecure = env.DOCKET_ALLOW_INSECURE_REMOTE === "1" || env.DOCKET_ALLOW_INSECURE_REMOTE === "true";

  let mode: DeploymentMode;
  let source: DeploymentConfig["source"];
  if (options.cli?.mode !== undefined) {
    mode = options.cli.mode;
    source = "cli";
  } else if (envMode !== undefined) {
    mode = envMode;
    source = "env";
  } else if (configFile) {
    mode = configFile.deployment.mode;
    source = "config";
  } else {
    mode = "local";
    source = "default";
  }

  const serverUrl = options.cli?.serverUrl ?? envServerUrl ?? configFile?.deployment.serverUrl ?? null;
  const allowInsecureRemote = envAllowInsecure || configFile?.allowInsecureRemote === true;

  if (mode === "remote") {
    if (!serverUrl) {
      throw new DeploymentConfigError(
        `docket: deployment mode is "remote" but no server URL is configured — set deployment.serverUrl in ~/.config/docket/config.json or DOCKET_SERVER_URL`,
      );
    }
    assertSecureRemoteUrl(serverUrl, allowInsecureRemote);
  }

  return { mode, serverUrl: mode === "remote" ? serverUrl : null, allowInsecureRemote, source };
}

/**
 * Writes `deployment` into ~/.config/docket/config.json, preserving any other top-level
 * field already there (currently only `allowInsecureRemote`) — used by `docket setup`'s
 * remote flow and `docket backend use`/`localize` (Implementation Phase 4/Phase 6) to
 * switch modes without hand-rolling this read-merge-write in three places. Does not
 * validate the new deployment (e.g. does not re-run assertSecureRemoteUrl) — callers that
 * need that guarantee call resolveDeploymentConfig()/assertSecureRemoteUrl() themselves
 * before writing, same as `docket pair`'s existing flow already does.
 */
export async function writeDeploymentConfig(deployment: ConfigFileDeployment, options: ResolveDeploymentConfigOptions = {}): Promise<string> {
  const path = configFilePath(options);
  let existing: Partial<ConfigFile> = {};
  try {
    existing = JSON.parse(await readFile(path, "utf8")) as Partial<ConfigFile>;
  } catch {
    // No config file yet, or an unreadable one — start fresh rather than fail a mode switch
    // over a field (allowInsecureRemote) this function doesn't even require.
  }
  const next: ConfigFile = {
    version: 1,
    deployment,
    ...(existing.allowInsecureRemote !== undefined ? { allowInsecureRemote: existing.allowInsecureRemote } : {}),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return path;
}
