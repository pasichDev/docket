import { randomUUID } from "node:crypto";
import { mkdir as createDirectory, open, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type MakeDirectory = (path: string, options: { recursive: true; mode: number }) => Promise<string | undefined>;
type InspectDirectory = (path: string) => Promise<unknown>;
type ProbeDirectory = (path: string) => Promise<void>;

export interface ResolveDataDirectoryOptions {
  /** Environment values to use instead of process.env; useful for embedders and tests. */
  environment?: NodeJS.ProcessEnv;
  /** Home directory to use instead of the current user's home directory. */
  homeDirectory?: string;
  /** Directory creation operation to use instead of Node's default. */
  mkdir?: MakeDirectory;
  /** Directory inspection operation to use instead of Node's default. */
  inspect?: InspectDirectory;
  /** Write-capability check to use instead of Node's default. */
  probe?: ProbeDirectory;
  /** Called if the legacy directory cannot be used and a fallback succeeds. */
  warn?: (message: string) => void;
}

const ACCESS_STYLE_ERRORS = new Set(["EACCES", "ENOENT", "EPERM", "EROFS"]);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isAccessStyleError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && ACCESS_STYLE_ERRORS.has(code);
}

function configurationError(message: string): Error {
  return new Error(`${message} Set TODO_MCP_DATA_DIR to a writable durable directory.`);
}

/** Confirm the chosen directory accepts owner-only files, not merely mkdir calls. */
async function verifyWriteAccess(directory: string): Promise<void> {
  const probePath = join(directory, `.todo-mcp-write-probe-${process.pid}-${randomUUID()}`);
  const handle = await open(probePath, "wx", 0o600);
  try {
    await handle.close();
    await rm(probePath);
  } catch (error) {
    await rm(probePath, { force: true }).catch(() => {});
    throw error;
  }
}

async function legacyExists(path: string, inspect: InspectDirectory): Promise<boolean> {
  try {
    await inspect(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    if (isAccessStyleError(error)) {
      throw configurationError(`todo-mcp: cannot inspect existing legacy state at ${path}.`);
    }
    throw error;
  }
}

async function makeUsable(directory: string, mkdir: MakeDirectory, probe: ProbeDirectory): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await probe(directory);
}

/**
 * Finds and creates the directory used for todo-mcp's local state.
 *
 * Existing installations retain ~/.todo-mcp. Automatic migration to a second
 * location is only safe when an operator has explicitly supplied
 * XDG_STATE_HOME; cache directories are never used for authoritative state.
 */
export async function resolveDataDirectory(options: ResolveDataDirectoryOptions = {}): Promise<string> {
  const environment = options.environment ?? process.env;
  const mkdir = options.mkdir ?? createDirectory;
  const inspect = options.inspect ?? stat;
  const probe = options.probe ?? verifyWriteAccess;
  const explicitDirectory = environment.TODO_MCP_DATA_DIR;

  if (explicitDirectory) {
    await makeUsable(explicitDirectory, mkdir, probe);
    return explicitDirectory;
  }

  const homeDirectory = options.homeDirectory ?? homedir();
  const legacyDirectory = join(homeDirectory, ".todo-mcp");
  const legacyWasPresent = await legacyExists(legacyDirectory, inspect);
  const stateDirectory = environment.XDG_STATE_HOME
    ? join(environment.XDG_STATE_HOME, "todo-mcp")
    : undefined;
  const candidates = [legacyDirectory, stateDirectory]
    .filter((directory): directory is string => directory !== undefined)
    .filter((directory, index, all) => all.findIndex((other) => resolve(other) === resolve(directory)) === index);
  const failures: Array<{ directory: string; error: unknown }> = [];

  for (const directory of candidates) {
    try {
      await makeUsable(directory, mkdir, probe);
      if (directory !== legacyDirectory) {
        options.warn?.(
          `todo-mcp: cannot use ${legacyDirectory}; using operator-configured XDG_STATE_HOME at ${directory} for local state\n`,
        );
      }
      return directory;
    } catch (error) {
      if (!isAccessStyleError(error)) throw error;
      // Recheck after an access failure: the directory may have appeared between
      // the initial inspection and mkdir/probe, and falling back then would split
      // an existing store from its key.
      if (directory === legacyDirectory && (legacyWasPresent || await legacyExists(legacyDirectory, inspect))) {
        throw configurationError(`todo-mcp: existing legacy state at ${legacyDirectory} is not writable.`);
      }
      failures.push({ directory, error });
    }
  }

  const attempted = failures.map(({ directory }) => directory).join(", ") || legacyDirectory;
  throw configurationError(`todo-mcp: no writable durable data directory is available (tried ${attempted}).`);
}

// Resolve once per process. Apart from keeping every persistent file together, this
// prevents a later environment mutation from splitting one server's state between
// two directories.
let processDataDirectory: Promise<string> | undefined;

/** Resolve the data directory using this process's environment. */
export function getDataDirectory(): Promise<string> {
  processDataDirectory ??= resolveDataDirectory({
    warn: (message) => process.stderr.write(message),
  });
  return processDataDirectory;
}

/** Return a path inside this process's resolved data directory. */
export async function dataPath(filename: string): Promise<string> {
  return join(await getDataDirectory(), filename);
}
