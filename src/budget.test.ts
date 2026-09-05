import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approximateTokens,
  emptyScopeNotice,
  routingHint,
  compactTodo,
  formatResult,
  renderSessionStart,
  scopeNotice,
  SESSION_START_MAX_ITEMS,
  SESSION_START_TOKEN_BUDGET,
} from "./format.js";
import { ALWAYS_ON_SNIPPET } from "./hooks/install.js";
import type { Todo } from "./types.js";

/**
 * These are requirements, not guidelines. Every string here is paid for on every call, in
 * every terminal, all day — the cost compounds in a way a one-off prompt never does, and the
 * only way a budget survives contact with future edits is if something fails when it's blown.
 *
 * The budgets apply to the FIXED text — the wording this project chose. Variable parts (a
 * project slug, an agent name) are the caller's own identifiers and have to appear in full
 * or the line stops being actionable, so they get their own, more generous ceiling.
 */
const SCOPE_NOTICE_BUDGET = 15;
const ROUTING_HINT_BUDGET = 20;
const ALWAYS_ON_BUDGET = 40;
/** A realistically long slug, not a friendly one — budgets that only hold for `acme/backend` aren't budgets. */
const LONG_WORKSPACE = "some-organisation/some-long-repository-name";
const VARIABLE_PART_CEILING = 35;

function todo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: 1,
    uuid: "0199a000-0000-7000-8000-000000000001",
    title: "fix token refresh race",
    description: "a long description that a compact listing has no business printing, repeated to make the point clearly",
    done: false,
    list: "todo",
    category: "PROJ-834",
    priority: "high",
    dueDate: "2026-10-01",
    sourceUrl: "https://gitlab.com/acme/backend/-/issues/834",
    agent: "codex",
    session: "abc123",
    workspace: "acme/backend",
    workingAgent: null,
    workingSince: null,
    workingSession: null,
    workingLeaseExpiresAt: null,
    workingDeviceId: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    fieldTimestamps: {},
    completedAt: null,
    revision: 1,
    localSeq: 1,
    deviceId: "device-a",
    deviceName: "Laptop",
    history: [{ at: "2026-09-01T10:00:00.000Z", agent: "codex", deviceName: "Laptop", action: "created", detail: "title: \"fix token refresh race\"" }],
    ...overrides,
  };
}

function manyTodos(count: number): Todo[] {
  return Array.from({ length: count }, (_, i) =>
    todo({ id: i + 1, uuid: `0199a000-0000-7000-8000-${String(i + 1).padStart(12, "0")}`, title: `open item number ${i + 1}` }),
  );
}

test("compact listing costs a fraction of a full record, and drops nothing an agent needs to act", () => {
  const item = todo();
  const compact = compactTodo(item, "acme/backend");
  const verbose = formatResult([item], "open", "todo", undefined, true, "acme/backend");

  assert.ok(compact.includes("fix token refresh race"), "the title is the point");
  assert.ok(compact.includes("[high]"), "priority changes what you pick up next");
  assert.ok(!compact.includes("a long description"), "descriptions are the bulk, and are not read when choosing");
  assert.ok(
    approximateTokens(compact) * 3 < approximateTokens(verbose),
    `compact (${approximateTokens(compact)}t) should be far cheaper than verbose (${approximateTokens(verbose)}t)`,
  );
});

test("compact listing marks a claimed item and an item from another project, and nothing else", () => {
  const claimed = compactTodo(
    todo({ workingAgent: "codex", workingLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }),
    "acme/backend",
  );
  assert.ok(claimed.includes("← codex"));

  const foreign = compactTodo(todo({ workspace: "acme/web" }), "acme/backend");
  assert.ok(foreign.includes("@acme/web"), "an agent must not think a cross-project item landed in its own project");

  const own = compactTodo(todo(), "acme/backend");
  assert.ok(!own.includes("@"), "and must not pay a marker for the common case");
});

test(`scope notice's fixed text is under ${SCOPE_NOTICE_BUDGET} tokens, and says how to widen`, () => {
  const fixed = scopeNotice(""); // the scaffolding alone, with no project name in it
  assert.ok(approximateTokens(fixed) <= SCOPE_NOTICE_BUDGET, `scope notice scaffolding is ${approximateTokens(fixed)} tokens: ${fixed}`);

  const notice = scopeNotice("acme/backend");
  assert.equal(notice.trim().split("\n").length, 1);
  assert.ok(notice.includes('workspace:"*"'), "an agent must be able to widen the scope without reading a doc");
  assert.equal(scopeNotice("*"), "", "nothing was narrowed, so nothing is said");

  const long = scopeNotice(LONG_WORKSPACE);
  assert.ok(approximateTokens(long) <= SCOPE_NOTICE_BUDGET + VARIABLE_PART_CEILING, `with a real slug it is ${approximateTokens(long)} tokens: ${long}`);
  assert.ok(long.includes(LONG_WORKSPACE), "the project name is never abbreviated — an agent has to be able to pass it back verbatim");
});

