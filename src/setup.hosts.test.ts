import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configureJsonHost } from "./setup.js";

/**
 * B25: setup edits files it did not write, in a user's home directory, containing
 * configuration for tools that have nothing to do with docket.
 *
 * The rule under test is one sentence: a config that exists but cannot be read is never
 * treated as an absent one. Everything else follows from it.
 */
const home = await mkdtemp(join(tmpdir(), "docket-hosts-test-"));
test.after(() => rm(home, { recursive: true, force: true }));

const SERVER_ARGS = ["-y", "--package=@pasichdev/docket@3.0.0", "docket"];
const silent = { log: () => {}, warn: () => {} };

async function hostFile(name: string, contents?: string): Promise<string> {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true });
  const target = join(dir, "mcp.json");
  if (contents !== undefined) await writeFile(target, contents);
  return target;
}

test("a config that cannot be parsed is left byte-for-byte alone", async () => {
  // A trailing comma. Common, harmless to the host that wrote it, and previously enough to
  // wipe every other MCP server the user had configured.
  const original = '{\n  "mcpServers": {\n    "github": { "command": "gh-mcp" },\n  }\n}\n';
  const target = await hostFile("broken", original);

  const outcome = await configureJsonHost(target, SERVER_ARGS, {}, silent);
  assert.equal(outcome, "skipped-unreadable");
  assert.equal(await readFile(target, "utf8"), original, "an unparseable config was rewritten — every other MCP server in it is gone");
});

test("a config that is valid JSON but not an object is also left alone", async () => {
  const original = '["not", "a", "config"]\n';
  const target = await hostFile("array", original);
  assert.equal(await configureJsonHost(target, SERVER_ARGS, {}, silent), "skipped-unreadable");
  assert.equal(await readFile(target, "utf8"), original);
});

test("unrelated entries and unknown top-level fields survive being configured", async () => {
  const target = await hostFile(
    "populated",
    JSON.stringify(
      {
        mcpServers: {
          github: { command: "gh-mcp", args: ["--stdio"] },
          docket: { command: "npx", args: ["-y", "@pasichdev/docket"], env: { DOCKET_DATA_DIR: "/old/path" } },
        },
        somethingTheHostAdded: { theme: "dark" },
      },
      null,
      2,
    ),
  );

  const outcome = await configureJsonHost(target, SERVER_ARGS, { DOCKET_DATA_DIR: "/new/path" }, silent);
  assert.equal(outcome, "configured");

  const after = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
  assert.deepEqual(after.mcpServers.github, { command: "gh-mcp", args: ["--stdio"] }, "an unrelated MCP server was modified");
  assert.deepEqual(after.somethingTheHostAdded, { theme: "dark" }, "a top-level field this build does not know about was dropped");
  assert.deepEqual(after.mcpServers.docket, { command: "npx", args: SERVER_ARGS, env: { DOCKET_DATA_DIR: "/new/path" } });
});

test("the previous contents are kept beside the file, so a wrong edit is recoverable", async () => {
  const original = JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }, null, 2);
  const target = await hostFile("backed-up", original);
  await configureJsonHost(target, SERVER_ARGS, {}, silent);
  assert.equal(await readFile(`${target}.docket-backup`, "utf8"), original);
});

test("a host that is not installed gets no config file invented for it", async () => {
  const target = join(home, "not-installed", "mcp.json");
  assert.equal(await configureJsonHost(target, SERVER_ARGS, {}, silent), "skipped-absent");
  await assert.rejects(() => stat(target), "setup created a config for a host that is not on this machine");
});

test("an empty file is a fresh start, not a parse failure", async () => {
  const target = await hostFile("empty", "");
  assert.equal(await configureJsonHost(target, SERVER_ARGS, {}, silent), "created");
  const after = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
  assert.equal(after.mcpServers.docket.command, "npx");
});
