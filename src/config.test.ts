import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { assertSecureRemoteUrl, DeploymentConfigError, resolveDeploymentConfig, writeDeploymentConfig } from "./config.js";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "docket-config-test-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeConfig(home: string, contents: unknown): Promise<void> {
  const dir = join(home, ".config", "docket");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

test("resolveDeploymentConfig: no config file and no env -> local by default (existing installs unaffected)", async () => {
  await withHome(async (home) => {
    const result = await resolveDeploymentConfig({ environment: {}, homeDirectory: home });
    assert.deepEqual(result, { mode: "local", serverUrl: null, allowInsecureRemote: false, source: "default" });
  });
});

test("resolveDeploymentConfig: a config.json in local mode is read and reported as the source", async () => {
  await withHome(async (home) => {
    await writeConfig(home, { version: 1, deployment: { mode: "local" } });
    const result = await resolveDeploymentConfig({ environment: {}, homeDirectory: home });
    assert.equal(result.mode, "local");
    assert.equal(result.source, "config");
  });
});

test("resolveDeploymentConfig: remote mode from config.json with an https serverUrl resolves cleanly", async () => {
  await withHome(async (home) => {
    await writeConfig(home, { version: 1, deployment: { mode: "remote", serverUrl: "https://docket.example.com" } });
    const result = await resolveDeploymentConfig({ environment: {}, homeDirectory: home });
    assert.equal(result.mode, "remote");
    assert.equal(result.serverUrl, "https://docket.example.com");
    assert.equal(result.source, "config");
  });
});

test("resolveDeploymentConfig: priority is CLI > env > config > default (mode)", async () => {
  await withHome(async (home) => {
    await writeConfig(home, { version: 1, deployment: { mode: "remote", serverUrl: "https://from-config.example.com" } });
    const envOnly = await resolveDeploymentConfig({ environment: { DOCKET_MODE: "local" }, homeDirectory: home });
    assert.equal(envOnly.mode, "local"); // env beats config
    assert.equal(envOnly.source, "env");

    const cliOnly = await resolveDeploymentConfig({
      environment: { DOCKET_MODE: "local" },
      homeDirectory: home,
      cli: { mode: "remote", serverUrl: "https://from-cli.example.com" },
    });
    assert.equal(cliOnly.mode, "remote"); // cli beats env
    assert.equal(cliOnly.serverUrl, "https://from-cli.example.com");
    assert.equal(cliOnly.source, "cli");
  });
});

test("resolveDeploymentConfig: DOCKET_SERVER_URL env overrides config.json's serverUrl independently of mode's source", async () => {
  await withHome(async (home) => {
    await writeConfig(home, { version: 1, deployment: { mode: "remote", serverUrl: "https://from-config.example.com" } });
    const result = await resolveDeploymentConfig({
      environment: { DOCKET_SERVER_URL: "https://from-env.example.com" },
      homeDirectory: home,
    });
    assert.equal(result.mode, "remote"); // still from config
    assert.equal(result.serverUrl, "https://from-env.example.com"); // but url from env
  });
});

test("resolveDeploymentConfig: an invalid DOCKET_MODE fails closed rather than silently defaulting", async () => {
  await withHome(async (home) => {
    await assert.rejects(
      () => resolveDeploymentConfig({ environment: { DOCKET_MODE: "cloud" }, homeDirectory: home }),
      DeploymentConfigError,
    );
  });
});

test("resolveDeploymentConfig: a corrupt config.json is a hard error, never silently ignored", async () => {
  await withHome(async (home) => {
    await writeConfig(home, "{ not json");
    await assert.rejects(() => resolveDeploymentConfig({ environment: {}, homeDirectory: home }), DeploymentConfigError);
  });
});

test("resolveDeploymentConfig: remote mode with no serverUrl anywhere is a hard error", async () => {
  await withHome(async (home) => {
    await assert.rejects(
      () => resolveDeploymentConfig({ environment: { DOCKET_MODE: "remote" }, homeDirectory: home }),
      DeploymentConfigError,
    );
  });
});

