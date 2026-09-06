import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CrewConfigError, defaultConfig, loadConfig, normalizeConfig, renderConfig } from "./config.js";
import { crewPaths, ensureCrewTree } from "./paths.js";

async function scratchPaths() {
  const root = await mkdtemp(join(tmpdir(), "crew-config-test-"));
  return ensureCrewTree(crewPaths(root));
}

test("first load writes the default config.yml and returns the defaults", async () => {
  const paths = await scratchPaths();
  const config = await loadConfig(paths);
  assert.deepEqual(config, defaultConfig());
  const onDisk = await readFile(paths.configFile, "utf8");
  assert.match(onDisk, /manager-claude/);
  assert.match(onDisk, /coder-openrouter/);
  // The shipped default must survive its own round-trip.
  const reloaded = await loadConfig(paths);
  assert.deepEqual(reloaded, config);
});

test("default profiles match the spec'd team and automation limits", () => {
  const config = defaultConfig();
  assert.equal(config.manager.profile, "manager-claude");
  assert.equal(config.profiles["manager-claude"].runtime, "claude");
  assert.equal(config.profiles["manager-claude"].role, "manager");
  assert.equal(config.profiles["coder-codex"].runtime, "codex");
  assert.equal(config.profiles["coder-openrouter"].runtime, "opencode");
  assert.equal(config.profiles["coder-openrouter"].provider, "openrouter");
  assert.equal(config.profiles["coder-openrouter"].model, "openrouter/~google/gemini-flash-latest");
  assert.equal(config.profiles["reviewer-claude"].role, "reviewer");
  assert.deepEqual(config.automation, {
    managerAutoWake: true,
    maxAutonomousTurns: 10,
    maxAgents: 4,
    maxConcurrentRuns: 3,
    maxRetries: 1,
    turnIdleTimeoutMs: 600_000,
  });
});

test("renderConfig output parses back to the same config", () => {
  const config = defaultConfig();
  assert.deepEqual(normalizeConfig(JSON.parse(JSON.stringify(config))), config);
  assert.ok(renderConfig(config).includes("maxConcurrentRuns: 3"));
});

test("partial config falls back to defaults for missing sections", () => {
  const config = normalizeConfig({ automation: { maxConcurrentRuns: 7 } });
  assert.equal(config.automation.maxConcurrentRuns, 7);
  assert.equal(config.automation.maxAutonomousTurns, 10);
  assert.equal(config.manager.profile, "manager-claude");
  assert.ok(config.profiles["coder-codex"]);
});

test("unknown runtime id is rejected, not guessed", () => {
  assert.throws(
    () => normalizeConfig({ profiles: { bad: { runtime: "gemini-cli", role: "worker" } } }),
    CrewConfigError,
  );
});

test("manager pointing at a missing or non-manager profile is rejected", () => {
  assert.throws(() => normalizeConfig({ manager: { profile: "nope" } }), /not a defined profile/);
  assert.throws(
    () =>
      normalizeConfig({
        manager: { profile: "w" },
        profiles: { w: { runtime: "codex", role: "worker" } },
      }),
    /must have role "manager"/,
  );
});

test("invalid YAML in config.yml throws a CrewConfigError instead of silently defaulting", async () => {
  const paths = await scratchPaths();
  await writeFile(paths.configFile, "profiles: [unclosed", "utf8");
  await assert.rejects(loadConfig(paths), CrewConfigError);
});
