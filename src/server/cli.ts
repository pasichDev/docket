import { fileURLToPath } from "node:url";

interface ParsedArgs {
  host?: string;
  port?: string;
  dataDir?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--host") out.host = args[++i];
    else if (arg === "--port") out.port = args[++i];
    else if (arg === "--data-dir") out.dataDir = args[++i];
    else if (arg.startsWith("--host=")) out.host = arg.slice("--host=".length);
    else if (arg.startsWith("--port=")) out.port = arg.slice("--port=".length);
    else if (arg.startsWith("--data-dir=")) out.dataDir = arg.slice("--data-dir=".length);
  }
  return out;
}

/**
 * `docket serve` (RFC "Local and Self-Hosted Backend Modes" §9 / Implementation Phase 1).
 * Entry point invoked from launcher.ts BEFORE index.ts's stdio MCP server or any
 * storage-touching module is imported, so a --data-dir flag can still change where the
 * store resolves to (storage.ts reads DOCKET_DATA_DIR at module-load time via a top-level
 * await — setting it here, then dynamically importing everything below, is what makes the
 * flag (not just the env var) actually take effect).
 */
export async function runServeCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (parsed.dataDir) process.env.DOCKET_DATA_DIR = parsed.dataDir;

  // Priority CLI > env > default (RFC §10). The internal default is ALWAYS the 127.0.0.1
  // literal below — it only ever becomes something else (e.g. 0.0.0.0, "bind everywhere")
  // when the operator explicitly supplied --host or DOCKET_SERVER_HOST (RFC §9: "Binding to
  // all interfaces MUST require explicit configuration").
  const host = parsed.host ?? process.env.DOCKET_SERVER_HOST ?? "127.0.0.1";

  const portRaw = parsed.port ?? process.env.DOCKET_SERVER_PORT ?? "8788";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`docket serve: invalid port "${portRaw}" — must be an integer 0-65535`);
    process.exitCode = 1;
    return;
  }

  const { installProcessLogging, log } = await import("../log.js");
  const { getCurrentVersion } = await import("../update.js");
  const { startServeServer } = await import("./server.js");

  installProcessLogging("serve");
  const serverVersion = await getCurrentVersion(fileURLToPath(import.meta.url)).catch(() => "0.0.0-unknown");

  let running: Awaited<ReturnType<typeof startServeServer>>;
  try {
    running = await startServeServer({ host, port, serverVersion });
  } catch (err) {
    console.error(`docket serve: failed to start — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const dataDirLabel = process.env.DOCKET_DATA_DIR ?? "~/.docket (default)";
  console.log("docket server ready");
  console.log(`API:  http://${host}:${running.port}/api/v1`);
  console.log(`Data: ${dataDirLabel}`);
  console.log("Auth: per-device signed requests (RFC §14) — no client can call the API until it's paired.");
  console.log("      Pair a new device from THIS machine with: docket devices pair");

  const shutdown = () => {
    log("serve: shutting down cleanly");
    running.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
