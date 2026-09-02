import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PACKAGE_NAME = "@pasichdev/todo-mcp";

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

/** Public npm registry metadata endpoint — no auth needed, no custom signing to manage. */
export async function getLatestVersion(fetchImpl: typeof fetch = fetch): Promise<LatestVersionInfo> {
  const res = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`npm registry responded ${res.status}`);
  const body = (await res.json()) as { version: string; dist: { shasum: string; tarball: string } };
  return { version: body.version, shasum: body.dist.shasum, tarball: body.dist.tarball };
}

/** X.Y.Z comparison — this package's own releases never use pre-release tags, so this is enough. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
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
  const latest = await getLatestVersion(fetchImpl);
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

/**
 * Boots the newly-installed web.js as a throwaway child — its own scratch port and scratch
 * HOME, so it can never touch real data or the real port — and confirms it actually starts
 * and answers /api/version before the update is considered good. Never throws; returns false
 * on any failure so the caller can decide to roll back.
 */
async function selfTest(): Promise<boolean> {
  let scratchHome: string | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  try {
    scratchHome = await mkdtemp(join(tmpdir(), "todo-mcp-selftest-"));
    const port = 20000 + Math.floor(Math.random() * 10000);
    const globalRoot = await getGlobalNpmRoot();
    const webEntry = join(globalRoot, PACKAGE_NAME, "dist", "web.js");
    child = spawn(process.execPath, [webEntry], {
      env: { ...process.env, HOME: scratchHome, TODO_MCP_WEB_PORT: String(port) },
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
