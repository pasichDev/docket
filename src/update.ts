import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PACKAGE_NAME = "@pasichdev/docket";

export type InstallKind = "global-npm" | "npx" | "dev-clone";

/**
 * Classifies how this running copy got here, from the resolved path of the executing
 * script. Only a "global-npm" install has a persistent thing worth updating in place —
 * npx always re-fetches latest on the next run, and a dev clone is updated via git.
 */
export function detectInstallKind(scriptPath: string): InstallKind {
  const normalized = scriptPath.replace(/\\/g, "/");
  if (normalized.includes("/_npx/")) return "npx";
  if (normalized.includes(`/node_modules/${PACKAGE_NAME}/`)) return "global-npm";
  return "dev-clone";
}

/** Walks up from a starting file path to find the nearest package.json and returns its version. */
export async function getCurrentVersion(startPath: string): Promise<string> {
  let dir = dirname(startPath);
  for (let i = 0; i < 6; i++) {
    try {
      const raw = await readFile(join(dir, "package.json"), "utf8");
      const pkg = JSON.parse(raw) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // no package.json here, or unreadable — keep climbing
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`couldn't find a package.json with a version above ${startPath}`);
}

export interface LatestVersionInfo {
  version: string;
  shasum: string;
  tarball: string;
}

/**
 * Public npm registry metadata endpoint — no auth needed, no custom signing to manage.
 *
 * `tag` matters for pre-releases. A release candidate is published under `next` so that
 * `latest` keeps pointing at the last stable build, which means someone running 3.0.0-rc.1
 * who asks about updates would be told about 2.3.1 and never hear about rc.2 — the channel
 * that needs update checking most would be the one channel without it.
 */
export async function getLatestVersion(fetchImpl: typeof fetch = fetch, tag = "latest"): Promise<LatestVersionInfo> {
  const res = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/${encodeURIComponent(tag)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`npm registry responded ${res.status}`);
  const body = (await res.json()) as { version: string; dist: { shasum: string; tarball: string } };
  return { version: body.version, shasum: body.dist.shasum, tarball: body.dist.tarball };
}

/** A build carrying a pre-release identifier follows the `next` channel it came from. */
export function releaseChannelFor(version: string): "latest" | "next" {
  return version.includes("-") ? "next" : "latest";
}

const cmp = (a: number | string, b: number | string): -1 | 0 | 1 => (a === b ? 0 : a < b ? -1 : 1);

/**
 * SemVer §11 precedence, pre-release identifiers included.
 *
 * The previous version split on "." and ran Number() over the parts, which turns "0-rc"
 * into NaN — and every comparison against NaN is false, so the loop fell through to its
 * "greater than" branch on the first pre-release segment it met. compareVersions(
 * "3.0.0-rc.1", "3.0.0-rc.2") therefore answered "rc.1 is newer", which would have offered
 * an RC user a downgrade and called it an update. It only ever LOOKED right because
 * release-vs-prerelease comparisons happened to land on that same branch correctly.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  // Build metadata is explicitly not part of precedence.
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);

  for (let i = 0; i < 3; i++) {
    const result = cmp(coreA[i] ?? 0, coreB[i] ?? 0);
    if (result !== 0) return result;
  }
  // "1.0.0-rc.1" precedes "1.0.0": a pre-release is always older than its own release.
  const hasPreA = preA.length > 0;
  const hasPreB = preB.length > 0;
  if (!hasPreA || !hasPreB) return cmp(hasPreA ? 0 : 1, hasPreB ? 0 : 1);

  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    const idA = preA[i];
    const idB = preB[i];
    // A larger set of identifiers wins when all the preceding ones are equal.
    if (idA === undefined) return -1;
    if (idB === undefined) return 1;
    const numA = /^\d+$/.test(idA) ? Number(idA) : null;
    const numB = /^\d+$/.test(idB) ? Number(idB) : null;
    // Numeric identifiers compare numerically and always rank below alphanumeric ones.
    if (numA !== null && numB !== null) {
      const result = cmp(numA, numB);
      if (result !== 0) return result;
    } else if (numA !== null) return -1;
    else if (numB !== null) return 1;
    else {
      const result = cmp(idA, idB);
      if (result !== 0) return result;
    }
  }
  return 0;
}

function splitVersion(version: string): [number[], string[]] {
  const withoutBuild = version.trim().replace(/^v/, "").split("+")[0];
  const dash = withoutBuild.indexOf("-");
  const core = (dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)).split(".").map((part) => {
    const n = Number(part);
    return Number.isFinite(n) ? n : 0;
  });
  const pre = dash === -1 ? [] : withoutBuild.slice(dash + 1).split(".").filter(Boolean);
  return [core, pre];
}

export interface UpdateCheckResult {
  installKind: InstallKind;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

/** Read-only — safe to expose as an MCP tool an agent can call on its own. */
export async function checkForUpdate(scriptPath: string, fetchImpl: typeof fetch = fetch): Promise<UpdateCheckResult> {
  const installKind = detectInstallKind(scriptPath);
  const currentVersion = await getCurrentVersion(scriptPath);
  /*
   * A pre-release follows the channel it came from, but never ONLY that channel: `next` may
   * not exist yet (nothing published to it), and it lags behind `latest` once a release
   * ships. Ask both and take whichever is genuinely newer, so an RC hears about the next RC
   * AND about the stable build that supersedes it.
   */
  const channel = releaseChannelFor(currentVersion);
  const candidates = channel === "next" ? ["next", "latest"] : ["latest"];
  const found: LatestVersionInfo[] = [];
  for (const tag of candidates) {
    const info = await getLatestVersion(fetchImpl, tag).catch(() => null);
    if (info) found.push(info);
  }
  if (found.length === 0) throw new Error(`couldn't reach the npm registry for ${PACKAGE_NAME}`);
  const latest = found.reduce((best, info) => (compareVersions(info.version, best.version) > 0 ? info : best));
  return {
    installKind,
    currentVersion,
    latestVersion: latest.version,
    updateAvailable: compareVersions(latest.version, currentVersion) > 0,
  };
}

function runNpmInstall(version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["install", "-g", `${PACKAGE_NAME}@${version}`], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited with code ${code}`))));
  });
}

function getGlobalNpmRoot(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["root", "-g"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`npm root -g exited with code ${code}`))));
  });
}

export function createSelfTestEnvironment(
  parentEnvironment: NodeJS.ProcessEnv,
  scratchHome: string,
  port: number,
): NodeJS.ProcessEnv {
  const { DOCKET_DATA_DIR: _dataDirectory, XDG_STATE_HOME: _stateHome, ...environment } = parentEnvironment;
  return {
    ...environment,
    HOME: scratchHome,
    DOCKET_DATA_DIR: join(scratchHome, "data"),
    DOCKET_WEB_PORT: String(port),
  };
}

/**
 * Boots the newly-installed web.js as a throwaway child — its own scratch port and scratch
 * HOME and data directory, so it can never touch real data or the real port — and confirms it actually starts
 * and answers /api/version before the update is considered good. Never throws; returns false
 * on any failure so the caller can decide to roll back.
 */
async function selfTest(): Promise<boolean> {
  let scratchHome: string | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  try {
    scratchHome = await mkdtemp(join(tmpdir(), "docket-selftest-"));
    const port = 20000 + Math.floor(Math.random() * 10000);
    const globalRoot = await getGlobalNpmRoot();
    const webEntry = join(globalRoot, PACKAGE_NAME, "dist", "web.js");
    child = spawn(process.execPath, [webEntry], {
      env: createSelfTestEnvironment(process.env, scratchHome, port),
      stdio: "ignore",
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return true;
      } catch {
        // not up yet — retry until the deadline
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  } catch {
    return false;
  } finally {
    child?.kill();
    if (scratchHome) await rm(scratchHome, { recursive: true, force: true }).catch(() => {});
  }
}

export interface RunUpdateOptions {
  /** Prompts the human for explicit confirmation before installing anything — never skipped. */
  confirm: (message: string) => Promise<boolean>;
  log?: (message: string) => void;
}

export async function runUpdate(scriptPath: string, opts: RunUpdateOptions): Promise<void> {
  const say = opts.log ?? console.log;
  const installKind = detectInstallKind(scriptPath);

  if (installKind === "dev-clone") {
    say("This looks like a local git clone, not an npm install — run `git pull` and `npm run build` instead.");
    return;
  }
  if (installKind === "npx") {
    say("Running via npx — you always get the latest published version on the next run, nothing to update.");
    return;
  }

  const currentVersion = await getCurrentVersion(scriptPath);
  say(`Current version: ${currentVersion}`);
  say("Checking npm registry for the latest version…");
  const latest = await getLatestVersion();

  if (compareVersions(latest.version, currentVersion) <= 0) {
    say(`Already up to date (${currentVersion}).`);
    return;
  }

  const ok = await opts.confirm(`Update ${PACKAGE_NAME} ${currentVersion} → ${latest.version}?`);
  if (!ok) {
    say("Update cancelled.");
    return;
  }

  say(`Installing ${latest.version}…`);
  await runNpmInstall(latest.version);

  say("Verifying the new version starts correctly…");
  const passed = await selfTest();
  if (!passed) {
    say(`Self-test failed — rolling back to ${currentVersion}…`);
    await runNpmInstall(currentVersion);
    say(`Rolled back to ${currentVersion}. The new version was NOT applied.`);
    return;
  }

  say(`Updated to ${latest.version}. Restart your MCP client (and the web server, if running) to pick it up.`);
}