test("resolveDeploymentConfig: an insecure http:// remote server is rejected unless explicitly allowed (RFC §15)", async () => {
  await withHome(async (home) => {
    await assert.rejects(
      () =>
        resolveDeploymentConfig({
          environment: { DOCKET_MODE: "remote", DOCKET_SERVER_URL: "http://docket.example.com" },
          homeDirectory: home,
        }),
      DeploymentConfigError,
    );
  });
});

test("resolveDeploymentConfig: DOCKET_ALLOW_INSECURE_REMOTE=1 opts into http:// for a non-localhost server", async () => {
  await withHome(async (home) => {
    const result = await resolveDeploymentConfig({
      environment: { DOCKET_MODE: "remote", DOCKET_SERVER_URL: "http://docket.lan", DOCKET_ALLOW_INSECURE_REMOTE: "1" },
      homeDirectory: home,
    });
    assert.equal(result.allowInsecureRemote, true);
    assert.equal(result.serverUrl, "http://docket.lan");
  });
});

test("resolveDeploymentConfig: plain http://localhost is allowed without the insecure opt-in (trusted LAN dev)", async () => {
  await withHome(async (home) => {
    const result = await resolveDeploymentConfig({
      environment: { DOCKET_MODE: "remote", DOCKET_SERVER_URL: "http://localhost:8788" },
      homeDirectory: home,
    });
    assert.equal(result.serverUrl, "http://localhost:8788");
  });
});

test("writeDeploymentConfig: round-trips through resolveDeploymentConfig (docket setup's remote flow / docket backend use/localize)", async () => {
  await withHome(async (home) => {
    const path = await writeDeploymentConfig({ mode: "remote", serverUrl: "https://docket.example.com" }, { homeDirectory: home });
    assert.equal(path, join(home, ".config", "docket", "config.json"));

    const result = await resolveDeploymentConfig({ environment: {}, homeDirectory: home });
    assert.equal(result.mode, "remote");
    assert.equal(result.serverUrl, "https://docket.example.com");
    assert.equal(result.source, "config");

    // Written with owner-only permissions, same as every other secrets-adjacent file this
    // project writes (device.json, peers.json.enc, remote-server.json.enc).
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(raw, { version: 1, deployment: { mode: "remote", serverUrl: "https://docket.example.com" } });
  });
});

test("writeDeploymentConfig: switching back to local preserves an existing allowInsecureRemote flag, and drops serverUrl", async () => {
  await withHome(async (home) => {
    await writeConfig(home, { version: 1, deployment: { mode: "remote", serverUrl: "https://old.example.com" }, allowInsecureRemote: true });
    await writeDeploymentConfig({ mode: "local" }, { homeDirectory: home });

    const result = await resolveDeploymentConfig({ environment: {}, homeDirectory: home });
    assert.equal(result.mode, "local");
    assert.equal(result.allowInsecureRemote, true);
  });
});

test("writeDeploymentConfig: no prior config file — creates one from scratch", async () => {
  await withHome(async (home) => {
    await writeDeploymentConfig({ mode: "local" }, { homeDirectory: home });
    const result = await resolveDeploymentConfig({ environment: {}, homeDirectory: home });
    assert.equal(result.mode, "local");
    assert.equal(result.source, "config");
  });
});

test("assertSecureRemoteUrl: never silently downgrades — https always passes, http always requires the explicit opt-in for a non-loopback host", () => {
  assert.doesNotThrow(() => assertSecureRemoteUrl("https://docket.example.com", false));
  assert.doesNotThrow(() => assertSecureRemoteUrl("http://127.0.0.1:8788", false));
  assert.throws(() => assertSecureRemoteUrl("http://docket.example.com", false), DeploymentConfigError);
  assert.doesNotThrow(() => assertSecureRemoteUrl("http://docket.example.com", true));
});
