#!/usr/bin/env node
/**
 * Builds the workspace the dashboard screenshots are taken of.
 *
 * It exists so the screenshots can be regenerated after any UI change without anyone
 * inventing plausible-looking content again, and so what they show is the real dashboard
 * rendering real records through the real API — not a mock. Everything lands in an isolated
 * data directory on a non-default port, so a real install is never touched.
 *
 *   node docs/assets/demo-seed.mjs            # seed, then start the dashboard and print its URL
 *   node docs/assets/demo-seed.mjs --clean    # remove the scratch directory
 *
 * The content is deliberately ordinary: a backend project mid-migration, a side project, and
 * one unfiled thought. Categories, priorities, due dates, markdown descriptions, a claimed
 * item and a couple of completed ones — because every one of those is a thing the card
 * layout has to handle, and a screenshot of six identical one-line items proves none of it.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = join(tmpdir(), "docket-demo-shots");
const PORT = 8799;
const DATA_DIR = join(ROOT, "data");

if (process.argv.includes("--clean")) {
  const running = await fetch(`http://127.0.0.1:${PORT}/api/version`, { signal: AbortSignal.timeout(500) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (running?.pid) process.kill(running.pid, "SIGTERM");
  await rm(ROOT, { recursive: true, force: true });
  console.log(`Removed ${ROOT}`);
  process.exit(0);
}

/*
 * Stop a previous run's dashboard BEFORE the directory goes.
 *
 * Skipping this is how a dashboard from the last run — still holding the old at-rest key —
 * ended up writing the store into the freshly recreated directory, beside a new key that
 * could not decrypt it. Docket now refuses that write rather than performing it (the
 * generation check in storage.ts), which turns a corrupted scratch directory into a clear
 * error; this makes the script not produce the error in the first place.
 */
const previous = await fetch(`http://127.0.0.1:${PORT}/api/version`, { signal: AbortSignal.timeout(500) })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
if (previous?.pid) {
  process.kill(previous.pid, "SIGTERM");
  const gone = Date.now() + 5_000;
  while (Date.now() < gone) {
    const up = await fetch(`http://127.0.0.1:${PORT}/api/version`, { signal: AbortSignal.timeout(300) }).then(() => true).catch(() => false);
    if (!up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}

await rm(ROOT, { recursive: true, force: true });
await mkdir(DATA_DIR, { recursive: true });

// A git remote is what the workspace resolver actually reads, so the projects below are
// real ones as far as docket is concerned — no git binary required.
async function project(dir, remote) {
  await mkdir(join(ROOT, dir, ".git"), { recursive: true });
  await writeFile(join(ROOT, dir, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remote}\n`);
}
await project("backend", "git@github.com:acme/backend.git");
await project("tracker", "https://github.com/you/tracker.git");

const web = spawn(process.execPath, [join(REPO, "dist", "web.js")], {
  env: { ...process.env, DOCKET_DATA_DIR: DATA_DIR, DOCKET_WEB_PORT: String(PORT) },
  // Fully detached with no inherited pipes: this script has to EXIT once the dashboard is
  // up, and an open stdio pipe to a child keeps the parent's event loop alive regardless of
  // unref(). The child's own log goes to <data dir>/server.log.
  stdio: "ignore",
  detached: true,
});
web.unref();

const base = `http://127.0.0.1:${PORT}`;
const until = Date.now() + 15_000;
for (;;) {
  const up = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(500) }).then((r) => r.ok).catch(() => false);
  if (up) break;
  if (Date.now() > until) throw new Error("the dashboard did not start");
  await new Promise((r) => setTimeout(r, 200));
}

const api = async (path, method, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
};

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const items = [
  {
    title: "Token refresh races on the first request after a cold start",
    workspace: "acme/backend",
    category: "auth",
    priority: "high",
    dueDate: day(1),
    list: "todo",
    description:
      "Two requests arriving together both see an expired token and both refresh, and the second one **invalidates the first's**.\n\n" +
      "- Reproduces reliably with `--concurrency 2` against a cold pod\n" +
      "- Only on the first request after a restart, which is why staging never caught it\n" +
      "- Single-flight around `refresh()` in `src/auth/session.ts` is probably the fix\n" +
      "- Needs a regression test that starts cold and fires two requests at once",
    claim: true,
  },
  {
    title: "Drop the legacy /v1/login path",
    workspace: "acme/backend",
    category: "auth",
    priority: "medium",
    list: "todo",
    description: "Nothing has called it in six weeks. Check the access logs once more, then remove the route and its tests.",
  },
  {
    title: "Migration notes for the 3.0 store format",
    workspace: "acme/backend",
    category: "docs",
    priority: "low",
    dueDate: day(5),
    list: "backlog",
    description: "Cover what changes on disk, what a downgrade does, and the one command that undoes it.",
  },
  {
    title: "Ship the new navigation",
    workspace: "you/tracker",
    category: "ui",
    priority: "medium",
    dueDate: day(3),
    list: "todo",
    description: "Keyboard focus order is still wrong on the collapsed sidebar.",
  },
  {
    title: "Rate-limit the public search endpoint",
    workspace: "you/tracker",
    category: "backend",
    priority: "high",
    list: "backlog",
  },
  {
    title: "Try the new profiler on the slow import path",
    category: "ideas",
    priority: "low",
    list: "backlog",
    description: "No project yet — just something worth an hour.",
  },
  {
    title: "Rotate the staging database credentials",
    workspace: "acme/backend",
    category: "ops",
    priority: "medium",
    list: "todo",
    done: true,
  },
  {
    title: "Pin the CI Node version matrix",
    workspace: "acme/backend",
    category: "ci",
    priority: "low",
    list: "todo",
    done: true,
  },
];

const claimed = [];
for (const { claim, done, ...input } of items) {
  const created = await api("/api/todos", "POST", input);
  const id = created.todo?.id ?? created.id;
  if (done) await api(`/api/todos/${id}/complete`, "POST", {});
  if (claim) claimed.push(id);
}

// Claiming is an MCP operation — there is no web route for it, because "an agent is working
// on this" is a statement only an agent gets to make. Done here the same way a tool call
// does it, against the same on-disk store the dashboard is reading.
if (claimed.length > 0) {
  process.env.DOCKET_DATA_DIR = DATA_DIR;
  const { LocalTodoRepository } = await import(join(REPO, "dist", "repository.js"));
  const repository = new LocalTodoRepository();
  for (const id of claimed) {
    await repository.claim(id, { agent: "claude-code", session: "demo", deviceId: "demo-device", deviceName: "MacBook" });
  }
}

console.log(`Dashboard: ${base}`);
console.log(`Data dir:  ${DATA_DIR}`);
console.log(`Projects:  ${join(ROOT, "backend")}, ${join(ROOT, "tracker")}`);
console.log(`Tear down: node docs/assets/demo-seed.mjs --clean`);
