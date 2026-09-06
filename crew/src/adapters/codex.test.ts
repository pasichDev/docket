import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCodexResumeArgs, buildCodexStartArgs, createCodexEventMapper } from "./codex.js";
import { readFixture, replayThroughMapper } from "./testsupport.js";

const THREAD = "01a07370-b986-76c0-9ecc-bc4137ffb06e";

test("codex: start argv matches the proven invocation and stays sandboxed", () => {
  const args = buildCodexStartArgs({ prompt: "do it", cwd: "/tmp/work" });
  assert.deepEqual(args, [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "-C",
    "/tmp/work",
    // `--` ends option parsing: PROBED against codex 0.151.0 — without it a prompt starting
    // with `-` is a usage dump, with it the prompt is taken as the positional it is.
    "--",
    "do it",
  ]);
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!args.includes("danger-full-access"));
});

test("codex: start argv adds -m when a model is set", () => {
  const args = buildCodexStartArgs({ prompt: "p", cwd: "/tmp/w", model: "gpt-5-codex" });
  assert.deepEqual(args.slice(-4), ["-m", "gpt-5-codex", "--", "p"]);
});

test("codex: resume argv uses the resume subcommand (no --sandbox/-C there; config override instead)", () => {
  const args = buildCodexResumeArgs({ prompt: "continue", nativeSessionId: THREAD });
  assert.deepEqual(args, [
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "-c",
    'sandbox_mode="workspace-write"',
    "--",
    THREAD,
    "continue",
  ]);
});

test("codex: recorded stream normalizes to the expected AgentEvent sequence", () => {
  const events = replayThroughMapper(readFixture("codex.jsonl"), createCodexEventMapper());
  assert.deepEqual(events, [
    { type: "session", nativeSessionId: THREAD },
    { type: "status", status: "turn.started" },
    { type: "text", text: "Creating the file now." },
    {
      type: "tool",
      name: "file_change",
      detail: {
        id: "item_1",
        type: "file_change",
        changes: [{ path: "/tmp/crew-probe-codex/crew-codex.txt", kind: "add" }],
        status: "in_progress",
      },
    },
    {
      type: "tool",
      name: "file_change",
      detail: {
        id: "item_1",
        type: "file_change",
        changes: [{ path: "/tmp/crew-probe-codex/crew-codex.txt", kind: "add" }],
        status: "completed",
      },
    },
    // reasoning items and the unknown "some.future.event" are dropped
    { type: "text", text: "Done: created crew-codex.txt containing CREW_CODEX_OK" },
    // turn.completed carries no text; the result is the last agent_message
    { type: "result", text: "Done: created crew-codex.txt containing CREW_CODEX_OK" },
  ]);
});

test("codex: turn.failed maps to an error event", () => {
  const mapper = createCodexEventMapper();
  const events = mapper({ type: "turn.failed", error: { message: "model overloaded" } });
  assert.deepEqual(events, [{ type: "error", message: "codex turn failed: model overloaded" }]);
});

test("codex: a prompt that starts with `-` is a prompt, not a flag (defect 7)", () => {
  /**
   * `argvSafePrompt` guarded the claude adapter only; codex pushed `input.prompt` as a bare
   * trailing positional. It happened to be unreachable because the prompt layout starts with a
   * `#` heading — i.e. closed by accident, and reopened by any reordering of the sections.
   * Two independent defences now, both PROBED against codex 0.151.0:
   *   `--` before the positionals, and the leading-newline guard on the prompt itself.
   */
  for (const args of [
    buildCodexStartArgs({ prompt: "---\nname: x", cwd: "/tmp/w" }),
    buildCodexResumeArgs({ prompt: "---\nname: x", nativeSessionId: THREAD }),
  ]) {
    const separator = args.indexOf("--");
    assert.notEqual(separator, -1, "the option/positional separator must be present");
    assert.equal(args[args.length - 1], "\n---\nname: x", "the prompt is guarded as well as separated");
    assert.ok(separator < args.length - 1, "the prompt must come after the separator");
  }
});

test("codex: extra MCP `-c` overrides stay on the option side of `--`", () => {
  const args = buildCodexStartArgs({ prompt: "p", cwd: "/tmp/w" }, ["-c", 'mcp_servers.crew.command="node"']);
  const separator = args.indexOf("--");
  assert.ok(args.indexOf('mcp_servers.crew.command="node"') < separator, "overrides are options, not positionals");
});
