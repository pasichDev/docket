import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { decryptWithKey, encryptWithKey } from "./crypto.js";

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
