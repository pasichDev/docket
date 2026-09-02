import { deriveServerAuthSecret, getDeviceId, getDeviceName, getDevicePublicKey } from "../device.js";
import { pairingSas } from "../sync.js";
import { assertSecureRemoteUrl } from "../config.js";
import { saveRemoteCredentials } from "./credentials.js";
import { CLIENT_PROTOCOL_VERSION, MIN_COMPATIBLE_SERVER_PROTOCOL } from "./protocol.js";

/**
 * Client-side half of RFC "Local and Self-Hosted Backend Modes" §13 (Pairing) — the
 * `docket pair <serverUrl>` flow. Reuses the same X25519 ECDH + SAS building blocks the
 * existing P2P pairing UX already relies on (device.ts, sync.ts's pairingSas), adapted for
 * "pair with a server" instead of "pair with a peer": the server publishes its own
 * identity via the public GET /api/v1/info (RFC §23) rather than an out-of-band QR/code
 * carrying it, since a headless server has no screen to show one on.
 */

export interface ServerInfo {
  product: string;
  serverVersion: string;
  protocolVersion: number;
  minClientProtocol: number;
  deviceId: string;
  devicePublicKeyX: string;
}

export class PairingError extends Error {}

async function fetchServerInfo(serverUrl: string): Promise<ServerInfo> {
  let res: Response;
  try {
    res = await fetch(`${serverUrl.replace(/\/$/, "")}/api/v1/info`, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    throw new PairingError(`couldn't reach ${serverUrl}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new PairingError(`${serverUrl} responded ${res.status} to GET /api/v1/info`);
  const info = (await res.json().catch(() => null)) as Partial<ServerInfo> | null;
  if (
    !info ||
    info.product !== "docket" ||
    typeof info.protocolVersion !== "number" ||
    typeof info.deviceId !== "string" ||
    typeof info.devicePublicKeyX !== "string"
  ) {
    throw new PairingError(`${serverUrl} doesn't look like a docket server`);
  }
  if (info.protocolVersion < MIN_COMPATIBLE_SERVER_PROTOCOL) {
    throw new PairingError(`server protocol v${info.protocolVersion} is older than this client supports (min v${MIN_COMPATIBLE_SERVER_PROTOCOL})`);
  }
  if (typeof info.minClientProtocol === "number" && info.minClientProtocol > CLIENT_PROTOCOL_VERSION) {
    throw new PairingError(`server requires client protocol v${info.minClientProtocol}+, this client is v${CLIENT_PROTOCOL_VERSION} — update docket`);
  }
  return info as ServerInfo;
}

export interface PairingStep {
  probe: ServerInfo;
  sas: string;
  requestId: string;
}

/**
 * Checks reachability/version/protocol compatibility only — no pairing code, no identity
 * exchange. Split out from beginServerPairing so a caller (the `docket setup` wizard's
 * RFC §11 "Connecting... / Server reachable / version / Protocol compatible" ticks) can
 * show these before ever asking the human for a pairing code, instead of only finding out
 * the server is unreachable after they've typed one in.
 */
export async function probeServer(serverUrl: string, allowInsecureRemote: boolean): Promise<ServerInfo> {
  assertSecureRemoteUrl(serverUrl, allowInsecureRemote);
  return fetchServerInfo(serverUrl);
}

/**
 * Step 1: probes compatibility, derives this device's copy of the shared secret via ECDH
 * against the server's public key, and submits the pairing code — returning the SAS for
 * the human to compare against what the server operator's approval screen shows BEFORE
 * step 2 waits for approval. Splitting probe+submit from poll+persist (rather than one
 * function that blocks until approved) is what lets a CLI print the SAS immediately.
 */
export async function beginServerPairing(serverUrl: string, code: string, allowInsecureRemote: boolean): Promise<PairingStep> {
  const probe = await probeServer(serverUrl, allowInsecureRemote);
  const secret = await deriveServerAuthSecret(probe.devicePublicKeyX);
  const ownPublicKeyX = await getDevicePublicKey();
  const sas = pairingSas(secret, ownPublicKeyX, probe.devicePublicKeyX);

  const res = await fetch(`${serverUrl.replace(/\/$/, "")}/api/v1/pair/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceId: await getDeviceId(), deviceName: await getDeviceName(), publicKeyX: ownPublicKeyX }),
    signal: AbortSignal.timeout(8000),
  }).catch((err) => {
    throw new PairingError(`couldn't submit the pairing code: ${(err as Error).message}`);
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PairingError(body.error ?? `server responded ${res.status} to the pairing request`);
  }
  const body = (await res.json()) as { requestId: string; sas: string };

  // The server independently derived the SAME secret via ECDH and computed its own SAS —
  // if they don't match, either side derived against the WRONG public key (a substituted
  // key, i.e. an active MITM). Abort before ever polling for approval or saving anything.
  if (body.sas !== sas) {
    throw new PairingError(
      `SAS mismatch (this device computed ${sas}, server computed ${body.sas}) — refusing to continue. This can indicate a network attacker substituted a public key; do not approve this request on the server.`,
    );
  }
  return { probe, sas, requestId: body.requestId };
}

export type PairingPollResult = { status: "approved" } | { status: "denied" } | { status: "pending" };

export async function pollServerPairing(serverUrl: string, requestId: string): Promise<PairingPollResult> {
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}/api/v1/pair/status/${encodeURIComponent(requestId)}`, {
    signal: AbortSignal.timeout(8000),
  }).catch((err) => {
    throw new PairingError(`couldn't check pairing status: ${(err as Error).message}`);
  });
  if (!res.ok) throw new PairingError(`server responded ${res.status} checking pairing status`);
  const body = (await res.json()) as { status: "pending" | "approved" | "denied" };
  return { status: body.status };
}

/**
 * Step 2: polls until approved/denied (bounded — RFC §13's pairing codes are short-lived,
 * so this doesn't wait forever either) and, once approved, persists credentials. The
 * secret itself is re-derived here rather than threaded through from step 1, since it's a
 * pure function of (this device's private key, the server's public key) — cheaper and
 * safer than passing a secret across an async boundary an interactive CLI might hold open
 * for minutes while the operator clicks Approve.
 */
export async function finishServerPairing(
  serverUrl: string,
  step: PairingStep,
  pollIntervalMs = 2000,
  timeoutMs = 5 * 60_000,
): Promise<{ outcome: "approved" | "denied" | "timed_out" }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await pollServerPairing(serverUrl, step.requestId);
    if (result.status === "approved") {
      const secret = await deriveServerAuthSecret(step.probe.devicePublicKeyX);
      await saveRemoteCredentials({
        serverUrl,
        serverDeviceId: step.probe.deviceId,
        secret,
        pairedAt: new Date().toISOString(),
      });
      return { outcome: "approved" };
    }
    if (result.status === "denied") return { outcome: "denied" };
    if (Date.now() > deadline) return { outcome: "timed_out" };
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
