import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClaudeResumeArgs, buildClaudeStartArgs, createClaudeEventMapper } from "./claude.js";
import { readFixture, replayThroughMapper } from "./testsupport.js";

const SESSION = "c0ffee00-1111-2222-3333-444455556666";

test("claude: start argv matches the proven invocation", () => {
  assert.deepEqual(buildClaudeStartArgs({ prompt: "hi" }), [
    "-p",
    "hi",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  assert.deepEqual(buildClaudeStartArgs({ prompt: "hi", model: "haiku" }), [
    "-p",
    "hi",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "haiku",
  ]);
});

test("claude: resume argv appends --resume <session>", () => {
  assert.deepEqual(buildClaudeResumeArgs({ prompt: "again", nativeSessionId: SESSION }), [
    "-p",
    "again",
    "--output-format",
    "stream-json",
    "--verbose",
    "--resume",
    SESSION,
  ]);
});

test("claude: recorded stream normalizes to the expected AgentEvent sequence", () => {
  const events = replayThroughMapper(readFixture("claude.jsonl"), createClaudeEventMapper());
  assert.deepEqual(events, [
    // session surfaces from the very first event, before any model output (spec §18/§46)
    { type: "session", nativeSessionId: SESSION },
    { type: "status", status: "init" },
    // hook_started/hook_finished noise and rate_limit_event are dropped
    { type: "text", text: "CREW_PROBE_OK" },
    { type: "tool", name: "Bash", detail: { command: "ls" } },
    // the unknown "totally_new_event_kind" is dropped without error
    { type: "result", text: "CREW_PROBE_OK" },
  ]);
});

test("claude: is_error:true result maps to an error event", () => {
  const mapper = createClaudeEventMapper();
  const events = mapper({
    type: "result",
    is_error: true,
    result: "Invalid API key",
    session_id: SESSION,
  });
  assert.deepEqual(events, [
    { type: "session", nativeSessionId: SESSION },
    { type: "error", message: "Invalid API key" },
  ]);
});

test("claude: session is emitted exactly once per turn", () => {
  const mapper = createClaudeEventMapper();
  const first = mapper({ type: "system", subtype: "hook_started", session_id: SESSION });
  const second = mapper({ type: "system", subtype: "hook_started", session_id: SESSION });
  assert.deepEqual(first, [{ type: "session", nativeSessionId: SESSION }]);
  assert.deepEqual(second, []);
});
