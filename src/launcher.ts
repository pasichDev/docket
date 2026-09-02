#!/usr/bin/env node

// Keep the setup path free of the MCP server's persistence imports. This is
// important for `npx ... setup` in restricted agent sandboxes.
if (process.argv[2]?.toLowerCase() === "setup") {
  const { runInteractiveSetup } = await import("./setup.js");
  await runInteractiveSetup(process.argv.slice(3));
} else if (process.argv[2]?.toLowerCase() === "serve") {
  // Dispatched before index.js's stdio MCP server (or anything it imports) ever loads —
  // `docket serve` is a completely different process shape (an HTTP server, no stdio
  // JSON-RPC), and server/cli.ts needs to set DOCKET_DATA_DIR from --data-dir itself
  // before any storage-touching module is imported. See server/cli.ts for why.
  const { runServeCommand } = await import("./server/cli.js");
  await runServeCommand(process.argv.slice(3));
} else if (process.argv[2]?.toLowerCase() === "devices") {
  // Talks to a running `docket serve` over its loopback-only admin routes (RFC §13/§24) —
  // never touches storage itself, so it's dispatched here rather than through index.js.
  const { runDevicesCommand } = await import("./server/devices-cli.js");
  await runDevicesCommand(process.argv.slice(3));
} else if (process.argv[2]?.toLowerCase() === "pair") {
  // `docket pair <serverUrl>` (RFC §13, client side) — reads/writes this device's own
  // identity and remote credentials, but never the local todo store, so it's kept out of
  // index.js's stdio MCP startup path the same way `setup`/`serve` are.
  const { runPairCommand } = await import("./remote/pair-cli.js");
  await runPairCommand(process.argv.slice(3));
} else if (process.argv[2]?.toLowerCase() === "status") {
  // `docket status` (RFC §24/§33) — read-only, dispatched here (not through index.js)
  // so it never touches stdio/MCP startup at all.
  const { runStatusCommand } = await import("./status.js");
  await runStatusCommand();
} else if (process.argv[2]?.toLowerCase() === "backend") {
  // `docket backend use|localize` (RFC §28/§29) — migrates this device's workspace
  // between local and remote, touching both local storage and (for `use`) a remote
  // server; kept out of index.js's stdio MCP startup path for the same reason `pair` is.
  const { runBackendCommand } = await import("./backend.js");
  await runBackendCommand(process.argv.slice(3));
} else {
  await import("./index.js");
}
