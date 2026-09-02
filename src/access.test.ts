import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveAccessRequest,
  checkAccessRateLimit,
  createAccessRequest,
  denyAccessRequest,
  listAccessRequests,
  pollAccessRequest,
} from "./access.js";

test("createAccessRequest/pollAccessRequest: a fresh request is pending", () => {
  const id = createAccessRequest("10.0.0.5");
  assert.deepEqual(pollAccessRequest(id), { status: "pending" });
  assert.ok(listAccessRequests().some((r) => r.requestId === id));
});

test("approveAccessRequest: hands the token to exactly one poll, then the request is gone", () => {
  const id = createAccessRequest("10.0.0.6");
  assert.ok(approveAccessRequest(id, "the-token"));
  const first = pollAccessRequest(id);
  assert.deepEqual(first, { status: "approved", token: "the-token" });
  // Consumed — a second poll after delivery finds nothing, not the token again.
  assert.deepEqual(pollAccessRequest(id), { status: "expired" });
});

test("denyAccessRequest: reported once, then the request disappears", () => {
  const id = createAccessRequest("10.0.0.7");
  assert.ok(denyAccessRequest(id));
  assert.deepEqual(pollAccessRequest(id), { status: "denied" });
  assert.deepEqual(pollAccessRequest(id), { status: "expired" });
});

test("approveAccessRequest/denyAccessRequest: false on an unknown or already-resolved id", () => {
  assert.equal(approveAccessRequest("nope", "t"), false);
  assert.equal(denyAccessRequest("nope"), false);
  const id = createAccessRequest("10.0.0.8");
  assert.ok(denyAccessRequest(id));
  assert.equal(approveAccessRequest(id, "t"), false); // already resolved, can't flip to approved
});

test("pollAccessRequest: an unknown id reads as expired, not pending", () => {
  assert.deepEqual(pollAccessRequest("never-existed"), { status: "expired" });
});

test("checkAccessRateLimit: caps attempts per source IP within the window", () => {
  const ip = "10.0.0.9";
  let allowed = 0;
  for (let i = 0; i < 10; i++) {
    if (checkAccessRateLimit(ip)) allowed += 1;
  }
  assert.ok(allowed < 10); // some calls were rejected
  assert.ok(allowed >= 1);
  // A different source IP has its own independent budget.
  assert.equal(checkAccessRateLimit("10.0.0.10"), true);
});
