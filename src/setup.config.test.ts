import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hostInvocation, packageSpec } from "./setup.js";
import {
  configFilePath,
  resolveDeploymentConfig,
  writeDataDirectoryConfig,
  writeDeploymentConfig,
} from "./config.js";
import { resolveDataDirectoryWithSource } from "./data-dir.js";

/**
 * Two ways a machine could end up running something other than what the user configured,
 * both of them silent, both of them created by setup itself.
 */

const home = await mkdtemp(join(tmpdir(), "docket-setup-config-"));
test.after(() => rm(home, { recursive: true, force: true }));
const options = { homeDirectory: home };

test("a generated host invocation pins the version that generated it", async () => {
  const spec = await packageSpec();
  const { args } = hostInvocation(spec, {});
  const pkg = args.find((a) => a.startsWith("--package="))!;
  assert.match(
    pkg,
    /^--package=@pasichdev\/docket@\d+\.\d+\.\d+/,
    `hosts were configured to run an unpinned package (${pkg}). On a release candidate — published under "next" precisely so "latest" keeps pointing at the last stable build — that means the next agent starts the STABLE version against a v3 data directory, with nothing saying so.`,
  );
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(pkg, `--package=@pasichdev/docket@${version}`);
});

test("the central config, not a per-host environment variable, decides the mode", async () => {
  // Remote setup, then a later `docket backend localize`. The env of a host configured by
  // the first would have pinned it to remote for ever: the resolver's priority is
  // env > config, so the mode switch would have said "local" while every agent carried on
  // talking to the server, and the only way out was hand-editing four host config files.
  await writeDeploymentConfig({ mode: "remote", serverUrl: "https://todo.example.com" }, options);
  const pinned = hostInvocation(await packageSpec(), {});
  assert.deepEqual(pinned.env, {}, "setup must not bake a deployment mode into a host's environment");

  await writeDeploymentConfig({ mode: "local" }, options);
  const effective = await resolveDeploymentConfig({ ...options, environment: { ...pinned.env } });
  assert.equal(effective.mode, "local");
  assert.equal(effective.source, "config");
});

test("an explicit environment variable still overrides the config, for one command or one container", async () => {
  await writeDeploymentConfig({ mode: "local" }, options);
  const effective = await resolveDeploymentConfig({
    ...options,
    environment: { DOCKET_MODE: "remote", DOCKET_SERVER_URL: "https://todo.example.com" },
  });
  assert.equal(effective.mode, "remote");
  assert.equal(effective.source, "env");
});

test("the data directory has one source of truth, and status can say which", async () => {
  const configured = await mkdtemp(join(tmpdir(), "docket-configured-store-"));
  const overridden = await mkdtemp(join(tmpdir(), "docket-overridden-store-"));
  try {
    await writeDataDirectoryConfig(configured, options);
    const { readConfiguredDataDirectory } = await import("./config.js");
    const fromConfig = await readConfiguredDataDirectory(options);
    assert.equal(fromConfig, configured);

    // A terminal that never sourced the shell rc used to resolve ~/.docket and back up an
    // empty store while reporting success. It now finds the same directory the agents use.
    const plainShell = await resolveDataDirectoryWithSource({ environment: {}, configuredDirectory: fromConfig });
    assert.equal(plainShell.directory, configured);
    assert.equal(plainShell.source, "config");

    const withOverride = await resolveDataDirectoryWithSource({
      environment: { DOCKET_DATA_DIR: overridden },
      configuredDirectory: fromConfig,
    });
    assert.equal(withOverride.directory, overridden, "the environment must still win, for a container or a single command");
    assert.equal(withOverride.source, "env");
  } finally {
    await rm(configured, { recursive: true, force: true });
    await rm(overridden, { recursive: true, force: true });
  }
});

test("switching modes preserves fields this build did not write", async () => {
  // A config written by a NEWER docket must not lose what it added the moment an older one
  // switches modes — a silent downgrade of the user's settings by a command that had
  // nothing to do with them.
  const path = configFilePath(options);
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, deployment: { mode: "local" }, somethingFromTheFuture: { keep: true } }));

  await writeDeploymentConfig({ mode: "remote", serverUrl: "https://todo.example.com" }, options);
  const after = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(after.somethingFromTheFuture, { keep: true });
  assert.deepEqual(after.deployment, { mode: "remote", serverUrl: "https://todo.example.com" });
});
