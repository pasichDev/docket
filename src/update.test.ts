import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkForUpdate, compareVersions, createSelfTestEnvironment, detectInstallKind, getCurrentVersion, getLatestVersion } from "./update.js";

test("detectInstallKind: a path under a global npm node_modules install", () => {
  const p = "/usr/local/lib/node_modules/@pasichdev/docket/dist/index.js";
  assert.equal(detectInstallKind(p), "global-npm");
});

test("detectInstallKind: an npx cache path", () => {
  const p = "/Users/me/.npm/_npx/abc123/node_modules/@pasichdev/docket/dist/index.js";
  assert.equal(detectInstallKind(p), "npx");
});

test("detectInstallKind: anything else is a dev clone", () => {
  assert.equal(detectInstallKind("/Users/me/repo/docket/dist/index.js"), "dev-clone");
});

test("createSelfTestEnvironment: isolates updater smoke tests from inherited docket state", () => {
  const environment = createSelfTestEnvironment({
    HOME: "/real-home",
    DOCKET_DATA_DIR: "/shared-state",
    XDG_STATE_HOME: "/shared-xdg-state",
    KEEP_ME: "yes",
  }, "/scratch-home", 23456);

  assert.deepEqual(environment, {
    HOME: "/scratch-home",
    DOCKET_DATA_DIR: "/scratch-home/data",
    DOCKET_WEB_PORT: "23456",
    KEEP_ME: "yes",
  });
});

test("compareVersions: orders by major, then minor, then patch", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.1", "1.0.0"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.2.0", "1.10.0"), -1); // numeric, not lexical
});

test("getCurrentVersion: finds the nearest package.json walking up from a nested file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-update-test-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ version: "3.4.5" }));
  const nested = join(dir, "dist");
  await mkdir(nested, { recursive: true });
  assert.equal(await getCurrentVersion(join(nested, "index.js")), "3.4.5");
});

test("getCurrentVersion: throws when no package.json is found", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-update-test-empty-"));
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
  const dir = await mkdtemp(join(tmpdir(), "docket-update-test-check-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.0.1" }));
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ version: "9.9.9", dist: { shasum: "x", tarball: "https://example.com/t.tgz" } }), { status: 200 })) as typeof fetch;
  const result = await checkForUpdate(join(dir, "dist", "index.js"), fakeFetch);
  assert.equal(result.installKind, "dev-clone");
  assert.equal(result.currentVersion, "0.0.1");
  assert.equal(result.latestVersion, "9.9.9");
  assert.equal(result.updateAvailable, true);
});

test("compareVersions: a pre-release sorts below its own release", () => {
  // The rule that decides whether an RC user gets offered the final build.
  assert.equal(compareVersions("3.0.0-rc.1", "3.0.0"), -1);
  assert.equal(compareVersions("3.0.0", "3.0.0-rc.1"), 1);
  assert.equal(compareVersions("3.0.0-rc.1", "3.0.0-rc.1"), 0);
});

test("compareVersions: pre-release identifiers are ordered, not just detected", () => {
  // The bug this replaces: splitting on "." and running Number() over the parts turned
  // "0-rc" into NaN, every comparison against NaN is false, and the loop fell through to
  // its "greater than" branch. compareVersions("3.0.0-rc.1", "3.0.0-rc.2") answered 1 —
  // so someone on rc.2 would have been offered rc.1 as an update.
  assert.equal(compareVersions("3.0.0-rc.1", "3.0.0-rc.2"), -1);
  assert.equal(compareVersions("3.0.0-rc.2", "3.0.0-rc.1"), 1);
  assert.equal(compareVersions("3.0.0-rc.9", "3.0.0-rc.10"), -1, "numeric identifiers compare numerically, not as text");

  // SemVer §11 in full: numeric ranks below alphanumeric, and a longer identifier set wins
  // when everything before it is equal.
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-beta"), -1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.11"), -1);
});

test("compareVersions: build metadata and a leading v are not part of precedence", () => {
  assert.equal(compareVersions("3.0.0+build.7", "3.0.0"), 0);
  assert.equal(compareVersions("v3.0.1", "3.0.0"), 1);
  assert.equal(compareVersions("3.0.0-rc.1+sha.abc", "3.0.0-rc.1"), 0);
});

test("compareVersions: an update is never offered as a downgrade in either direction", () => {
  // Property check over the whole ladder: every pair must agree with its own reverse, and
  // the ordering must be transitive along the release train.
  const ladder = ["2.3.1", "3.0.0-alpha.1", "3.0.0-beta.1", "3.0.0-rc.1", "3.0.0-rc.2", "3.0.0-rc.10", "3.0.0", "3.0.1"];
  for (let i = 0; i < ladder.length; i++) {
    for (let j = 0; j < ladder.length; j++) {
      const expected = i === j ? 0 : i < j ? -1 : 1;
      assert.equal(compareVersions(ladder[i], ladder[j]), expected, `${ladder[i]} vs ${ladder[j]}`);
    }
  }
});
