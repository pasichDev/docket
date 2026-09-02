import assert from "node:assert/strict";
import { test } from "node:test";
import { generateNonce, hashBody, resetNonceCacheForTests, signDeviceRequest, verifyDeviceRequest } from "./device-auth.js";

const SECRET = "a".repeat(64);

function freshRequest(overrides: Partial<{ method: string; path: string; body: string }> = {}) {
  const method = overrides.method ?? "POST";
  const path = overrides.path ?? "/api/v1/todos";
  const body = overrides.body ?? '{"title":"x"}';
  const timestamp = new Date().toISOString();
  const nonce = generateNonce();
  const bodyHash = hashBody(body);
  const signature = signDeviceRequest(SECRET, method, path, timestamp, nonce, bodyHash);
  return { method, path, timestamp, nonce, bodyHash, signature };
}

test.beforeEach(() => resetNonceCacheForTests());

test("verifyDeviceRequest: accepts a correctly signed request", () => {
  const r = freshRequest();
  const result = verifyDeviceRequest(SECRET, "device-1", r.method, r.path, r.timestamp, r.nonce, r.bodyHash, r.signature);
  assert.equal(result.ok, true);
});

test("verifyDeviceRequest: rejects a wrong secret", () => {
  const r = freshRequest();
  const result = verifyDeviceRequest("b".repeat(64), "device-1", r.method, r.path, r.timestamp, r.nonce, r.bodyHash, r.signature);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "bad_signature");
});

test("verifyDeviceRequest: tampering with ANY signed field invalidates the signature — method, path, timestamp, nonce, body", () => {
  const r = freshRequest();
  const mutations: Array<Partial<typeof r>> = [
    { method: "GET" },
    { path: "/api/v1/todos/T-OTHER" },
    { nonce: generateNonce() },
    { bodyHash: hashBody('{"title":"different"}') },
  ];
  for (const mutation of mutations) {
    const tampered = { ...r, ...mutation };
    const result = verifyDeviceRequest(SECRET, "device-1", tampered.method, tampered.path, tampered.timestamp, tampered.nonce, tampered.bodyHash, tampered.signature);
    assert.equal(result.ok, false, `expected tampering with ${JSON.stringify(mutation)} to invalidate the signature`);
  }
});

test("verifyDeviceRequest: rejects a timestamp far outside the allowed window", () => {
  const r = freshRequest();
  const staleTimestamp = new Date(Date.now() - 60 * 60_000).toISOString(); // 1 hour old
  const staleSignature = signDeviceRequest(SECRET, r.method, r.path, staleTimestamp, r.nonce, r.bodyHash);
  const result = verifyDeviceRequest(SECRET, "device-1", r.method, r.path, staleTimestamp, r.nonce, r.bodyHash, staleSignature);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "timestamp_out_of_range");
});

test("verifyDeviceRequest: rejects a malformed (non-parseable) timestamp", () => {
  const r = freshRequest();
  const result = verifyDeviceRequest(SECRET, "device-1", r.method, r.path, "not-a-date", r.nonce, r.bodyHash, r.signature);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "timestamp_out_of_range");
});

test("verifyDeviceRequest: replaying the exact same request twice is rejected the second time (RFC §14/§31/§37.6)", () => {
  const r = freshRequest();
  const first = verifyDeviceRequest(SECRET, "device-1", r.method, r.path, r.timestamp, r.nonce, r.bodyHash, r.signature);
  assert.equal(first.ok, true);
  const second = verifyDeviceRequest(SECRET, "device-1", r.method, r.path, r.timestamp, r.nonce, r.bodyHash, r.signature);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "replayed_nonce");
});

test("verifyDeviceRequest: the SAME nonce from a DIFFERENT device is not treated as a replay (nonce cache is keyed per-device)", () => {
  const r = freshRequest();
  const first = verifyDeviceRequest(SECRET, "device-1", r.method, r.path, r.timestamp, r.nonce, r.bodyHash, r.signature);
  assert.equal(first.ok, true);
  const otherSignature = signDeviceRequest(SECRET, r.method, r.path, r.timestamp, r.nonce, r.bodyHash);
  const second = verifyDeviceRequest(SECRET, "device-2", r.method, r.path, r.timestamp, r.nonce, r.bodyHash, otherSignature);
  assert.equal(second.ok, true);
});

test("verifyDeviceRequest: an invalid signature does NOT get recorded in the replay cache (a guessed nonce can't burn a legitimate future request)", () => {
  const r = freshRequest();
  const badSig = verifyDeviceRequest(SECRET, "device-1", r.method, r.path, r.timestamp, r.nonce, r.bodyHash, "not-the-real-signature");
  assert.equal(badSig.ok, false);
  const goodSig = verifyDeviceRequest(SECRET, "device-1", r.method, r.path, r.timestamp, r.nonce, r.bodyHash, r.signature);
  assert.equal(goodSig.ok, true);
});

test("hashBody: is a pure deterministic function of the exact bytes, sensitive to whitespace", () => {
  assert.equal(hashBody('{"a":1}'), hashBody('{"a":1}'));
  assert.notEqual(hashBody('{"a":1}'), hashBody('{"a": 1}'));
});
