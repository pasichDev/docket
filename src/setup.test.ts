import assert from "node:assert/strict";
import { test } from "node:test";
import { automationDefault, parseDataDirectoryArg } from "./setup.js";

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
