import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "../types.js";
import {
  buildOpencodeResumeArgs,
  buildOpencodeStartArgs,
  createOpencodeEventMapper,
  resolveOpencodeModel,
} from "./opencode.js";
import { readFixture, replayThroughMapper } from "./testsupport.js";

const SESSION = "ses_f8c8bd4a1af1JzTOiVVXvcAMOc";

test("opencode: start argv matches the proven invocation and never passes --auto", () => {
  const args = buildOpencodeStartArgs({
    prompt: "say hi",
    cwd: "/tmp/work",
    model: "openrouter/~google/gemini-flash-latest",
  });
  assert.deepEqual(args, [
    "run",
    "--format",
    "json",
    "--dir",
    "/tmp/work",
    "-m",
    "openrouter/~google/gemini-flash-latest",
    // PROBED against opencode 1.18.26: without `--`, a prompt starting with `-` is a usage dump.
    "--",
    "say hi",
  ]);
  assert.ok(!args.includes("--auto"));
});

test("opencode: split provider+model are combined into provider/model", () => {
  assert.equal(
    resolveOpencodeModel({ provider: "openrouter", model: "~google/gemini-flash-latest" }),
    // model already contains a slash → assumed fully qualified
    "~google/gemini-flash-latest",
  );
  assert.equal(resolveOpencodeModel({ provider: "openrouter", model: "grok-code" }), "openrouter/grok-code");
  assert.equal(resolveOpencodeModel({ model: "openrouter/x" }), "openrouter/x");
  assert.equal(resolveOpencodeModel({}), undefined);
});

test("opencode: resume argv adds -s <session>", () => {
  const args = buildOpencodeResumeArgs({
    prompt: "and again",
    cwd: "/tmp/work",
    nativeSessionId: SESSION,
  });
  assert.deepEqual(args, [
    "run",
    "--format",
    "json",
    "--dir",
    "/tmp/work",
    "-s",
    SESSION,
    "--",
    "and again",
  ]);
});

test("opencode: recorded Warp-contaminated stream normalizes cleanly", () => {
  // The fixture contains, verbatim from the observed contamination pattern:
  //  - a standalone ESC]777;...BEL OSC line,
  //  - a bare `]777;notify;warp://cli-agent;{...}` payload glued (no newline, no terminator)
  //    onto the front of a real "text" event line,
  //  - a malformed non-JSON line,
  //  - an unknown event type.
  // Replayed in 7-byte chunks so object boundaries never align with chunk boundaries.
  const events = replayThroughMapper(readFixture("opencode.jsonl"), createOpencodeEventMapper());
  assert.deepEqual(events, [
    { type: "session", nativeSessionId: SESSION },
    { type: "status", status: "step_start" },
    { type: "text", text: "CREW_OPENCODE_OK" },
    {
      type: "tool",
      name: "read",
      detail: { id: "prt_3", type: "tool", tool: "read", state: { status: "completed" } },
    },
    // the malformed line, the warp payload objects and "mystery_event" are all dropped
    { type: "result", text: "CREW_OPENCODE_OK" },
  ]);
});

test("opencode: non-final step_finish is a status, only reason:stop is the result", () => {
  const mapper = createOpencodeEventMapper();
  mapper({ type: "text", sessionID: SESSION, part: { type: "text", text: "partial" } });
  const middle = mapper({ type: "step_finish", sessionID: SESSION, part: { reason: "tool-calls" } });
  assert.deepEqual(middle, [{ type: "status", status: "step_finish:tool-calls" }]);
  const final = mapper({ type: "step_finish", sessionID: SESSION, part: { reason: "stop" } });
  assert.deepEqual(final, [{ type: "result", text: "partial" }]);
});

test("opencode: error events carry a message", () => {
  const mapper = createOpencodeEventMapper();
  const events: AgentEvent[] = mapper({ type: "error", sessionID: SESSION, message: "provider auth failed" });
  assert.deepEqual(events, [
    { type: "session", nativeSessionId: SESSION },
    { type: "error", message: "opencode error: provider auth failed" },
  ]);
});

test("opencode: a prompt that starts with `-` is a prompt, not a flag (defect 7)", () => {
  for (const args of [
    buildOpencodeStartArgs({ prompt: "---\nname: x", cwd: "/tmp/w" }),
    buildOpencodeResumeArgs({ prompt: "---\nname: x", cwd: "/tmp/w", nativeSessionId: SESSION }),
  ]) {
    const separator = args.indexOf("--");
    assert.notEqual(separator, -1, "the option/positional separator must be present");
    assert.equal(args[args.length - 1], "\n---\nname: x", "the prompt is guarded as well as separated");
    assert.ok(separator < args.length - 1, "the prompt must come after the separator");
  }
});
