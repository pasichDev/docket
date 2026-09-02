import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkForUpdate, compareVersions, detectInstallKind, getCurrentVersion, getLatestVersion } from "./update.js";

test("detectInstallKind: a path under a global npm node_modules install", () => {
  const p = "/usr/local/lib/node_modules/@pasichdev/todo-mcp/dist/index.js";
  assert.equal(detectInstallKind(p), "global-npm");
});

test("detectInstallKind: an npx cache path", () => {
  const p = "/Users/me/.npm/_npx/abc123/node_modules/@pasichdev/todo-mcp/dist/index.js";
  assert.equal(detectInstallKind(p), "npx");
});

test("detectInstallKind: anything else is a dev clone", () => {
  assert.equal(detectInstallKind("/Users/me/repo/todo-mcp/dist/index.js"), "dev-clone");
});

test("compareVersions: orders by major, then minor, then patch", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.1", "1.0.0"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.2.0", "1.10.0"), -1); // numeric, not lexical
});

test("getCurrentVersion: finds the nearest package.json walking up from a nested file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "todo-mcp-update-test-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ version: "3.4.5" }));
  const nested = join(dir, "dist");
  await mkdir(nested, { recursive: true });
  assert.equal(await getCurrentVersion(join(nested, "index.js")), "3.4.5");
});

test("getCurrentVersion: throws when no package.json is found", async () => {
  const dir = await mkdtemp(join(tmpdir(), "todo-mcp-update-test-empty-"));
  await assert.rejects(() => getCurrentVersion(join(dir, "index.js")));
});

test("getLatestVersion: parses version/shasum/tarball from the registry response", async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ version: "9.9.9", dist: { shasum: "deadbeef", tarball: "https://example.com/t.tgz" } }),
      { status: 200 },
    )) as typeof fetch;
  const info = await getLatestVersion(fakeFetch);
  assert.deepEqual(info, { version: "9.9.9", shasum: "deadbeef", tarball: "https://example.com/t.tgz" });
});

test("getLatestVersion: throws on a non-ok registry response", async () => {
  const fakeFetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  await assert.rejects(() => getLatestVersion(fakeFetch));
});

test("checkForUpdate: combines install kind, local version, and registry version into updateAvailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "todo-mcp-update-test-check-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.0.1" }));
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ version: "9.9.9", dist: { shasum: "x", tarball: "https://example.com/t.tgz" } }), { status: 200 })) as typeof fetch;
  const result = await checkForUpdate(join(dir, "dist", "index.js"), fakeFetch);
  assert.equal(result.installKind, "dev-clone");
  assert.equal(result.currentVersion, "0.0.1");
  assert.equal(result.latestVersion, "9.9.9");
  assert.equal(result.updateAvailable, true);
});
