#!/usr/bin/env node

// Keep the setup path free of the MCP server's persistence imports. This is
// important for `npx ... setup` in restricted agent sandboxes.
if (process.argv[2]?.toLowerCase() === "setup") {
  const { runInteractiveSetup } = await import("./setup.js");
  await runInteractiveSetup(process.argv.slice(3));
} else {
  await import("./index.js");
}
