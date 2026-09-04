import assert from "node:assert/strict";
import { test } from "node:test";
import { addSessionStartHook, diffLines, removeDocketHooks, sessionStartCommand } from "./install.js";

const COMMAND = "docket hook claude session-start";

/** A settings.json that already has the user's own hooks in it — the only case that really matters. */
function userSettings() {
  return {
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "my-own-setup.sh" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit-bash.sh" }] }],
    },
  };
}

test("install merges into existing hooks instead of replacing them", () => {
  const next = addSessionStartHook(userSettings(), COMMAND);
  const commands = next.hooks!.SessionStart.flatMap((m) => (m.hooks ?? []).map((h) => h.command));
  assert.deepEqual(commands, ["my-own-setup.sh", "docket hook claude session-start"]);
  assert.deepEqual(next.hooks!.PreToolUse, userSettings().hooks.PreToolUse, "unrelated events are untouched");
  assert.deepEqual(next.permissions, userSettings().permissions, "and so is everything outside `hooks`");
});

test("install into an empty settings file creates just the one entry", () => {
  const next = addSessionStartHook({}, COMMAND);
  assert.deepEqual(next.hooks, { SessionStart: [{ hooks: [{ type: "command", command: "docket hook claude session-start" }] }] });
});

test("install is idempotent — running it twice does not stack duplicates", () => {
  const once = addSessionStartHook(userSettings(), COMMAND);
  const twice = addSessionStartHook(once, COMMAND);
  assert.deepEqual(twice, once, "an upgrade path that duplicates entries silently doubles the hook's cost");
});

test("uninstall removes only entries docket owns", () => {
  const installed = addSessionStartHook(userSettings(), COMMAND);
  const cleaned = removeDocketHooks(installed);
  assert.deepEqual(cleaned.hooks, userSettings().hooks, "the file is left exactly as the user had it");
});

test("uninstall drops the hooks key entirely when docket's entry was the only one", () => {
  const cleaned = removeDocketHooks(addSessionStartHook({}, COMMAND));
  assert.equal(cleaned.hooks, undefined, "no empty scaffolding left behind");
});

test("uninstall on a file with no docket hooks changes nothing", () => {
  assert.deepEqual(removeDocketHooks(userSettings()), userSettings());
});

test("the diff shown before writing names the command, and nothing structural", () => {
  const before = JSON.stringify(userSettings(), null, 2);
  const after = JSON.stringify(addSessionStartHook(userSettings(), COMMAND), null, 2);
  const diff = diffLines(before, after);
  assert.deepEqual(diff.split("\n"), ['+ "command": "docket hook claude session-start"']);
});

test("the installed command is one a shell can actually run, or is refused outright", async () => {
  const { command, onPath, reason } = await sessionStartCommand();
  if (onPath) {
    assert.equal(command, COMMAND);
    return;
  }
  if (command === null) {
    // Running from npm's npx cache: pinning that path would write a command into long-lived
    // config that npm may delete, so installing is refused with an actionable reason rather
    // than producing a hook that works today and rots.
    assert.match(reason ?? "", /npm install -g/);
    return;
  }
  // A stable local install (a clone, or a non-global prefix): pin the interpreter and
  // launcher absolutely, or the hook silently never runs.
  assert.ok(command.startsWith(`"${process.execPath}"`), `expected an absolute command, got: ${command}`);
  assert.match(command, /launcher\.js/);
});
