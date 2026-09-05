#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createBackup, finishAnyInterruptedRestore, isBackupFile, liveHoldersOfDataDirectory, restoreBackup } from "./backup.js";
import { askQuestions as cliAskQuestions } from "./cli-prompt.js";
import { DeploymentConfigError, resolveDeploymentConfig } from "./config.js";
import { getDeviceId, getDeviceName } from "./device.js";
import { exportToJson, exportToMarkdown, importFromJson, importFromMarkdown } from "./export.js";
import { formatHistoryEntries } from "./history.js";
import { installProcessLogging, log } from "./log.js";
import { duplicationWarning, emptyScopeNotice, formatIdle, formatResult, formatTodo, renderStatsWidget, routingHint, scopeNotice, sortTodos } from "./format.js";
import { RemoteProtocolError, RemoteTodoRepository, RemoteUnavailableError } from "./remote/client.js";
import { loadRemoteCredentials } from "./remote/credentials.js";
import { filterTodos, type MutationContext } from "./repository.js";
import { CURRENT_FORMAT_VERSION, LAST_V7_RELEASE, migrateLegacyFields, readStore, restorePreUpgradeStore, withStore } from "./storage.js";
import { buildSnapshot } from "./snapshot.js";
import { TodoService, todoService as localTodoService } from "./todo-service.js";
import type { Todo, TodoList, TodoStore } from "./types.js";
import { checkForUpdate, getCurrentVersion, runUpdate } from "./update.js";
import { endSession, listSessions, registerSession, touchSession } from "./sessions.js";
import { currentWorkspace, setWorkspaceRoot, slugifyWorkspace, summarizeWorkspaces } from "./workspace.js";
import { atomicWriteFile } from "./fs-atomic.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

installProcessLogging("mcp");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = z.string().regex(DATE_RE, "Use YYYY-MM-DD");
// http(s) only — a javascript:/data: URL here would be a stored-XSS click target in the web UI.
// mutations.ts enforces this too (the real boundary, since it's shared by every caller); this
// is just a clearer error at the MCP layer instead of a silent drop-to-null.
const httpUrlSchema = z.string().url().refine((u) => ["http:", "https:"].includes(new URL(u).protocol), {
  message: "must be an http:// or https:// URL",
});
// The local numeric id (only meaningful on THIS device) or the short id shown on every
// device for the same item, e.g. "T-7K2F9A" — see shortId() in mutations.ts.
const idSchema = z.union([z.number().int(), z.string()]).describe("The todo id, e.g. 3, or the cross-device short id, e.g. T-7K2F9A");

const WEB_PORT = Number(process.env.DOCKET_WEB_PORT ?? 8787);
const deviceId = await getDeviceId();
const deviceName = await getDeviceName();

/**
 * DeploymentMode selection (RFC "Local and Self-Hosted Backend Modes" §7/§10, Implementation
 * Phase 2) — resolved lazily and memoized, on first actual need, NOT unconditionally at
 * module load: local-only CLI utilities below (`docket stats`, `list`, `export`, `import`,
 * `backup`, `restore` — all pre-existing, all deliberately still reading local storage
 * directly, see the "known gaps" note near handleCli) must keep working exactly as before
 * even on a machine with a misconfigured or unreachable remote mode, since they never
 * touch mcpTodoService at all. Only the MCP tool handlers and the `serve`-adjacent startup
 * path in main() below ever call getDeployment()/getMcpTodoService().
 *
 * Every existing install has no config file and no DOCKET_MODE, so `deployment.mode`
 * resolves to "local" and getMcpTodoService() returns the SAME shared singleton
 * (`localTodoService`) every MCP tool already called before this existed — zero
 * behavioural change for them.
 *
 * A misconfigured remote mode (unpaired device, insecure URL, bad config) fails the first
 * time it's actually needed — loud and immediate (surfaced through main()'s existing
 * top-level `.catch` when starting the MCP server, or via withRemoteErrorHandling from a
 * tool call), never a half-started MCP server whose every tool call mysteriously errors
 * with no explanation.
 */
let deploymentPromise: ReturnType<typeof resolveDeploymentConfig> | null = null;
function getDeployment(): ReturnType<typeof resolveDeploymentConfig> {
  deploymentPromise ??= resolveDeploymentConfig();
  return deploymentPromise;
}

let mcpTodoServicePromise: Promise<TodoService> | null = null;
function getMcpTodoService(): Promise<TodoService> {
  mcpTodoServicePromise ??= (async () => {
    const deployment = await getDeployment();
    if (deployment.mode !== "remote") return localTodoService;
    const creds = await loadRemoteCredentials();
    if (!creds) {
      throw new DeploymentConfigError(
        `docket: deployment mode is "remote" (server ${deployment.serverUrl}) but this device isn't paired yet.\n` +
          `Run: docket pair ${deployment.serverUrl}`,
      );
    }
    if (creds.serverUrl !== deployment.serverUrl) {
      throw new DeploymentConfigError(
        `docket: this device is paired with ${creds.serverUrl}, but the configured server is ${deployment.serverUrl}.\n` +
          `Re-pair with \`docket pair ${deployment.serverUrl}\` if this is intentional.`,
      );
    }
    return new TodoService(new RemoteTodoRepository({ serverUrl: deployment.serverUrl!, deviceId, deviceName, secret: creds.secret }));
  })();
  return mcpTodoServicePromise;
}

interface RunningWebUi {
  product?: string;
  packageVersion?: string;
  pid?: number;
}

