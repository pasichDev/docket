import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const deviceModule = pathToFileURL(join(process.cwd(), "dist", "device.js")).href;

async function runDevice<T>(directory: string, action: string, argument?: string): Promise<T> {
  const script = `
    const device = await import(${JSON.stringify(deviceModule)});
    const action = ${JSON.stringify(action)};
    const argument = ${JSON.stringify(argument)};
    let result;
    if (action === "identity") result = {
      first: await device.getDeviceId(),
      second: await device.getDeviceId(),
      name: await device.getDeviceName(),
    };
    else if (action === "role") result = await device.getDeviceRole();
    else if (action === "set-role") { await device.setDeviceRole(argument); result = await device.getDeviceRole(); }
    else if (action === "public-key") result = await device.getDevicePublicKey();
    else if (action === "derive") result = await device.deriveSharedSecret(argument);
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, TODO_MCP_DATA_DIR: directory },
  });
  return JSON.parse(stdout) as T;
}

async function withDeviceDirectory<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "todo-mcp-device-test-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("getDeviceId/getDeviceName: create and persist a stable identity", () => withDeviceDirectory(async (directory) => {
  const firstRuntime = await runDevice<{ first: string; second: string; name: string }>(directory, "identity");
  const secondRuntime = await runDevice<{ first: string; second: string; name: string }>(directory, "identity");
  assert.equal(firstRuntime.first, firstRuntime.second, "same runtime must return its cached identity");
  assert.equal(firstRuntime.first, secondRuntime.first, "a fresh runtime must reuse the persisted identity");
  assert.match(firstRuntime.first, /^[0-9a-f-]{36}$/);
  assert.ok(firstRuntime.name.length > 0);
}));

test("getDeviceId: simultaneous first starts converge on one persisted identity", () => withDeviceDirectory(async (directory) => {
  const [first, second] = await Promise.all([
    runDevice<{ first: string }>(directory, "identity"),
    runDevice<{ first: string }>(directory, "identity"),
  ]);
  const reopened = await runDevice<{ first: string }>(directory, "identity");
  assert.equal(first.first, second.first);
  assert.equal(first.first, reopened.first);
}));

test("getDeviceRole: defaults to host on a fresh device", () => withDeviceDirectory(async (directory) => {
  assert.equal(await runDevice(directory, "role"), "host");
}));

test("setDeviceRole: persists across a fresh runtime", () => withDeviceDirectory(async (directory) => {
  assert.equal(await runDevice(directory, "set-role", "guest"), "guest");
  assert.equal(await runDevice(directory, "role"), "guest");
  assert.equal(await runDevice(directory, "set-role", "host"), "host");
}));

test("getDevicePublicKey: returns a base64url X25519 coordinate", () => withDeviceDirectory(async (directory) => {
  const publicKey = await runDevice<string>(directory, "public-key");
  assert.match(publicKey, /^[A-Za-z0-9_-]{43}$/);
}));

test("deriveSharedSecret: two independently initialized devices derive the identical secret", async () => {
  const firstDirectory = await mkdtemp(join(tmpdir(), "todo-mcp-device-a-test-"));
  const secondDirectory = await mkdtemp(join(tmpdir(), "todo-mcp-device-b-test-"));
  try {
    const firstPublicKey = await runDevice<string>(firstDirectory, "public-key");
    const secondPublicKey = await runDevice<string>(secondDirectory, "public-key");
    assert.notEqual(firstPublicKey, secondPublicKey, "the two devices must not share an identity");
    const firstSecret = await runDevice<string>(firstDirectory, "derive", secondPublicKey);
    const secondSecret = await runDevice<string>(secondDirectory, "derive", firstPublicKey);
    assert.equal(firstSecret, secondSecret);
    assert.match(firstSecret, /^[0-9a-f]{64}$/);
  } finally {
    await Promise.all([
      rm(firstDirectory, { recursive: true, force: true }),
      rm(secondDirectory, { recursive: true, force: true }),
    ]);
  }
});
