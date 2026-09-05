import { DeploymentConfigError, resolveDeploymentConfig } from "./config.js";
import { getDataDirectoryWithSource } from "./data-dir.js";
import { getDeviceId, getDeviceName } from "./device.js";
import { loadPeers } from "./peers.js";
import { loadRemoteCredentials } from "./remote/credentials.js";
import { listSessions } from "./sessions.js";
import { signedGet } from "./remote/signed-fetch.js";
import { resolveWorkspace } from "./workspace.js";

/**
 * `docket status` (RFC "Local and Self-Hosted Backend Modes" §24/§33, Implementation
 * Phase 4) — the one command a headless install can run to answer "is this thing
 * working?" without a browser. Deliberately read-only: it never mutates config,
 * credentials, or todo state, so it's safe to run at any time, including from a
 * monitoring script.
 */

function describeDataDirSource(source: "env" | "config" | "legacy" | "xdg"): string {
  if (source === "env") return "DOCKET_DATA_DIR";
  if (source === "config") return "~/.config/docket/config.json";
  if (source === "xdg") return "XDG_STATE_HOME";
  return "the default location";
}

async function probeWebUi(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

async function runLocalStatus(): Promise<void> {
  const { directory: dataDir, source: dataDirSource } = await getDataDirectoryWithSource();
  const webPort = Number(process.env.DOCKET_WEB_PORT ?? 8787);
  const webUp = await probeWebUi(webPort);
  const peers = await loadPeers();
  const activePeers = peers.filter((p) => !p.revoked).length;

  const { workspace, source, root } = await resolveWorkspace(process.cwd());
  const sessions = await listSessions();

  console.log(`Mode: local`);
  // Which directory, and WHY that one. A terminal that never sourced the shell rc and an
  // MCP host that did used to resolve to different stores with nothing saying so; this line
  // is what makes that visible in one command from either side.
  console.log(`Store: ${dataDir} (from ${describeDataDirSource(dataDirSource)})`);
  console.log(`Web: http://localhost:${webPort}${webUp ? "" : " (not running)"}`);
  // Which project THIS directory resolves to, and why. The failure mode of workspace
  // scoping is silent — items land somewhere you never look — so the answer has to be
  // available without reading a log.
  console.log(`Workspace: ${workspace ?? "(unfiled)"} via ${source}${root ? ` at ${root}` : ""}`);
  console.log(`Sessions: ${sessions.length} open`);
  console.log(`Peers: ${activePeers}`);
}

async function runRemoteStatus(serverUrl: string): Promise<void> {
  console.log(`Mode: remote`);
  console.log(`Server: ${serverUrl}`);

  const creds = await loadRemoteCredentials();
  if (!creds || creds.serverUrl !== serverUrl) {
    console.log(`Status: not paired`);
    console.log(`Device authorization: none — run \`docket pair ${serverUrl}\``);
    process.exitCode = 1;
    return;
  }

  const deviceId = await getDeviceId();
  const start = Date.now();
  try {
    const info = await signedGet(serverUrl, deviceId, creds.secret, "/api/v1/info");
    const latency = Date.now() - start;
    if (!info.ok) throw new Error(`GET /api/v1/info responded ${info.status}`);
    const infoBody = info.body as { serverVersion?: string };

    console.log(`Status: connected`);
    console.log(`Latency: ${latency} ms`);
    console.log(`Server version: ${infoBody.serverVersion ?? "unknown"}`);
    console.log(`Device: ${await getDeviceName()}`);

    // /api/v1/info is public (RFC §23) so it alone can't tell us whether THIS device's
    // credentials still work — a lightweight authenticated GET (any device-signed route)
    // is what actually distinguishes "active" from "revoked".
    const authed = await signedGet(serverUrl, deviceId, creds.secret, "/api/v1/todos");
    const authorization = authed.ok ? "active" : authed.status === 401 || authed.status === 403 ? "revoked" : `unknown (status ${authed.status})`;
    console.log(`Device authorization: ${authorization}`);
    if (authorization !== "active") process.exitCode = 1;
  } catch (err) {
    console.log(`Status: unreachable`);
    console.log(`Last error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

export async function runStatusCommand(): Promise<void> {
  let deployment: Awaited<ReturnType<typeof resolveDeploymentConfig>>;
  try {
    deployment = await resolveDeploymentConfig();
  } catch (err) {
    console.error(err instanceof DeploymentConfigError ? err.message : (err as Error).message);
    process.exitCode = 1;
    return;
  }

  if (deployment.mode === "local") {
    await runLocalStatus();
    return;
  }
  await runRemoteStatus(deployment.serverUrl!);
}