/** Null when nothing docket-shaped answered — a closed port, a timeout, or a body that is not JSON. */
async function probeWebUi(port: number): Promise<RunningWebUi | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    return (await res.json()) as RunningWebUi;
  } catch {
    return null; // ECONNREFUSED / timeout — nothing listening
  }
}

/** SIGTERM, then wait for the port to actually go quiet. Returns false if it did not. */
async function stopWebUi(pid: number | undefined): Promise<boolean> {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if ((await probeWebUi(WEB_PORT)) === null) return true;
  }
  return false;
}

/**
 * Every MCP host spawns its own `node dist/index.js` per session, so this
 * runs on every connection — but the web UI is a single shared HTTP server,
 * not per-session. Probe the port first and only spawn one if nothing is
 * listening yet; the child is detached + unref'd so it outlives this
 * (short-lived) MCP process and the next session's probe finds it already
 * running instead of double-spawning.
 */
async function ensureWebUiRunning(): Promise<void> {
  // Port 0 means "any free port", which the probe below can never find again: every MCP
  // session would fail to detect the dashboard it started last time and spawn another
  // detached one, forever. Nineteen orphans accumulated on one machine before this was
  // noticed, because each is silent and unref'd. Any value that is not a real port has the
  // same problem, so auto-start requires a fixed, knowable one.
  if (!Number.isInteger(WEB_PORT) || WEB_PORT < 1 || WEB_PORT > 65535) {
    log(`skipping web UI auto-start: DOCKET_WEB_PORT=${process.env.DOCKET_WEB_PORT} is not a fixed port to find it on again`);
    return;
  }
  const running = await probeWebUi(WEB_PORT);
  if (running) {
    const mine = await getCurrentVersion(SCRIPT_PATH).catch(() => null);
    if (running.product !== "docket-web") {
      // Something else owns this port. Spawning a second dashboard on it would fail anyway,
      // and killing whatever it is would be indefensible.
      log(`web UI auto-start: port ${WEB_PORT} is held by something that is not docket (${running.product ?? "no product field"}) — leaving it alone`);
      return;
    }
    if (mine === null || running.packageVersion === mine) return; // the right dashboard is already up

    /*
     * A dashboard from a different build is still serving this data directory. Accepting it
     * — which is what "the port answered 200" used to mean — leaves an old process reading
     * and writing a store whose format the new build has since migrated, and running route
     * and merge behaviour this version no longer has.
     *
     * SIGTERM and replace, rather than fail: the detached dashboard has no supervisor, so
     * refusing would leave the stale one running for ever with only a log line about it.
     */
    log(`web UI auto-start: replacing the dashboard on port ${WEB_PORT} (running ${running.packageVersion ?? "unknown"}, this build is ${mine})`);
    if (!(await stopWebUi(running.pid))) {
      console.error(
        `docket: a docket dashboard from a different version (${running.packageVersion ?? "unknown"}) is running on port ${WEB_PORT} and did not stop. ` +
          `Stop it manually — it is reading the same data directory as this build.`,
      );
      return;
    }
  }
  try {
    const webEntry = fileURLToPath(new URL("./web.js", import.meta.url));
    const child = spawn(process.execPath, [webEntry], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    log(`auto-started web UI (pid ${child.pid}) on port ${WEB_PORT}`);
  } catch (err) {
    log(`failed to auto-start web UI: ${(err as Error).message}`);
  }
}

// Read from package.json rather than a hardcoded literal, so this can't drift out of
// sync with the actual published version the way it silently did before.
const serverVersion = await getCurrentVersion(SCRIPT_PATH).catch(() => "0.0.0-unknown");
const server = new McpServer({ name: "docket", version: serverVersion });
const startedAt = new Date().toISOString();

// One token per process run — each MCP host (Claude Code, Warp, Codex...)
// spawns its own `node dist/index.js`, so this groups everything created
// during one continuous connection. Not the host's own session id/URL —
// MCP over stdio doesn't expose that to the server.
const sessionToken = randomUUID().slice(0, 8);

function currentAgent(): string | null {
  return server.server.getClientVersion()?.name ?? null;
}

/**
 * The project this session is working in. Resolved once (see workspace.ts) and logged at
 * startup: a mis-resolution has to be VISIBLE, because the symptom otherwise is "my items
 * aren't showing up" with nothing to point at.
 */
let workspace: string | null = null;

async function refreshWorkspace(reason: string): Promise<void> {
  const resolved = await currentWorkspace();
  workspace = resolved.workspace;
  log(`workspace: ${resolved.workspace ?? "(unfiled)"} via ${resolved.source}${resolved.root ? ` at ${resolved.root}` : ""} — ${reason}`);
}

/** Every field is a module-level value, so the call takes no arguments — and adding a field to LiveSession stays a one-line change instead of a three-call-site hunt. */
function registerThisSession(): Promise<void> {
  return registerSession({ session: sessionToken, agent: currentAgent(), workspace, cwd: process.cwd(), pid: process.pid });
}

function currentContext(): MutationContext {
  return { agent: currentAgent(), session: sessionToken, deviceId, deviceName, workspace };
}

/**
 * Runs once the client has introduced itself.
 *
 * Two things are only knowable at this point, and both are recorded at startup with
 * placeholder values so a session that never finishes initialising is still visible:
 *
 *  - The agent's NAME. `clientInfo` arrives with the initialize request, so registering
 *    before it lands means every session shows up as "unknown" — which makes the whole
 *    presence panel useless for the one question it exists to answer.
 *  - The host's ROOTS, when it offers that capability. process.cwd() is usually the project
 *    directory, but nothing guarantees it; the host's own idea wins where there is one.
 *    A host that offers no roots capability simply keeps the cwd answer.
 */
/** Re-reads the host's roots and re-files this session under whatever project it is now in. */
async function adoptHostRoots(): Promise<boolean> {
  try {
    const { roots } = await server.server.listRoots();
    const first = roots.find((r) => r.uri.startsWith("file://"));
    if (!first) return false;
    setWorkspaceRoot(fileURLToPath(first.uri));
    return true;
  } catch (err) {
    // A host that advertises roots but fails the call is not a reason to fail the session.
    log(`workspace: host advertised roots but listRoots failed (${(err as Error).message}) — keeping the cwd-derived workspace`);
    return false;
  }
}

async function onClientReady(): Promise<void> {
  // The `initialized` notification can be DISPATCHED before the `initialize` request's
  // handler has run: the SDK schedules request handlers on a microtask, and a host that
  // writes both messages before this process finished starting has them arrive in one
  // stdin chunk. Reading clientInfo synchronously here therefore sees null, and every
  // session shows up as "unknown". Yielding once lets that microtask settle first.
  //
  // This is an optimisation, not the guarantee — it assumes one macrotask is enough, which
  // is true of today's SDK and might not be of tomorrow's. What actually guarantees the
  // record is right is causal rather than temporal: touchSession() re-stamps the agent and
  // workspace on the first tool call (see withRemoteErrorHandling), which is by definition
  // after initialize. Losing this yield would cost a session that never calls a tool
  // showing as "unknown" in the presence panel, not a wrong record.
  await new Promise((resolve) => setImmediate(resolve));

  if (server.server.getClientCapabilities()?.roots) {
    if (await adoptHostRoots()) await refreshWorkspace("from MCP roots");
    // A host whose roots change mid-session has moved the user to another project. Without
    // re-resolving, every item captured for the rest of that session is filed under the
    // project the session happened to start in — silently, which is the worst kind.
    server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
      void (async () => {
        if (!(await adoptHostRoots())) return;
        await refreshWorkspace("host reported its roots changed");
        await registerThisSession();
      })();
    });
  }
  await registerThisSession();
  log(`session: client ready — agent=${currentAgent() ?? "unknown"} workspace=${workspace ?? "(unfiled)"}`);
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function errorText(value: string) {
  return { content: [{ type: "text" as const, text: value }], isError: true };
}

