import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const originalWebPort = process.env.DOCKET_WEB_PORT;
const originalHome = process.env.HOME;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-status-test-"));
const scratchHome = await mkdtemp(join(tmpdir(), "docket-status-test-home-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
// Never let this test's `Web: ... (not running)` probe accidentally reach the real
// dev/production web UI (see the ground rules: never touch port 8787 / ~/.docket) — pin
// it to a port nothing is listening on instead of relying on the untouched default.
process.env.DOCKET_WEB_PORT = "18787";
// resolveDeploymentConfig() (called by runStatusCommand with no options, same as
// production) reads ~/.config/docket/config.json via os.homedir() — redirect HOME to an
// empty scratch directory so this test never depends on (or risks touching) whatever
// might be at the real ~/.config/docket/config.json.
process.env.HOME = scratchHome;

// storage.ts (and everything it pulls in via config.ts/peers.ts) resolves on-disk paths
// from DOCKET_DATA_DIR at module-load time via a top-level await — must be set first.
const { runStatusCommand } = await import("./status.js");

test.after(async () => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  if (originalWebPort === undefined) delete process.env.DOCKET_WEB_PORT;
  else process.env.DOCKET_WEB_PORT = originalWebPort;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(scratchHome, { recursive: true, force: true });
  return rm(dataDirectory, { recursive: true, force: true });
});

async function captureLogLines(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test("runStatusCommand: local mode (no config file, no DOCKET_MODE — every existing install) reports Mode/Store/Web/Workspace/Sessions/Peers", async () => {
  const lines = await captureLogLines(() => runStatusCommand());
  assert.equal(lines[0], "Mode: local");
  // The source, not just the path: two shells resolving different stores with nothing
  // saying so is exactly the confusion this line exists to end.
  assert.equal(lines[1], `Store: ${dataDirectory} (from DOCKET_DATA_DIR)`);
  assert.match(lines[2], /^Web: http:\/\/localhost:18787 \(not running\)$/);
  // Workspace scoping fails silently — items land somewhere you never look — so which
  // project this directory resolves to, and why, has to be answerable without a log.
  assert.match(lines[3], /^Workspace: .+ via (env|config|git-remote|git-root|cwd|none)/);
  assert.match(lines[4], /^Sessions: \d+ open$/);
  assert.equal(lines[5], "Peers: 0");
});
