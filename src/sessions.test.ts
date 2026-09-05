import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-sessions-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { clearSessions, endSession, listSessions, registerSession, SESSION_TTL_MS } = await import("./sessions.js");
const { formatIdle, routingHint } = await import("./format.js");
type LiveSession = import("./sessions.js").LiveSession;

const SESSIONS_PATH = join(dataDirectory, "sessions.json");

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

/** Writes the file directly so a test can plant a session that is stale, or owned by a pid that never existed. */
async function plant(sessions: Partial<LiveSession>[]): Promise<void> {
  const now = new Date().toISOString();
  const full = sessions.map((s) => ({
    session: "s",
    agent: "codex",
    workspace: "acme/backend",
    cwd: "/tmp",
    pid: process.pid,
    startedAt: now,
    lastSeenAt: now,
    ...s,
  }));
  await writeFile(SESSIONS_PATH, JSON.stringify(full, null, 2));
}

test("a registered session shows up as live", async () => {
  await clearSessions();
  await registerSession({ session: "abc", agent: "claude-code", workspace: "acme/backend", cwd: "/repo", pid: process.pid });
  const live = await listSessions();
  assert.equal(live.length, 1);
  assert.equal(live[0].agent, "claude-code");
  assert.equal(live[0].workspace, "acme/backend");
});

test("registering the same session twice replaces it rather than duplicating it", async () => {
  await clearSessions();
  await registerSession({ session: "abc", agent: null, workspace: null, cwd: "/repo", pid: process.pid });
  await registerSession({ session: "abc", agent: "codex", workspace: "acme/web", cwd: "/repo", pid: process.pid });
  const live = await listSessions();
  assert.equal(live.length, 1, "the agent name and workspace are only known after the client introduces itself");
  assert.equal(live[0].agent, "codex");
});

test("a session past its TTL is reaped", async () => {
  await clearSessions();
  await plant([{ session: "stale", lastSeenAt: new Date(Date.now() - SESSION_TTL_MS - 1000).toISOString() }]);
  assert.deepEqual(await listSessions(), []);
});

test("a session whose process is gone is reaped immediately, not after the TTL", async () => {
  await clearSessions();
  // A pid that cannot exist: killed terminals are the common case, and waiting ten minutes
  // to notice is exactly the window where someone tries to return to a session that closed.
  await plant([{ session: "dead", pid: 2 ** 22, lastSeenAt: new Date().toISOString() }]);
  assert.deepEqual(await listSessions(), []);
});

test("endSession removes the session, and reading rewrites the file with the reaped set", async () => {
  await clearSessions();
  await registerSession({ session: "abc", agent: "codex", workspace: "w", cwd: "/repo", pid: process.pid });
  await endSession("abc");
  assert.deepEqual(await listSessions(), []);
  assert.deepEqual(JSON.parse(await readFile(SESSIONS_PATH, "utf8")), []);
});

test("routingHint: silent when the only live session in this workspace is the caller's own", () => {
  const sessions = [{ session: "mine", agent: "codex", workspace: "acme/backend", cwd: "/r", pid: 1, startedAt: "", lastSeenAt: new Date().toISOString() }];
  assert.equal(routingHint(sessions, "acme/backend", "mine"), "", "a hint about yourself is pure noise, paid for on every capture");
});

test("routingHint: names another agent live in the same workspace, in one short line", () => {
  const lastSeenAt = new Date(Date.now() - 2 * 60_000).toISOString();
  const sessions = [
    { session: "mine", agent: "claude-code", workspace: "acme/backend", cwd: "/r", pid: 1, startedAt: "", lastSeenAt },
    { session: "other", agent: "codex", workspace: "acme/backend", cwd: "/r", pid: 2, startedAt: "", lastSeenAt },
  ];
  const hint = routingHint(sessions, "acme/backend", "mine");
  assert.equal(hint, "\n→ codex is live in acme/backend (idle 2m)");
  assert.ok(hint.length < 80, "one line, not a paragraph — see the Stage 7 budget");
});

test("routingHint: sessions in OTHER workspaces are not mentioned", () => {
  const sessions = [{ session: "other", agent: "codex", workspace: "acme/web", cwd: "/r", pid: 2, startedAt: "", lastSeenAt: new Date().toISOString() }];
  assert.equal(routingHint(sessions, "acme/backend", "mine"), "");
});

test("routingHint: an unfiled item has no project to point at", () => {
  const sessions = [{ session: "other", agent: "codex", workspace: null, cwd: "/r", pid: 2, startedAt: "", lastSeenAt: new Date().toISOString() }];
  assert.equal(routingHint(sessions, null, "mine"), "");
});

test("formatIdle: reads as a duration a human can act on", () => {
  const now = Date.now();
  assert.equal(formatIdle(new Date(now - 5_000).toISOString(), now), "active");
  assert.equal(formatIdle(new Date(now - 4 * 60_000).toISOString(), now), "idle 4m");
  assert.equal(formatIdle(new Date(now - 3 * 3600_000).toISOString(), now), "idle 3h");
});
