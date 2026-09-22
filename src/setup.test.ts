import assert from "node:assert/strict";
import { test } from "node:test";
import { automationDefault, hostInvocation, nextSteps, parseDataDirectoryArg } from "./setup.js";

test("parseDataDirectoryArg: reads an explicit data directory", () => {
  assert.equal(parseDataDirectoryArg(["--data-dir", "/srv/docket"]), "/srv/docket");
});

test("parseDataDirectoryArg: returns undefined when omitted", () => {
  assert.equal(parseDataDirectoryArg([]), undefined);
});

test("automationDefault: non-interactive stdin (node:test's own, always non-TTY here) defaults to true regardless of args", () => {
  assert.equal(automationDefault([]), true);
});

test("automationDefault: --yes/-y force true even if stdin were a TTY (can't flip isTTY here, but the flag check must short-circuit before it)", () => {
  assert.equal(automationDefault(["--yes"]), true);
  assert.equal(automationDefault(["-y"]), true);
});

const invocation = hostInvocation("@pasichdev/docket@3.0.0", { DOCKET_DATA_DIR: "/home/u/.docket" });

test("nextSteps: names the hosts it configured and says what to try, instead of a start command that does not exist", () => {
  const out = nextSteps({ configured: ["Codex", "Claude Code"], invocation, dashboardPort: 8787 });
  assert.match(out, /ready in Claude Code, Codex/);
  assert.match(out, /Restart Claude Code and ask it: "add a todo/);
  assert.match(out, /http:\/\/localhost:8787/);
  assert.doesNotMatch(out, /Start the server with/);
});

test("nextSteps: the manual snippet is a whole host entry — command, args and env — not an env block with nothing to attach it to", () => {
  const out = nextSteps({ configured: [], invocation, dashboardPort: 9000 });
  assert.match(out, /No MCP host was configured automatically/);
  assert.match(out, /http:\/\/localhost:9000/);
  const json = JSON.parse(out.slice(out.indexOf("{"))) as { mcpServers: { docket: { command: string; args: string[]; env: Record<string, string> } } };
  assert.deepEqual(json.mcpServers.docket, invocation);
  // The pinned, --prefix form: bare `npx @pasichdev/docket` run inside a checkout of this repo resolves the local package and dies.
  assert.ok(json.mcpServers.docket.args.includes("--prefix"));
});
