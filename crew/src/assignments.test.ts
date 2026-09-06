import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTransition,
  AssignmentBook,
  AssignmentTransitionError,
  canTransition,
  createAssignment,
  releaseAssignmentClaim,
  shouldRetry,
} from "./assignments.js";
import { FakeBus, FakeStore } from "./testsupport.js";
import type { Assignment, AssignmentStatus } from "./types.js";

function make(status: AssignmentStatus = "queued", attempts = 0): Assignment {
  return {
    ...createAssignment({ title: "t", instructions: "i", workspace: "w", assignedBy: "m", assignedTo: "w1" }),
    status,
    attempts,
  };
}

test("the transition table matches the spec'd lifecycle and rejects everything else", () => {
  assert.ok(canTransition("queued", "running"));
  assert.ok(canTransition("running", "done"));
  assert.ok(canTransition("running", "waiting"));
  assert.ok(canTransition("waiting", "running"));
  assert.ok(canTransition("review", "done"));
  assert.ok(canTransition("review", "queued"), "a rejected review goes back to the QUEUE, where the pump can find it");

  // Terminal states are terminal — except failed→queued, which is the retry path only.
  assert.equal(canTransition("done", "running"), false);
  assert.equal(canTransition("cancelled", "running"), false);
  assert.equal(canTransition("queued", "done"), false, "work cannot finish before it starts");
  assert.equal(canTransition("failed", "done"), false, "a failure can never be relabelled a success");
});

test("applyTransition counts attempts on start and stamps finishedAt on terminal states", () => {
  const a = make();
  applyTransition(a, "running");
  assert.equal(a.attempts, 1);
  assert.ok(a.startedAt);
  applyTransition(a, "done");
  assert.ok(a.finishedAt);
  assert.throws(() => applyTransition(a, "running"), AssignmentTransitionError);
});

test("shouldRetry honours the retry budget and stops", () => {
  assert.equal(shouldRetry(make("failed", 1), 1), true, "first failure is retried once");
  assert.equal(shouldRetry(make("failed", 2), 1), false, "the retry itself is not retried");
  assert.equal(shouldRetry(make("failed", 1), 0), false, "maxRetries=0 means no automatic retry at all");
});

test("AssignmentBook.fail requeues within budget, then stops and leaves it for the manager", async () => {
  const store = new FakeStore();
  const bus = new FakeBus();
  const book = new AssignmentBook(store, bus, 1);

  const created = await book.create({ title: "fix it", instructions: "…", workspace: "w", assignedBy: "m", assignedTo: "w1" });

  await book.start(created.id);
  const first = await book.fail(created.id, { summary: "boom" });
  assert.equal(first.retried, true);
  assert.equal(first.assignment.status, "queued", "an automatic retry goes back to the queue");
  assert.equal(first.assignment.attempts, 1);

  await book.start(created.id);
  const second = await book.fail(created.id, { summary: "boom again" });
  assert.equal(second.retried, false, "budget spent — the manager must decide now");
  assert.equal(second.assignment.status, "failed");
  assert.equal(second.assignment.attempts, 2);

  // And it stays failed: no further automatic transition is possible.
  await assert.rejects(() => book.start(created.id), AssignmentTransitionError);
  assert.equal(bus.count("assignment.failed"), 2);
});

test("a completed assignment records the result and cannot be reopened", async () => {
  const store = new FakeStore();
  const book = new AssignmentBook(store, new FakeBus(), 1);
  const created = await book.create({ title: "t", instructions: "i", workspace: "w", assignedBy: "m", assignedTo: "w1" });
  await book.start(created.id);
  const done = await book.complete(created.id, { summary: "shipped", branch: "crew/abc-codex" });
  assert.equal(done.status, "done");
  assert.equal(done.result?.branch, "crew/abc-codex");
  await assert.rejects(() => book.fail(created.id, { summary: "actually no" }), AssignmentTransitionError);
});

test("a rejected review sends the assignment back to the queue, an approval finishes it", async () => {
  const store = new FakeStore();
  const bus = new FakeBus();
  const book = new AssignmentBook(store, bus, 1);
  const created = await book.create({ title: "t", instructions: "i", workspace: "w", assignedBy: "m", assignedTo: "w1" });
  await book.start(created.id);
  await book.requestReview(created.id, { summary: "please check" });

  const rejected = await book.completeReview(created.id, false, "the retry only covers network errors");
  // `running` would mean "somebody is taking a turn on this", which is exactly what nobody is
  // doing after a rejection — and the pump only ever dispatches `queued`.
  assert.equal(rejected.status, "queued");
  assert.match(rejected.result?.summary ?? "", /network errors/);

  await book.start(created.id);
  await book.requestReview(created.id);
  const approved = await book.completeReview(created.id, true, "verified");
  assert.equal(approved.status, "done");
  assert.equal(bus.count("review.completed"), 2);
});

test("rework is not a retry: a rejection must not spend the budget of a failure that never happened", async () => {
  const store = new FakeStore();
  const book = new AssignmentBook(store, new FakeBus(), 1);
  const created = await book.create({ title: "t", instructions: "i", workspace: "w", assignedBy: "m", assignedTo: "w1" });

  await book.start(created.id); // attempt 1: the real run
  await book.requestReview(created.id, { summary: "have a look" });
  const rejected = await book.completeReview(created.id, false, "not good enough");
  assert.equal(rejected.reworks, 1, "the rework is counted, separately from the attempts");

  await book.start(created.id); // attempt 2 — but it is REWORK, not a retry
  const failure = await book.fail(created.id, { summary: "compile error" });
  assert.equal(failure.retried, true, "the FIRST genuine failure must still get §45's automatic retry");
  assert.equal(failure.assignment.status, "queued");
});

test("shouldRetry subtracts rework from the attempt count", () => {
  const reworked = make("failed", 2);
  reworked.reworks = 1;
  assert.equal(shouldRetry(reworked, 1), true, "one run + one rejection is not two failures");
  reworked.attempts = 3;
  assert.equal(shouldRetry(reworked, 1), false, "and the budget still runs out");
});

test("releaseAssignmentClaim hands a claim back without spending an attempt", () => {
  const claimed = make("queued");
  applyTransition(claimed, "running");
  assert.equal(claimed.attempts, 1);

  releaseAssignmentClaim(claimed);
  assert.equal(claimed.status, "queued", "an assignment nobody is running must be dispatchable again");
  assert.equal(claimed.attempts, 0, "a turn that never started must not spend the retry budget");
  assert.equal(claimed.startedAt, undefined);
});