test(`routing hint is under ${ROUTING_HINT_BUDGET} tokens, and stays bounded for a long project name`, () => {
  const lastSeenAt = new Date(Date.now() - 120_000).toISOString();
  const live = (workspace: string) => [
    { session: "mine", agent: "claude-code", workspace, cwd: "/r", pid: 1, startedAt: "", lastSeenAt },
    { session: "other", agent: "codex", workspace, cwd: "/r", pid: 2, startedAt: "", lastSeenAt },
  ];
  const hint = routingHint(live("acme/backend"), "acme/backend", "mine");
  assert.ok(approximateTokens(hint) <= ROUTING_HINT_BUDGET, `routing hint is ${approximateTokens(hint)} tokens: ${hint}`);

  const long = routingHint(live(LONG_WORKSPACE), LONG_WORKSPACE, "mine");
  assert.ok(approximateTokens(long) <= ROUTING_HINT_BUDGET + VARIABLE_PART_CEILING, `with a real slug it is ${approximateTokens(long)} tokens: ${long}`);
});

test(`SessionStart injection stays under ${SESSION_START_TOKEN_BUDGET} tokens and ${SESSION_START_MAX_ITEMS} items`, () => {
  const block = renderSessionStart(manyTodos(40), "acme/backend");
  const lines = block.split("\n");
  assert.ok(approximateTokens(block) <= SESSION_START_TOKEN_BUDGET, `injection is ${approximateTokens(block)} tokens:\n${block}`);
  const itemLines = lines.filter((l) => l.startsWith("T-"));
  assert.ok(itemLines.length <= SESSION_START_MAX_ITEMS, `injected ${itemLines.length} items`);
  assert.ok(block.includes("more"), "and says plainly that it truncated");
});

test("SessionStart injection stays inside budget with a long project name too", () => {
  const block = renderSessionStart(manyTodos(40), LONG_WORKSPACE);
  assert.ok(approximateTokens(block) <= SESSION_START_TOKEN_BUDGET, `injection is ${approximateTokens(block)} tokens:\n${block}`);
});

test("SessionStart injection stays inside budget even when every title is long", () => {
  const long = manyTodos(20).map((t) => ({ ...t, title: "a deliberately overlong title ".repeat(4).trim() }));
  const block = renderSessionStart(long, "acme/backend");
  assert.ok(approximateTokens(block) <= SESSION_START_TOKEN_BUDGET, `injection is ${approximateTokens(block)} tokens:\n${block}`);
  for (const line of block.split("\n")) assert.ok(!line.endsWith("…"), "items are dropped whole, never truncated mid-title");
});

test("SessionStart injects nothing when the project has nothing open", () => {
  assert.equal(renderSessionStart([], "acme/backend"), "");
  assert.equal(renderSessionStart(manyTodos(3).map((t) => ({ ...t, done: true })), "acme/backend"), "");
});

test(`the always-on snippet is under ${ALWAYS_ON_BUDGET} tokens`, () => {
  assert.ok(
    approximateTokens(ALWAYS_ON_SNIPPET) <= ALWAYS_ON_BUDGET,
    `always-on snippet is ${approximateTokens(ALWAYS_ON_SNIPPET)} tokens: ${ALWAYS_ON_SNIPPET}`,
  );
});

/**
 * The workspace feature's scariest failure is not a bug — it is what the feature does. A
 * host with an unexpected cwd resolves to a different project, the list comes back empty,
 * and "my data is gone" is the honest conclusion from where the user is sitting.
 */
test("an empty scoped result reports what it is not showing, and how to see it", () => {
  const all = [
    todo({ id: 1, workspace: "acme/web", title: "web work" }),
    todo({ id: 2, workspace: "acme/web", title: "more web work" }),
    todo({ id: 3, workspace: "acme/infra", title: "infra work" }),
  ];
  const notice = emptyScopeNotice("acme/backend", all);

  assert.match(notice, /0 open in acme\/backend/);
  assert.match(notice, /3 open across 2 other workspaces/);
  assert.match(notice, /workspace:"\*"/, "it must name the way out, not just the problem");
  assert.equal(notice.trim().split("\n").length, 1);
});

test("the empty-scope notice counts only OPEN items, and ignores unfiled ones", () => {
  const all = [
    todo({ id: 1, workspace: "acme/web", done: true, title: "finished" }),
    todo({ id: 2, workspace: null, title: "unfiled rides along with every scope" }),
    todo({ id: 3, workspace: "acme/web", title: "actually open" }),
  ];
  assert.match(emptyScopeNotice("acme/backend", all), /1 open across 1 other workspace\b/);
});

test("a genuinely empty store says nothing extra — an empty list is then the truth", () => {
  assert.equal(emptyScopeNotice("acme/backend", []), "");
  assert.equal(emptyScopeNotice("acme/backend", [todo({ id: 1, workspace: "acme/backend" })]), "");
  assert.equal(emptyScopeNotice("*", [todo({ id: 1, workspace: "acme/web" })]), "", "an unscoped list cannot mislead about scope");
});
