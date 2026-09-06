/**
 * Live smoke suite against the REAL claude/codex/opencode binaries (spec §48).
 *
 * Gated: runs only with DOCKET_CREW_LIVE=1, so a normal `npm test` never spawns paid model
 * calls. Each test uses a tiny prompt, a cheap model where selectable, and a throwaway temp
 * directory under the OS tmpdir — never the user's repos.
 *
 *   DOCKET_CREW_LIVE=1 node --test dist/adapters/live.test.js
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import type { AgentEvent } from "../types.js";
import { adapters } from "./index.js";

const LIVE = process.env.DOCKET_CREW_LIVE === "1";
const execFileAsync = promisify(execFile);
const LIVE_TIMEOUT_MS = 420_000;

interface CollectedTurn {
  events: AgentEvent[];
  sessionId?: string;
  resultText?: string;
  errors: string[];
}

async function collectTurn(iterable: AsyncIterable<AgentEvent>): Promise<CollectedTurn> {
  const collected: CollectedTurn = { events: [], errors: [] };
  for await (const event of iterable) {
    collected.events.push(event);
    if (event.type === "session") collected.sessionId ??= event.nativeSessionId;
    if (event.type === "result") collected.resultText = event.text;
    if (event.type === "error") collected.errors.push(event.message);
  }
  return collected;
}

function transcript(turn: CollectedTurn): string {
  return turn.events
    .map((e) => JSON.stringify(e).slice(0, 300))
    .join("\n");
}

test("live claude: marker round-trip and native resume", { skip: !LIVE, timeout: LIVE_TIMEOUT_MS }, async () => {
  const dir = await mkdtemp("/tmp/crew-live-claude-");
  try {
    const first = await collectTurn(
      adapters.claude.startTurn({
        runId: "live-claude-1",
        prompt: "Reply with exactly CREW_LIVE_CLAUDE_OK and nothing else.",
        cwd: dir,
        model: "haiku",
      }),
    );
    assert.deepEqual(first.errors, [], `claude errors:\n${transcript(first)}`);
    assert.ok(first.sessionId, `no session event:\n${transcript(first)}`);
    assert.match(first.resultText ?? "", /CREW_LIVE_CLAUDE_OK/, transcript(first));

    const second = await collectTurn(
      adapters.claude.resumeTurn({
        runId: "live-claude-2",
        prompt: "Repeat the exact marker from my previous message, nothing else.",
        cwd: dir,
        model: "haiku",
        nativeSessionId: first.sessionId as string,
      }),
    );
    assert.deepEqual(second.errors, [], `claude resume errors:\n${transcript(second)}`);
    assert.match(second.resultText ?? "", /CREW_LIVE_CLAUDE_OK/, transcript(second));
    console.log("claude transcript (turn 1):\n" + transcript(first));
    console.log("claude transcript (turn 2, resumed):\n" + transcript(second));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live codex: really creates a marker file in a temp git repo, then resumes", { skip: !LIVE, timeout: LIVE_TIMEOUT_MS }, async () => {
  const dir = await mkdtemp("/tmp/crew-live-codex-");
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    const first = await collectTurn(
      adapters.codex.startTurn({
        runId: "live-codex-1",
        prompt:
          "Create a file named marker.txt in the current directory containing exactly CREW_LIVE_CODEX_OK (one line). Do nothing else.",
        cwd: dir,
      }),
    );
    assert.deepEqual(first.errors, [], `codex errors:\n${transcript(first)}`);
    assert.ok(first.sessionId, `no session event:\n${transcript(first)}`);
    const marker = (await readFile(`${dir}/marker.txt`, "utf8")).trim();
    assert.equal(marker, "CREW_LIVE_CODEX_OK", `marker file content mismatch:\n${transcript(first)}`);

    const second = await collectTurn(
      adapters.codex.resumeTurn({
        runId: "live-codex-2",
        prompt: "Append a second line containing exactly CREW_LIVE_CODEX_OK2 to marker.txt. Do nothing else.",
        cwd: dir,
        nativeSessionId: first.sessionId as string,
      }),
    );
    assert.deepEqual(second.errors, [], `codex resume errors:\n${transcript(second)}`);
    const appended = await readFile(`${dir}/marker.txt`, "utf8");
    assert.match(appended, /CREW_LIVE_CODEX_OK2/, `resume did not modify the file:\n${transcript(second)}`);
    console.log("codex transcript (turn 1):\n" + transcript(first));
    console.log("codex transcript (turn 2, resumed):\n" + transcript(second));
    console.log("codex marker.txt after both turns:\n" + appended);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live opencode: marker via OpenRouter, then resumes with -s", { skip: !LIVE, timeout: LIVE_TIMEOUT_MS }, async () => {
  const dir = await mkdtemp("/tmp/crew-live-opencode-");
  const model = process.env.DOCKET_CREW_LIVE_OPENCODE_MODEL ?? "openrouter/~google/gemini-flash-latest";
  try {
    const first = await collectTurn(
      adapters.opencode.startTurn({
        runId: "live-opencode-1",
        prompt: "Reply with exactly CREW_LIVE_OPENCODE_OK and nothing else.",
        cwd: dir,
        model,
      }),
    );
    assert.deepEqual(first.errors, [], `opencode errors:\n${transcript(first)}`);
    assert.ok(first.sessionId, `no session event:\n${transcript(first)}`);
    assert.match(first.resultText ?? "", /CREW_LIVE_OPENCODE_OK/, transcript(first));

    const second = await collectTurn(
      adapters.opencode.resumeTurn({
        runId: "live-opencode-2",
        prompt: "Repeat the exact marker from my previous message, nothing else.",
        cwd: dir,
        model,
        nativeSessionId: first.sessionId as string,
      }),
    );
    assert.deepEqual(second.errors, [], `opencode resume errors:\n${transcript(second)}`);
    assert.match(second.resultText ?? "", /CREW_LIVE_OPENCODE_OK/, transcript(second));
    console.log("opencode transcript (turn 1):\n" + transcript(first));
    console.log("opencode transcript (turn 2, resumed):\n" + transcript(second));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live: detect() and capabilities() reflect the real binaries", { skip: !LIVE, timeout: 60_000 }, async () => {
  for (const adapter of Object.values(adapters)) {
    const detection = await adapter.detect();
    assert.equal(detection.installed, true, `${adapter.id} should be installed on this machine`);
    assert.ok(detection.executable, `${adapter.id} executable`);
    assert.ok(detection.version, `${adapter.id} version`);
    const caps = await adapter.capabilities();
    assert.equal(caps.nonInteractive, true, `${adapter.id} nonInteractive`);
    assert.equal(caps.structuredOutput, true, `${adapter.id} structuredOutput`);
    assert.equal(caps.resume, true, `${adapter.id} resume`);
    assert.equal(caps.modelSelection, true, `${adapter.id} modelSelection`);
    console.log(`${adapter.id}: ${detection.executable} (${detection.version})`, caps);
  }
});
