import assert from "node:assert/strict";
import { test } from "node:test";
import { listEvents, recordCreated, recordResolved } from "./notifications.js";

test("recordCreated: shows up as pending while its id is still live", () => {
  const id = `created-${Date.now()}-${Math.random()}`;
  recordCreated(id, "pairing", "Some Device");
  const found = listEvents(new Set([id])).find((e) => e.id === id)!;
  assert.equal(found.status, "pending");
  assert.equal(found.kind, "pairing");
  assert.equal(found.label, "Some Device");
  assert.equal(found.resolvedAt, null);
});

test("recordResolved: approved sticks even after the id drops out of the live set", () => {
  const id = `approved-${Date.now()}-${Math.random()}`;
  recordCreated(id, "access", "10.0.0.5");
  recordResolved(id, "approved");
  const found = listEvents(new Set()).find((e) => e.id === id)!;
  assert.equal(found.status, "approved");
  assert.ok(found.resolvedAt !== null);
});

test("listEvents: a pending id no longer in the live set is lazily marked expired", () => {
  const id = `expired-${Date.now()}-${Math.random()}`;
  recordCreated(id, "pairing", "Ghost Device");
  const found = listEvents(new Set()).find((e) => e.id === id)!; // id not passed as live
  assert.equal(found.status, "expired");
  assert.ok(found.resolvedAt !== null);
});

test("recordResolved: a no-op on an id that was never created", () => {
  assert.doesNotThrow(() => recordResolved("never-existed", "denied"));
});

test("recordResolved: does not flip an already-resolved event to a different status", () => {
  const id = `double-resolve-${Date.now()}-${Math.random()}`;
  recordCreated(id, "access", "10.0.0.6");
  recordResolved(id, "approved");
  recordResolved(id, "denied");
  const found = listEvents(new Set()).find((e) => e.id === id)!;
  assert.equal(found.status, "approved");
});