/**
 * RFC §22's hard invariant, enforced at the one seam every mutating (and reading) tool
 * handler shares: a remote connectivity/protocol failure must surface as a clear,
 * actionable MCP tool error — never an unhandled crash of the whole stdio connection, and
 * never silently treated as "no such item" (TodoService.notFoundToNull — see
 * todo-service.ts — only ever catches TodoNotFoundError, so these two error types always
 * reach here). In local mode neither error type can ever be thrown (LocalTodoRepository
 * has no network calls), so this wrapper is a no-op there.
 */
function withRemoteErrorHandling<Args extends unknown[], R>(
  handler: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R | ReturnType<typeof errorText>> {
  return async (...args: Args) => {
    // Every tool call is also this session's heartbeat. Hanging it off the wrapper every
    // handler already shares means no individual tool can forget it — and the write itself
    // is debounced, so the common case costs nothing (see touchSession).
    void touchSession(sessionToken, { agent: currentAgent(), workspace });
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof RemoteUnavailableError || err instanceof RemoteProtocolError) {
        log(`remote error: ${err.message}`);
        return errorText(err.message);
      }
      throw err;
    }
  };
}

/** Edit convention for every optional tool field: omitted leaves it alone, an explicit "" clears it. */
function clearable<T extends string>(value: T | undefined): Exclude<T, ""> | null | undefined {
  if (value === undefined) return undefined;
  if (value === "") return null;
  return value as Exclude<T, "">;
}

