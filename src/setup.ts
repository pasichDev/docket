#!/usr/bin/env node
import { resolveDataDirectory } from "./data-dir.js";
import { fileURLToPath } from "node:url";

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

async function main(): Promise<void> {
  const configured = parseDataDirectoryArg(process.argv.slice(2));
  const environment = configured ? { ...process.env, TODO_MCP_DATA_DIR: configured } : process.env;
  const dataDirectory = await resolveDataDirectory({
    environment,
    warn: (message) => process.stderr.write(message),
  });

  console.log(`todo-mcp data directory: ${dataDirectory}`);
  console.log("\nUse this same directory in every MCP host that should share the list:\n");
  console.log("Codex (config.toml):");
  console.log("[mcp_servers.todo-mcp.env]");
  console.log(`TODO_MCP_DATA_DIR = ${JSON.stringify(dataDirectory)}\n`);
  console.log("Claude Desktop / Cursor / Windsurf / Zed:");
  console.log(JSON.stringify({ env: { TODO_MCP_DATA_DIR: dataDirectory } }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`todo-mcp setup failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
