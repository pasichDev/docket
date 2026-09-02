import assert from "node:assert/strict";
import { test } from "node:test";
import { uuidv7 } from "./uuid7.js";

test("uuidv7: matches the RFC 9562 shape (version 7, variant 10)", () => {
  const id = uuidv7();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("uuidv7: unique across many calls", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()));
  assert.equal(ids.size, 1000);
});

test("uuidv7: sorts in creation order across distinct milliseconds", async () => {
  const a = uuidv7();
  await new Promise((r) => setTimeout(r, 5));
  const b = uuidv7();
  assert.ok(a < b, `${a} should sort before ${b}`);
});
