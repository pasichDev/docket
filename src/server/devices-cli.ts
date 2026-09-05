import { ADMIN_TOKEN_PATH, readAdminToken } from "./admin-token.js";

/**
 * `docket devices pair|pending|approve|deny|list|revoke|restore` — operates the
 * loopback-only admin routes of a `docket serve` process running on THIS machine (RFC
 * "Local and Self-Hosted Backend Modes" §13/§24). A separate CLI-invocation process talking
 * to the running server over HTTP, not in-process, because `docket serve`'s pending-pairing
 * state lives in that long-running process's own memory (server/devices.ts) — exactly the
 * same reason `docket devices pair` is described as a command in RFC §13, not a flag on
 * `docket serve` itself.
 */

function adminBaseUrl(): string {
  const port = Number(process.env.DOCKET_SERVER_PORT ?? 8788);
  return `http://127.0.0.1:${port}/api/v1/admin/devices`;
}

async function adminRequest(method: string, path: string): Promise<{ status: number; body: unknown }> {
  // Read from the data directory, which this command can do because it runs as the same
  // user on the same machine as `docket serve` — and which a request arriving through a
  // reverse proxy cannot. See server/admin-token.ts.
  const token = await readAdminToken();
  if (!token) {
    throw new Error(
      `no admin token in this data directory (${ADMIN_TOKEN_PATH}). It is created by \`docket serve\` on first run — ` +
        `start the server first, and make sure DOCKET_DATA_DIR matches the one it uses.`,
    );
  }
  let res: Response;
  try {
    res = await fetch(`${adminBaseUrl()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    throw new Error(
      `couldn't reach a running \`docket serve\` on 127.0.0.1:${process.env.DOCKET_SERVER_PORT ?? 8788} (${(err as Error).message}). ` +
        `This command must run on the SAME machine as \`docket serve\`, while it's running.`,
    );
  }
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function printHelp(): void {
  console.log(`
docket devices - manage paired devices on a running \`docket serve\` (run on the server machine)

Usage:
  docket devices pair                Generate a short-lived pairing code
  docket devices pending             List devices awaiting approval
  docket devices approve <requestId> Approve a pending pairing request
  docket devices deny <requestId>    Deny a pending pairing request
  docket devices list                List paired devices
  docket devices revoke <deviceId>   Revoke a paired device's access
  docket devices restore <deviceId>  Restore a previously revoked device

Environment variables:
  DOCKET_SERVER_PORT   Port the local \`docket serve\` is listening on (default: 8788)
`);
}

export async function runDevicesCommand(args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase();

  if (sub === "pair") {
    const { status, body } = await adminRequest("POST", "/pairing-code");
    if (status !== 200) {
      console.error(`Error: ${(body as { error?: string })?.error ?? `server responded ${status}`}`);
      process.exitCode = 1;
      return;
    }
    const { code, expiresAt } = body as { code: string; expiresAt: number };
    console.log(code);
    console.log(`Expires in ${Math.max(1, Math.round((expiresAt - Date.now()) / 60_000))} minute(s).`);
    console.log("Give this code to the device being paired (it runs `docket pair <this server's URL>`), then approve it here:");
    console.log("  docket devices pending");
    console.log("  docket devices approve <requestId>");
    return;
  }

  if (sub === "pending") {
    const { status, body } = await adminRequest("GET", "/pending");
    if (status !== 200) {
      console.error(`Error: ${(body as { error?: string })?.error ?? `server responded ${status}`}`);
      process.exitCode = 1;
      return;
    }
    const requests = (body as { requests: Array<{ requestId: string; deviceId: string; deviceName: string; sas: string }> }).requests;
    if (requests.length === 0) {
      console.log("No pending pairing requests.");
      return;
    }
    for (const r of requests) {
      console.log(`${r.requestId}  ${r.deviceName} (${r.deviceId})`);
      console.log(`  Compare this code with what the device shows: ${r.sas}`);
    }
    return;
  }

  if (sub === "approve" || sub === "deny") {
    const requestId = args[1];
    if (!requestId) {
      console.error(`Error: usage: docket devices ${sub} <requestId>`);
      process.exitCode = 1;
      return;
    }
    const { status, body } = await adminRequest("POST", `/pending/${encodeURIComponent(requestId)}/${sub}`);
    if (status !== 200) {
      console.error(`Error: ${(body as { error?: string })?.error ?? `server responded ${status}`}`);
      process.exitCode = 1;
      return;
    }
    console.log(sub === "approve" ? `Approved. Device: ${JSON.stringify((body as { device: unknown }).device)}` : "Denied.");
    return;
  }

  if (sub === "list") {
    const { status, body } = await adminRequest("GET", "");
    if (status !== 200) {
      console.error(`Error: ${(body as { error?: string })?.error ?? `server responded ${status}`}`);
      process.exitCode = 1;
      return;
    }
    const devices = (body as { devices: Array<{ id: string; name: string; pairedAt: string; revoked?: boolean }> }).devices;
    if (devices.length === 0) {
      console.log("No paired devices.");
      return;
    }
    for (const d of devices) {
      console.log(`${d.id}  ${d.name}  paired ${d.pairedAt}${d.revoked ? "  [REVOKED]" : ""}`);
    }
    return;
  }

  if (sub === "revoke" || sub === "restore") {
    const deviceId = args[1];
    if (!deviceId) {
      console.error(`Error: usage: docket devices ${sub} <deviceId>`);
      process.exitCode = 1;
      return;
    }
    const { status, body } = await adminRequest("POST", `/${encodeURIComponent(deviceId)}/${sub}`);
    if (status !== 200) {
      console.error(`Error: ${(body as { error?: string })?.error ?? `server responded ${status}`}`);
      process.exitCode = 1;
      return;
    }
    console.log(sub === "revoke" ? `Revoked ${deviceId}.` : `Restored ${deviceId}.`);
    return;
  }

  printHelp();
}
