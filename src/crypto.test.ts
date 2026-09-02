import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.TODO_MCP_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "todo-mcp-crypto-test-"));
process.env.TODO_MCP_DATA_DIR = dataDirectory;
const { decryptWithKey, encryptWithKey } = await import("./crypto.js");

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.TODO_MCP_DATA_DIR;
  else process.env.TODO_MCP_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

test("encryptWithKey/decryptWithKey: round-trips", () => {
  const key = randomBytes(32);
  const plaintext = JSON.stringify({ hello: "world", n: 42 });
  const encrypted = encryptWithKey(key, plaintext);
  assert.equal(decryptWithKey(key, encrypted), plaintext);
});

test("encryptWithKey: output is not the plaintext, and varies per call (random IV)", () => {
  const key = randomBytes(32);
  const plaintext = "sensitive todo content";
  const a = encryptWithKey(key, plaintext);
  const b = encryptWithKey(key, plaintext);
  assert.ok(!a.toString("utf8").includes(plaintext));
  assert.ok(!Buffer.from(a).equals(Buffer.from(b)), "same plaintext should not produce identical ciphertext twice");
});

test("decryptWithKey: rejects data encrypted under a different key", () => {
  const keyA = randomBytes(32);
  const keyB = randomBytes(32);
  const encrypted = encryptWithKey(keyA, "secret");
  assert.throws(() => decryptWithKey(keyB, encrypted));
});

test("decryptWithKey: rejects a tampered ciphertext (GCM auth tag)", () => {
  const key = randomBytes(32);
  const encrypted = encryptWithKey(key, "secret");
  encrypted[encrypted.length - 1] ^= 0xff; // flip a bit in the ciphertext tail
  assert.throws(() => decryptWithKey(key, encrypted));
});
