import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// device.ts reads homedir() once at first getOrCreateIdentity() call and caches the
// identity for the lifetime of the module, so each test needs its own process-fresh
// import — dynamic import with a cache-busting query string gets a fresh module
// instance, and HOME is set before that import runs.
async function freshDeviceModule() {
  process.env.HOME = await mkdtemp(join(tmpdir(), "todo-mcp-device-test-"));
  return import(`./device.js?t=${Date.now()}-${Math.random()}`);
}

const originalHome = process.env.HOME;
test.after(() => {
  if (originalHome) process.env.HOME = originalHome;
});

test("getDeviceId/getDeviceName: create and persist a stable identity", async () => {
  const mod = await freshDeviceModule();
  const id1 = await mod.getDeviceId();
  const id2 = await mod.getDeviceId();
  assert.equal(id1, id2, "same process must see the same id (cached)");
  assert.match(id1, /^[0-9a-f-]{36}$/);
  assert.ok((await mod.getDeviceName()).length > 0);
});

test("getDeviceRole: defaults to host on a fresh device", async () => {
  const mod = await freshDeviceModule();
  assert.equal(await mod.getDeviceRole(), "host");
});

test("setDeviceRole: persists and is reflected by getDeviceRole", async () => {
  const mod = await freshDeviceModule();
  assert.equal(await mod.getDeviceRole(), "host");
  await mod.setDeviceRole("guest");
  assert.equal(await mod.getDeviceRole(), "guest");
  await mod.setDeviceRole("host");
  assert.equal(await mod.getDeviceRole(), "host");
});

test("getDevicePublicKey: returns a base64url X25519 coordinate", async () => {
  const mod = await freshDeviceModule();
  const pub = await mod.getDevicePublicKey();
  assert.match(pub, /^[A-Za-z0-9_-]{43}$/); // 32 raw bytes, base64url, no padding
});

test("deriveSharedSecret: two devices derive the identical secret via ECDH", async () => {
  const a = await freshDeviceModule();
  const b = await freshDeviceModule();
  const aPub = await a.getDevicePublicKey();
  const bPub = await b.getDevicePublicKey();
  const secretFromA = await a.deriveSharedSecret(bPub);
  const secretFromB = await b.deriveSharedSecret(aPub);
  assert.equal(secretFromA, secretFromB);
  assert.match(secretFromA, /^[0-9a-f]{64}$/); // 32-byte HKDF output, hex
});
