import { createInterface } from "node:readline/promises";
import { beginServerPairing, finishServerPairing, PairingError } from "./pairing.js";

/** `docket pair <serverUrl>` (RFC "Local and Self-Hosted Backend Modes" §11's setup flow, driven directly rather than through the full interactive `docket setup` wizard — that's Phase 4). */
export async function runPairCommand(args: string[]): Promise<void> {
  const serverUrl = args[0];
  if (!serverUrl) {
    console.error("Usage: docket pair <serverUrl>");
    console.error("Example: docket pair https://docket.home.lan");
    process.exitCode = 1;
    return;
  }
  const allowInsecureRemote = process.env.DOCKET_ALLOW_INSECURE_REMOTE === "1" || process.env.DOCKET_ALLOW_INSECURE_REMOTE === "true";

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let code: string;
  try {
    code = (await rl.question("Pairing code (from `docket devices pair` on the server): ")).trim();
  } finally {
    rl.close();
  }
  if (!code) {
    console.error("Error: a pairing code is required.");
    process.exitCode = 1;
    return;
  }

  let step: Awaited<ReturnType<typeof beginServerPairing>>;
  try {
    step = await beginServerPairing(serverUrl, code, allowInsecureRemote);
  } catch (err) {
    console.error(`Error: ${err instanceof PairingError ? err.message : (err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✓ Server reachable`);
  console.log(`✓ docket server v${step.probe.serverVersion}`);
  console.log(`✓ Protocol compatible`);
  console.log("");
  console.log(`Confirmation code: ${step.sas}`);
  console.log("Check that the SAME code appears next to this request on the server (docket devices pending) before approving it there.");
  console.log("");
  console.log("Waiting for approval...");

  const result = await finishServerPairing(serverUrl, step);
  if (result.outcome === "approved") {
    console.log("✓ Device paired");
    console.log("✓ Connection authenticated");
    console.log("✓ Remote workspace ready");
    console.log("");
    console.log("To use it, set:");
    console.log(`  DOCKET_MODE=remote DOCKET_SERVER_URL=${serverUrl}`);
    console.log("or add to ~/.config/docket/config.json:");
    console.log(`  { "version": 1, "deployment": { "mode": "remote", "serverUrl": "${serverUrl}" } }`);
  } else if (result.outcome === "denied") {
    console.error("Pairing was denied on the server.");
    process.exitCode = 1;
  } else {
    console.error("Timed out waiting for approval — the pairing code may have expired. Try again.");
    process.exitCode = 1;
  }
}