server.registerTool(
  "todo_add",
  {
    title: "Add todo",
    description:
      "Capture work the moment it comes up, from any tool or project, without the ceremony of a ticket. Automatically filed under the current project — you never need to say which. Add sourceUrl when it maps to something in Notion/GitLab/Obsidian/GitHub so it can be picked back up there. Use list=\"backlog\" to park something without holding it in context; list=\"todo\" (default) for near-term work.",
    inputSchema: {
      title: z.string().min(1).describe("Short one-line title/summary"),
      description: z.string().optional().describe("Optional longer body text — details, context, links"),
      list: z
        .enum(["todo", "backlog"])
        .default("todo")
        .describe("Which list this item belongs to"),
      category: z
        .string()
        .min(1)
        .optional()
        .describe("Optional free-form category/tag, e.g. a ticket id like \"VPQ-834\""),
      priority: z.enum(["low", "medium", "high"]).optional().describe("Optional priority"),
      dueDate: dateSchema.optional().describe("Optional due date, YYYY-MM-DD"),
      sourceUrl: httpUrlSchema
        .optional()
        .describe(
          "Strongly recommended when this item comes from somewhere with a URL: a GitHub issue/PR, a Notion page, an Obsidian note (if it has a share/publish link), a Slack thread, a doc, etc. Lets a human jump straight back to the source instead of re-finding it.",
        ),
      workspace: z
        .string()
        .optional()
        .describe("Override which project this is filed under. Almost never needed — the current project is filled in automatically."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  withRemoteErrorHandling(async ({ title, description, list, category, priority, dueDate, sourceUrl, workspace: explicit }) => {
    const todo = await (await getMcpTodoService()).create(
      { title, description, list, category, priority, dueDate, sourceUrl, workspace: explicit ? (slugifyWorkspace(explicit) ?? undefined) : undefined },
      currentContext(),
    );
    // Only worth reading the session registry when there is a project to point at — see
    // routingHint, which returns "" immediately for an unfiled item.
    const hint = todo.workspace ? routingHint(await listSessions().catch(() => []), todo.workspace, sessionToken) : "";
    return text(`Added [${todo.list}] ${formatTodo(todo, workspace)}${duplicationWarning(todo.title, todo.description)}${hint}`);
  }),
);

server.registerTool(
  "todo_edit",
  {
    title: "Edit todo",
    description:
      "Edit an existing item's title/description/category/priority/dueDate/sourceUrl/list by id. Only fields you pass are changed. Pass an empty string (\"\") for description/category/priority/dueDate/sourceUrl to clear that field.",
    inputSchema: {
      id: idSchema,
      title: z.string().min(1).optional().describe("New title"),
      description: z.string().optional().describe("New description, or \"\" to clear"),
      category: z.string().optional().describe("New category, or \"\" to clear"),
      priority: z.enum(["low", "medium", "high", ""]).optional().describe("New priority, or \"\" to clear"),
      dueDate: z.union([dateSchema, z.literal("")]).optional().describe("New due date YYYY-MM-DD, or \"\" to clear"),
      sourceUrl: z.union([httpUrlSchema, z.literal("")]).optional().describe("New source link (GitHub/Notion/Obsidian/etc.), or \"\" to clear"),
      list: z.enum(["todo", "backlog"]).optional().describe("Move to this list"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  withRemoteErrorHandling(async ({ id, title, description, category, priority, dueDate, sourceUrl, list }) => {
    const patch = {
      title,
      description: clearable(description),
      category: clearable(category),
      priority: clearable(priority),
      dueDate: clearable(dueDate),
      sourceUrl: clearable(sourceUrl),
      list,
    };
    const todo = await (await getMcpTodoService()).edit(id, patch, currentContext());
    if (!todo) return text(`No todo with id #${id}`);
    return text(`Updated ${formatTodo(todo, workspace)}${duplicationWarning(todo.title, todo.description)}`);
  }),
);

server.registerTool(
  "todo_claim",
  {
    title: "Claim todo",
    description:
      "Mark an item as actively being worked on by you (the calling agent). Advisory, not a lock — check todo_list(inProgress: true) before starting new work to avoid duplicating another agent's active item. Call todo_release or todo_complete when you stop.",
    inputSchema: { id: idSchema },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  withRemoteErrorHandling(async ({ id }) => {
    const context = currentContext();
    const claimed = await (await getMcpTodoService()).claim(id, context);
    if (!claimed) return text(`No todo with id #${id}`);
    const { todo, previousAgent } = claimed;
    const warning = previousAgent && previousAgent !== context.agent ? ` (note: was already claimed by ${previousAgent} — taking over)` : "";
    return text(`Claimed ${formatTodo(todo, workspace)}${warning}`);
  }),
);

server.registerTool(
  "todo_release",
  {
    title: "Release todo",
    description: "Clear the in-progress claim on an item without completing it (e.g. you're pausing this work).",
    inputSchema: { id: idSchema },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  withRemoteErrorHandling(async ({ id }) => {
    const todo = await (await getMcpTodoService()).release(id, currentContext());
    if (!todo) return text(`No todo with id #${id}`);
    return text(`Released ${formatTodo(todo, workspace)}`);
  }),
);

server.registerTool(
  "todo_list",
  {
    title: "List todos",
    description:
      "What's open here. Scoped to the current project (plus unfiled items) unless you ask otherwise, and compact by default — one line per item. Pass workspace:\"*\" to see every project, or verbose:true for full records.",
    inputSchema: {
      filter: z
        .enum(["open", "done", "all"])
        .default("open")
        .describe("Which todos to return"),
      list: z
        .enum(["todo", "backlog", "all"])
        .default("all")
        .describe("Restrict to the todo list, the backlog, or both (default)"),
      category: z.string().optional().describe("Restrict to items with this exact category/tag"),
      agent: z.string().optional().describe("Restrict to items added by this MCP client name, e.g. \"claude-code\""),
      session: z.string().optional().describe("Restrict to items added during this connection's session token (see the 'via' suffix on listed items)"),
      inProgress: z.boolean().optional().describe("If true, restrict to items currently claimed via todo_claim (see the '▶working' suffix)"),
      limit: z.number().int().min(1).max(500).optional().describe("Max number of items to return (for token efficiency / pagination)"),
      offset: z.number().int().min(0).optional().describe("Number of items to skip (for pagination)"),
      workspace: z
        .string()
        .optional()
        .describe("Defaults to the current project (plus unfiled items). Pass \"*\" for every project, or a project name for that one."),
      verbose: z
        .boolean()
        .default(false)
        .describe("Full records (description, source link, provenance) instead of one compact line per item."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  withRemoteErrorHandling(async ({ filter, list, category, agent, session, inProgress, limit, offset, workspace: scope, verbose }) => {
    // The default is the session's own project, NOT everything. One flat list fed by several
    // projects × several agents × many terminals is the failure mode this feature exists to
    // prevent, and it is also the single largest context saving here: an agent in project A
    // stops pulling project B's items into its window on every call.
    const requested = scope === undefined ? (workspace ?? "*") : (slugifyWorkspace(scope) ?? "*");
    const matched = await (await getMcpTodoService()).list({ filter, list, category, agent, session, inProgress, workspace: requested });
    const sorted = sortTodos(matched);
    const total = sorted.length;
    const start = offset ?? 0;
    const paginated = limit !== undefined || offset !== undefined ? sorted.slice(start, limit !== undefined ? start + limit : undefined) : sorted;

    // A scoped list that came back empty must say what it is NOT showing. The second read
    // only happens in that case, so the common path still costs one.
    const notice =
      total === 0 && requested !== "*"
        ? emptyScopeNotice(requested, await (await getMcpTodoService()).list({ workspace: "*" }))
        : scopeNotice(requested);
    return text(formatResult(paginated, filter, list, { limit, offset, total }, verbose, workspace) + notice);
  }),
);

server.registerTool(
  "todo_complete",
  {
    title: "Complete todo",
    description: "Mark a todo as done by id.",
    inputSchema: { id: idSchema },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  withRemoteErrorHandling(async ({ id }) => {
    const todo = await (await getMcpTodoService()).complete(id, currentContext());
    if (!todo) return text(`No todo with id #${id}`);
    return text(`Completed ${formatTodo(todo, workspace)}`);
  }),
);

server.registerTool(
  "todo_history",
  {
    title: "Todo history",
    description: "Show the change history (create/edit/claim/release/complete) for one item, who made each change and when.",
    inputSchema: { id: idSchema },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  withRemoteErrorHandling(async ({ id }) => {
    // Goes through history() rather than reading the item's inline preview: since v3.0 the
    // full log lives in history.json.enc, and this is one of only two callers that opens it.
    const entries = await (await getMcpTodoService()).history(id);
    if (!entries) return text(`No todo with id #${id}`);
    return text(formatHistoryEntries(entries, id));
  }),
);

server.registerTool(
  "todo_version",
  {
    title: "Server version",
    description:
      "Report this docket process's data format version and start time. Use to sanity-check whether your MCP connection is running stale code (e.g. right after an update) — if todo_list output looks wrong (missing/undefined fields), check this first and reconnect if the process looks old.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => text(`docket formatVersion=${CURRENT_FORMAT_VERSION}, process started ${startedAt}, pid ${process.pid}`),
);

server.registerTool(
  "todo_check_update",
  {
    title: "Check for docket update",
    description:
      "Check whether a newer version of docket is published on npm. Read-only — never installs anything. If one is available, tell the user and let THEM decide whether to run `docket update` in their own terminal (it asks for confirmation before installing).",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    try {
      const result = await checkForUpdate(SCRIPT_PATH);
      if (result.installKind === "dev-clone") return text("This is a local git clone, not an npm install — use `git pull` to update.");
      if (result.installKind === "npx") return text("Running via npx — always gets the latest published version automatically, nothing to check.");
      if (result.updateAvailable) {
        return text(`Update available: ${result.currentVersion} → ${result.latestVersion}. The user can run \`docket update\` in a terminal to install it.`);
      }
      return text(`Already up to date (${result.currentVersion}).`);
    } catch (err) {
      return text(`Couldn't check for updates: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "todo_delete",
  {
    title: "Delete todo",
    description: "Permanently remove a todo by id.",
    inputSchema: { id: idSchema },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  withRemoteErrorHandling(async ({ id }) => {
    const context = currentContext();
    const removed = await (await getMcpTodoService()).delete(id, context);
    if (!removed) return text(`No todo with id #${id}`);
    log(`deleted #${removed.id} "${removed.title}" by ${context.agent ?? "unknown"}`);
    return text(`Deleted #${removed.id} ${removed.title}`);
  }),
);

function printHelp() {
  console.log(`
docket - one list every AI tool you use can write to, across every project

Usage:
  docket [command] [options]

Commands:
  (no args)             Start MCP server over stdio (when spawned by AI host)
  list [filter]         List todos in the current project (filter: open | done | all, default: open)
  workspaces            List projects with open/total counts and last activity
  sessions              List agent sessions open right now (agent, project, idle time)
  hook <sub>            Claude Code SessionStart integration (install, uninstall, doctor)
  stats                 Display terminal statistics widget with active claims
  web                   Ensure web UI dashboard is running and print its URL
  export [options]      Export todos to stdout or a file (--format json|markdown)
  import <file>         Import todos from a JSON or Markdown file
  backup <file>         Encrypted full backup: identity, todos, paired peers (password-protected)
  restore <file>        Restore a backup — REPLACES this device's identity/todos/peers
  restore <file> --force  …even while an MCP host or \`docket serve\` is still running
  restore --from-v7     Undo the v7→v8 migration before downgrading to docket 2.x
  check-update          Check npm for a newer version without installing anything
  update                Check, confirm, install, self-test, and roll back on failure
  help, --help, -h      Show this help message

  serve                 Run an authoritative docket server for remote/self-hosted mode (see \`docket serve --help\`-equivalent docs)
  devices <sub>         Manage devices paired with a \`docket serve\` running on THIS machine (pair, pending, approve, deny, list, revoke, restore)
  pair <serverUrl>      Pair THIS device with a remote docket server (RFC "Local and Self-Hosted Backend Modes" §13)
  status                Show deployment mode, resolved project, live sessions, and store/connection health
  backend use <url>     Switch this device to a self-hosted server, migrating local data to it if the server is empty
  backend localize      Download the current remote server's workspace and switch back to local mode

List options:
  -w, --workspace <n>   Scope to one project instead of the current directory's
  --all                 Every project, unscoped

Export options:
  --format, -f <fmt>    Export format: "json" (default) or "markdown" / "md"
  --out, -o <file>      Write export output directly to file

Environment variables:
  DOCKET_WEB_PORT           Port for the local web UI (default: 8787)
  DOCKET_WORKSPACE          Override the project this session files items under (see docs/workspaces.md)
  DOCKET_HOOKS              Set to "off" to disable the SessionStart hook without editing any config
  DOCKET_MODE               "local" (default) or "remote" — see \`docket pair\` and ~/.config/docket/config.json
  DOCKET_SERVER_URL         Server URL to use when DOCKET_MODE=remote
  DOCKET_ALLOW_INSECURE_REMOTE  Set to "1" to allow a non-HTTPS remote server URL (trusted LAN dev only)
  DOCKET_SERVER_HOST        Bind address for \`docket serve\` (default: 127.0.0.1; see --host)
  DOCKET_SERVER_PORT        Port for \`docket serve\` (default: 8788; see --port)

Disaster recovery:
  \`export\`/\`import\` move just the todo list, in the clear, between tools.
  \`backup\`/\`restore\` are for THIS device: an encrypted bundle of its sync identity,
  todos, and paired-peer list, so a lost or wiped machine can be brought back — on the
  same or different hardware — and still be recognized by its paired devices, instead
  of showing up as a brand-new, unpaired one. Store the backup file and its password
  separately; either alone is useless, but losing BOTH means the backup is unrecoverable.

Examples:
  docket stats
  docket list all
  docket export --format markdown > backup.md
  docket import backup.md
  docket backup ./docket.backup
  docket restore ./docket.backup
`);
}

/**
 * The store the CLI's read-only commands should be looking at — which in remote mode is the
 * SERVER's, not this device's leftover local file.
 *
 * `docket list`, `stats`, `workspaces` and `export` all read local storage directly. In
 * local mode that is the authoritative store and everything is fine. In remote mode it is a
 * file nothing has written since the switch, so the CLI in one terminal reported an empty
 * or months-old list while the MCP tools in the editor showed the real one — a split brain
 * the user could see, with no error anywhere to explain it.
 *
 * The renderers all take a TodoStore, so remote mode gets one built from the authoritative
 * list rather than each command growing its own remote branch. The fields a store has and a
 * list does not (nextId, seqCounter) are local coordinates that none of these commands read.
 */
async function readStoreForReading(): Promise<TodoStore> {
  const deployment = await getDeployment();
  if (deployment.mode !== "remote") return readStore();
  const todos = await (await getMcpTodoService()).list({ filter: "all", list: "all" });
  return { formatVersion: CURRENT_FORMAT_VERSION, nextId: todos.length + 1, todos, deletedUuids: [], seqCounter: 0 };
}

async function handleCli(args: string[]): Promise<boolean> {
  const cmd = args[0]?.toLowerCase();

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(await getCurrentVersion(SCRIPT_PATH));
    return true;
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return true;
  }

  if (cmd === "stats") {
    console.log(renderStatsWidget(await readStoreForReading()));
    return true;
  }

  if (cmd === "list" || cmd === "ls") {
    const flagIndex = args.findIndex((a) => a === "-w" || a === "--workspace");
    const positional = args[1] && !args[1].startsWith("-") ? args[1].toLowerCase() : "";
    const filter = (positional as "open" | "done" | "all") || "open";
    // No flags scopes to the cwd's project, exactly like the MCP default — the CLI and the
    // agents have to agree about what "the list" means or the tool teaches two different
    // mental models.
    const scope = args.includes("--all")
      ? "*"
      : flagIndex !== -1
        ? (slugifyWorkspace(args[flagIndex + 1] ?? "") ?? "*")
        : ((await currentWorkspace()).workspace ?? "*");
    const store = await readStoreForReading();
    const todos = filterTodos(store.todos, { filter, workspace: scope });
    const notice =
      todos.length === 0 && scope !== "*"
        ? emptyScopeNotice(scope, store.todos, "--all for every project")
        : scopeNotice(scope, "--all for every project");
    console.log(formatResult(todos, filter, "all", undefined, true, scope === "*" ? null : scope) + notice);
    return true;
  }

  if (cmd === "sessions") {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log("No agent sessions open right now.");
      return true;
    }
    const width = Math.max(...sessions.map((s) => (s.agent ?? "unknown").length));
    for (const s of sessions) {
      console.log(`${(s.agent ?? "unknown").padEnd(width)}  ${(s.workspace ?? "(unfiled)").padEnd(24)} ${formatIdle(s.lastSeenAt).padEnd(9)} pid ${s.pid}  ${s.cwd}`);
    }
    return true;
  }

  if (cmd === "workspaces" || cmd === "ws") {
    const summary = summarizeWorkspaces((await readStoreForReading()).todos);
    if (summary.length === 0) {
      console.log("No items yet — nothing to group into projects.");
      return true;
    }
    const current = (await currentWorkspace()).workspace;
    const width = Math.max(...summary.map((w) => w.name.length));
    for (const { name, open, total, lastActivity } of summary) {
      const here = name === current ? "  ← here" : "";
      console.log(
        `${name.padEnd(width)}  ${String(open).padStart(4)} open / ${String(total).padStart(4)} total   last ${lastActivity.slice(0, 16).replace("T", " ")}${here}`,
      );
    }
    return true;
  }

  if (cmd === "web") {
    // RFC §26: in remote mode, `docket web` opens the SERVER's Web UI — never a second,
    // separately-stateful local one. (Serving the server's own Web UI pages from here is
    // Phase 4/RFC §26 scope; this stops short of the wrong behavior without yet building
    // the right one.)
    const deployment = await getDeployment();
    if (deployment.mode === "remote") {
      console.log(`This workspace is hosted by ${deployment.serverUrl} — open its Web UI directly in a browser.`);
      return true;
    }
    await ensureWebUiRunning();
    console.log(`Web UI available at: http://localhost:${WEB_PORT}`);
    return true;
  }

  if (cmd === "check-update") {
    const result = await checkForUpdate(SCRIPT_PATH);
    if (result.installKind === "dev-clone") console.log("Local git clone — run `git pull` and `npm run build` to update.");
    else if (result.installKind === "npx") console.log("Running via npx — always latest, nothing to check.");
    else if (result.updateAvailable) console.log(`Update available: ${result.currentVersion} → ${result.latestVersion}. Run \`docket update\`.`);
    else console.log(`Up to date (${result.currentVersion}).`);
    return true;
  }

  if (cmd === "update") {
    await runUpdate(SCRIPT_PATH, {
      confirm: async (message) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await rl.question(`${message} [y/N] `);
          return /^y(es)?$/i.test(answer.trim());
        } finally {
          rl.close();
        }
      },
    });
    return true;
  }

  if (cmd === "export") {
    const formatIdx = args.findIndex((a) => a === "--format" || a === "-f");
    const outIdx = args.findIndex((a) => a === "--out" || a === "-o");
    const format = (formatIdx !== -1 ? args[formatIdx + 1]?.toLowerCase() : "json") ?? "json";
    const outFile = outIdx !== -1 ? args[outIdx + 1] : null;

    const store = await readStoreForReading();
    const content = format === "markdown" || format === "md" ? exportToMarkdown(store) : exportToJson(store);

    if (outFile) {
      await atomicWriteFile(outFile, content, 0o644);
      console.log(`Exported ${store.todos.length} items to ${outFile}`);
    } else {
      process.stdout.write(content + "\n");
    }
    return true;
  }

  if (cmd === "import") {
    const file = args[1];
    if (!file) {
      console.error("Error: Please provide a file to import. Example: docket import ./tasks.json");
      process.exit(1);
    }
    const raw = await readFile(file, "utf8");
    const isJson = file.endsWith(".json") || raw.trim().startsWith("{") || raw.trim().startsWith("[");
    const parse = (store: TodoStore): { added: number } =>
      isJson ? importFromJson(store, raw, deviceId, deviceName) : importFromMarkdown(store, raw, deviceId, deviceName);

    const deployment = await getDeployment();
    if (deployment.mode === "remote") {
      // Parse into a scratch store, then send the result to the authoritative one. Writing
      // to the local file here was a silent data-loss path: the import reported success and
      // the items existed nowhere the user could reach them.
      const scratch: TodoStore = { formatVersion: CURRENT_FORMAT_VERSION, nextId: 1, todos: [], deletedUuids: [], seqCounter: 0 };
      const parsed = parse(scratch);
      const service = await getMcpTodoService();
      const result = await service.importSnapshot(buildSnapshot(scratch, {}, deviceId));
      console.log(`Imported ${result.imported} of ${parsed.added} item(s) into ${deployment.serverUrl}.`);
      if (result.alreadyPresent > 0) console.log(`${result.alreadyPresent} were already there.`);
      return true;
    }

    const result = await withStore(parse);
    console.log(`Successfully imported ${result.added} items into todo store.`);
    return true;
  }

  if (cmd === "backup") {
    // RFC §30: a client machine's local store is unused/empty in remote mode — backing it
    // up would look like it succeeded while silently protecting nothing. Backups belong on
    // the server, which is the only place authoritative state actually lives.
    const deployment = await getDeployment();
    if (deployment.mode === "remote") {
      console.log(`This workspace is hosted by ${deployment.serverUrl}.`);
      console.log("Backups must be created on the server: run `docket backup <file>` there instead.");
      return true;
    }
    const file = args[1];
    if (!file) {
      console.error("Error: Please provide an output file. Example: docket backup ./docket.backup");
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Plain, visible prompt rather than masked input — matches this tool's existing
    // trust model (a personal/LAN tool, not a hardened multi-tenant one; see #123's
    // resolution on viewer transport security for the same tradeoff). Masking input
    // correctly needs raw-mode terminal handling that risks leaving the terminal in a
    // broken state if this process is killed mid-prompt — not worth it here.
    let password: string;
    try {
      password = await rl.question("Backup password (anyone with this file AND this password gets full access — choose something strong): ");
    } finally {
      rl.close();
    }
    if (!password) {
      console.error("Error: a password is required — an unencrypted backup would contain this device's private sync identity and every paired peer's shared secret.");
      process.exit(1);
    }
    const bundle = await createBackup(password);
    // The one write where "it printed success" and "it is on the disk" must not be able to
    // disagree: a truncated backup is discovered on the day it is needed. 0600 because the
    // bundle carries this device's private sync identity, encrypted or not.
    await atomicWriteFile(file, bundle);
    console.log(`Backup written to ${file} (${bundle.length} bytes, encrypted). Restore it with \`docket restore ${file}\` — on this or any other machine.`);
    return true;
  }

  if (cmd === "restore" && args.includes("--from-v7")) {
    // The downgrade escape hatch. Deliberately its own branch rather than a flag threaded
    // through the password flow below: this restores a plain pre-migration copy of the
    // store, not an encrypted backup bundle, so there is nothing to decrypt and no password
    // to ask for.
    const restored = await restorePreUpgradeStore();
    if (!restored) {
      console.error("No pre-upgrade store found. This install either never migrated from v7, or was migrated by a build older than 3.0.0.");
      process.exit(1);
    }
    console.log(`Restored the pre-upgrade (v7) store from ${restored.restoredFrom}.`);
    console.log(`Your v8 store was moved aside to ${restored.movedAside} — nothing was deleted.`);
    console.log("");
    console.log(`Now reinstall a docket release that reads v7:\n\n  npm install -g @pasichdev/docket@${LAST_V7_RELEASE}\n`);
    console.log("Restart any running MCP host afterwards.");
    return true;
  }

  if (cmd === "restore") {
    const file = args.slice(1).find((a) => !a.startsWith("-"));
    if (!file) {
      console.error("Error: Please provide a backup file. Example: docket restore ./docket.backup");
      process.exit(1);
    }
    const buf = await readFile(file);
    if (!isBackupFile(buf)) {
      console.error(`Error: ${file} doesn't look like a docket backup file.`);
      process.exit(1);
    }

    /*
     * Restore replaces the at-rest key and this device's identity, both of which every
     * running docket process is holding in memory. Those processes can no longer CORRUPT the
     * restored data — storage and the registries check the data-directory generation
     * immediately before every commit — but they will start refusing writes the moment this
     * finishes, which from the user's side looks like their editor breaking. Better to say
     * so now, while the machine is still in a state they recognise.
     */
    const holders = await liveHoldersOfDataDirectory();
    if (holders.length > 0 && !args.includes("--force")) {
      console.error("Error: something is still using this data directory:");
      for (const holder of holders) console.error(`  - ${holder}`);
      console.error("");
      console.error("Close those first (quit the MCP host, stop `docket serve`), then run restore again.");
      console.error("They cannot corrupt the restored data — they will simply stop writing — so `docket restore --force` is safe if you would rather not stop them, but they must be restarted afterwards.");
      process.exit(1);
    }

    const [password, proceed] = await cliAskQuestions([
      "Backup password: ",
      "This REPLACES this device's identity, todos, and paired-peer list with the backup's (the current files are renamed aside as .bak, not deleted). Continue? [y/N] ",
    ]);
    if (!/^y(es)?$/i.test(proceed.trim())) {
      console.log("Restore cancelled.");
      return true;
    }
    const { restoredFiles } = await restoreBackup(buf, password);
    console.log(`Restored: ${restoredFiles.join(", ")}. Restart docket (and any running MCP host) for the restored identity to take effect.`);
    return true;
  }

  return false;
}

// Graceful shutdown handlers
// Deregister before exiting so a closed terminal disappears from `docket sessions`
// immediately, instead of lingering until its TTL. The pid check is the backstop for the
// cases this never runs for (SIGKILL, a host that just closes the pipe).
async function shutdown(signal: string): Promise<never> {
  log(`mcp process received ${signal}, exiting cleanly`);
  await endSession(sessionToken).catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function main() {
  const args = process.argv.slice(2);
  // Before anything reads the store: a restore that was interrupted partway through its
  // commit left a journal naming the files it had yet to move, and finishing it is the only
  // way this data directory becomes either the old state or the new one rather than a mix.
  await finishAnyInterruptedRestore();
  if (args.length > 0) {
    const handled = await handleCli(args);
    if (handled) return;
  }

  // No args from here on. This used to also treat a TTY stdin as "a human at a terminal,
  // print help and exit" instead of starting the MCP server — but some MCP hosts allocate
  // a pty-like stdin for the subprocesses they spawn even though nothing interactive is
  // going on, which made docket print its help text and return without ever calling
  // server.connect(): the host saw its connection close immediately, an otherwise
  // unexplained "MCP startup failure". Print a one-line hint on stderr (stdout has to
  // stay clean for JSON-RPC either way) but always start the server underneath, so a real
  // host is never silently starved of a server regardless of what its stdin looks like.
  if (process.stdin.isTTY) {
    process.stderr.write("docket: waiting for an MCP client on stdio. Run `docket help` for CLI usage.\n");
  }

  // Resolve deployment mode (and, in remote mode, actually construct the repository —
  // this is where an unpaired device or mismatched server fails) BEFORE connecting the
  // transport, so a misconfigured remote mode never presents the host with a connection
  // that then mysteriously errors on the first tool call — it fails at startup instead,
  // through this function's existing top-level `.catch` (RFC §22: fail loud).
  const deployment = await getDeployment();
  if (deployment.mode === "remote") await getMcpTodoService();

  await refreshWorkspace("resolved at startup");
  // Not awaited: nothing reads this placeholder registration, and onClientReady replaces it
  // with the real agent name the moment the host introduces itself. Blocking the transport
  // on a file-lock round trip would spend the most latency-sensitive moment of a session on
  // a value that is about to be overwritten.
  void registerThisSession();

  // Fires after initialize, which is when the client's name and capabilities are first
  // known. Not awaited anywhere: a host slow to answer listRoots must not delay the
  // session, and the cwd-derived workspace is already in place and usable.
  server.server.oninitialized = () => void onClientReady();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Both of these touch/create LOCAL on-disk state (todos.json.enc's legacy-field
  // migration, and a second locally-stateful Web UI process) — skipped entirely in remote
  // mode, per RFC §22/§38: "Remote Mode owns no local writable replica at all." Without
  // this guard, a remote-mode MCP session would silently create an empty local store the
  // very first time it ran, exactly the split-brain risk that invariant exists to prevent.
  if (deployment.mode === "local") {
    await migrateLegacyFields();
    await ensureWebUiRunning();
  }
}

main().catch((err: Error) => {
  // The stack goes to the log file, where someone debugging can find it. What reaches the
  // terminal is the message alone: a person who typed a filename that doesn't exist is not
  // helped by a stack trace, and "failed to start" is the wrong sentence for a command that
  // started fine and then hit a bad argument.
  log(`docket failed: ${err.stack ?? err.message}`);
  const ranACommand = process.argv.length > 2;
  console.error(ranACommand ? `docket: ${err.message}` : `docket failed to start: ${err.message}`);
  process.exit(1);
});
