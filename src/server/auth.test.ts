import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-auth-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;

// storage.ts/device.ts/devices.ts all resolve their on-disk paths from DOCKET_DATA_DIR at
// module-load time via a top-level await — it MUST be set before this dynamic import, not
// before a static one, or this file would silently touch the real ~/.docket.
const { checkDeviceAuth } = await import("./auth.js");
const { approvePairingRequest, createPairingCode, requestPairing, revokeDevice } = await import("./devices.js");
const { generateNonce, hashBody, signDeviceRequest, resetNonceCacheForTests } = await import("../remote/device-auth.js");
const { getDevicePublicKey } = await import("../device.js");

test.after(async () => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

test.beforeEach(() => resetNonceCacheForTests());

function fakeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as IncomingMessage;
}

/** A real client identity paired against this test's own server data dir — same X25519+ECDH math both sides actually use, not a stub. */
async function pairFakeDevice(deviceName = "test-client"): Promise<{ deviceId: string; secret: string }> {
  const { generateKeyPairSync } = await import("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  void privateKey; // the client's own private key never needs to leave the "client" side; we only need its public half + the secret an ECDH against it produces
  const publicKeyX = (publicKey.export({ format: "jwk" }) as { x: string }).x;

  const deviceId = `test-device-${Math.random().toString(36).slice(2)}`;
  const { code } = createPairingCode();
  const outcome = await requestPairing(code, deviceId, deviceName, publicKeyX);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error("unreachable");
  const device = await approvePairingRequest(outcome.requestId);
  assert.ok(device);
  return { deviceId, secret: device!.secret };
}

function sign(secret: string, method: string, path: string, body = ""): { timestamp: string; nonce: string; signature: string } {
  const timestamp = new Date().toISOString();
  const nonce = generateNonce();
  const signature = signDeviceRequest(secret, method, path, timestamp, nonce, hashBody(body));
  return { timestamp, nonce, signature };
}

test("checkDeviceAuth: accepts a correctly signed request from a paired device", async () => {
  const { deviceId, secret } = await pairFakeDevice();
  const { timestamp, nonce, signature } = sign(secret, "GET", "/api/v1/todos");
  const result = await checkDeviceAuth(
    fakeReq({ "x-docket-device": deviceId, "x-docket-timestamp": timestamp, "x-docket-nonce": nonce, "x-docket-signature": signature }),
    "GET",
    "/api/v1/todos",
    "",
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.device.id, deviceId);
});

test("checkDeviceAuth: rejects missing auth headers", async () => {
  const result = await checkDeviceAuth(fakeReq({}), "GET", "/api/v1/todos", "");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 401);
});

test("checkDeviceAuth: rejects an unknown deviceId (never paired)", async () => {
  const { timestamp, nonce, signature } = sign("f".repeat(64), "GET", "/api/v1/todos");
  const result = await checkDeviceAuth(
    fakeReq({ "x-docket-device": "never-paired", "x-docket-timestamp": timestamp, "x-docket-nonce": nonce, "x-docket-signature": signature }),
    "GET",
    "/api/v1/todos",
    "",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 401);
});

test("checkDeviceAuth: rejects a revoked device even though its signature is still perfectly valid (RFC §37.5)", async () => {
  const { deviceId, secret } = await pairFakeDevice("revoke-me");
  await revokeDevice(deviceId);
  const { timestamp, nonce, signature } = sign(secret, "GET", "/api/v1/todos");
  const result = await checkDeviceAuth(
    fakeReq({ "x-docket-device": deviceId, "x-docket-timestamp": timestamp, "x-docket-nonce": nonce, "x-docket-signature": signature }),
    "GET",
    "/api/v1/todos",
    "",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /revoked/);
});

test("checkDeviceAuth: rejects a tampered body (signature covers the body hash)", async () => {
  const { deviceId, secret } = await pairFakeDevice();
  const { timestamp, nonce, signature } = sign(secret, "POST", "/api/v1/todos", '{"title":"original"}');
  const result = await checkDeviceAuth(
    fakeReq({ "x-docket-device": deviceId, "x-docket-timestamp": timestamp, "x-docket-nonce": nonce, "x-docket-signature": signature }),
    "POST",
    "/api/v1/todos",
    '{"title":"tampered"}',
  );
  assert.equal(result.ok, false);
});

test("checkDeviceAuth: rejects a replayed request the second time", async () => {
  const { deviceId, secret } = await pairFakeDevice();
  const { timestamp, nonce, signature } = sign(secret, "GET", "/api/v1/todos");
  const headers = { "x-docket-device": deviceId, "x-docket-timestamp": timestamp, "x-docket-nonce": nonce, "x-docket-signature": signature };
  const first = await checkDeviceAuth(fakeReq(headers), "GET", "/api/v1/todos", "");
  assert.equal(first.ok, true);
  const second = await checkDeviceAuth(fakeReq(headers), "GET", "/api/v1/todos", "");
  assert.equal(second.ok, false);
});

test("real ECDH round-trip: the CLIENT-side derivation (its own private key + the server's public key) matches what the server stored at pairing time (its own private key + the client's public key) — proving genuine two-sided ECDH, not a one-sided stub", async () => {
  const serverPublicKeyX = await getDevicePublicKey();
  const { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } = await import("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const clientPublicKeyX = (publicKey.export({ format: "jwk" }) as { x: string }).x;

  const deviceId = "ecdh-roundtrip-device";
  const { code } = createPairingCode();
  const outcome = await requestPairing(code, deviceId, "ecdh-test", clientPublicKeyX);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error("unreachable");
  const device = await approvePairingRequest(outcome.requestId);
  assert.ok(device);
  // Server-side derivation happened INSIDE requestPairing, via deriveServerAuthSecret bound
  // to this process's own device.json identity — that's `device!.secret`, computed against
  // the client's public key using the SERVER's private key.

  // Now derive the CLIENT side independently: the client's own private key + the server's
  // public key, using the exact same HKDF label as device.ts's deriveServerAuthSecret
  // (reproduced here since that function is bound to a single process-wide identity and
  // can't be called with an arbitrary private key).
  const serverPublicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: serverPublicKeyX }, format: "jwk" });
  const shared = diffieHellman({ privateKey: createPrivateKey({ key: privateKey.export({ format: "jwk" }), format: "jwk" }), publicKey: serverPublicKey });
  const clientSideSecret = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("docket/server-auth/v1"), 32)).toString("hex");

  assert.equal(device!.secret, clientSideSecret, "ECDH must be commutative: server(serverPriv, clientPub) === client(clientPriv, serverPub)");

  // And the practical consequence: a request signed with the CLIENT's own independently
  // derived secret is accepted by checkDeviceAuth, exactly as a real paired client's would.
  const { timestamp, nonce, signature } = sign(clientSideSecret, "GET", "/api/v1/todos");
  const result = await checkDeviceAuth(
    fakeReq({ "x-docket-device": deviceId, "x-docket-timestamp": timestamp, "x-docket-nonce": nonce, "x-docket-signature": signature }),
    "GET",
    "/api/v1/todos",
    "",
  );
  assert.equal(result.ok, true);
});
