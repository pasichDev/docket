#!/usr/bin/env node
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { constants, openSync, realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import {
  detectAllRuntimes,
  detectDocket,
  listOpencodeProviders,
  resolveWorkspace,
  type DetectedRuntime,
} from "./discovery.js";
import { findDocketDist } from "./docket.js";
import { EventBus } from "./events.js";
import {
  acquireCrewHomeLock,
  atomicWriteFile,
  crewPaths,
  CrewHomeLockedError,
  ensureCrewTree,
  type CrewHomeLock,
  type CrewPaths,
} from "./paths.js";
import { createCrewServer, CREW_VERSION, type CrewServer } from "./server.js";
import { composeSkills, defaultSkillRoots, discoverSkills, skillNamesForProfile } from "./skills.js";
import { freshState, recoverInterruptedRuns, StateStore } from "./state.js";
import { Supervisor } from "./supervisor.js";
import { DEFAULT_CREW_PORT, type CrewConfig } from "./types.js";
import { isGitRepo, listCrewBranches, listWorktrees } from "./worktrees.js";

/**
 * docket-crew CLI (spec §34).
 *
 * Foundation commands (this file): doctor, start, stop, status, and the hidden `__daemon`
 * the detached daemon process runs. The orchestration commands (ask, office, agents,
 * profiles, agent start/stop) live in runtime.ts and register themselves through
 * `registerCrewCommands`, which this file imports dynamically — so a foundation-only build
 * still runs, and the orchestration layer never has to edit this file to add a command.
 *
 * `start` prints the Office URL prominently and takes `--open`: after that one command the
 * user need not touch the CLI again, because everything the CLI can do the Office can do
 * through the same endpoints.
 */

const execFileP = promisify(execFile);

/**
 * The orchestration layer's module, imported dynamically THROUGH A VARIABLE on purpose: a
 * foundation-only build (no orchestration layer) must still compile and run. When present,
 * runtime.ts exports `registerCrewCommands(registry)` and `attachToDaemon(ctx)`.
 */
const ORCHESTRATOR_SPECIFIER = "./runtime.js";

export interface CrewCommandContext {
  args: string[];
  paths: CrewPaths;
}

export type CrewCommand = (ctx: CrewCommandContext) => Promise<number>;

export interface CommandRegistry {
  register(name: string, description: string, handler: CrewCommand): void;
  list(): { name: string; description: string }[];
}

const commands = new Map<string, { description: string; handler: CrewCommand; hidden?: boolean }>();

export const registry: CommandRegistry = {
  register(name, description, handler) {
    commands.set(name, { description, handler });
  },
  list() {
    return [...commands.entries()].filter(([, c]) => !c.hidden).map(([name, c]) => ({ name, description: c.description }));
  },
};

interface DaemonRecord {
  pid: number;
  port: number;
  startedAt: string;
}

async function readDaemonRecord(paths: CrewPaths): Promise<DaemonRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(paths.daemonFile, "utf8")) as DaemonRecord;
    return typeof parsed.pid === "number" && typeof parsed.port === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(url: string, timeoutMs = 1500): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function desiredPort(): number {
  return Number(process.env.DOCKET_CREW_PORT ?? DEFAULT_CREW_PORT);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Live members of the daemon's process group. The detached daemon leads its own group, so this is exactly the set of Crew-owned processes. */
async function processGroupPids(pgid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileP("pgrep", ["-g", String(pgid)], { encoding: "utf8" });
    return stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isFinite(pid));
  } catch {
    return []; // pgrep exits 1 when the group is empty
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

function capabilitySummary(runtime: DetectedRuntime): string {
  const caps = runtime.capabilities;
  if (!caps) return "";
  const mark = (label: string, ok: boolean) => `${label} ${ok ? "yes" : "no"}`;
  return [
    mark("non-interactive:", caps.nonInteractive),
    mark("structured-output:", caps.structuredOutput),
    mark("resume:", caps.resume),
    mark("model-selection:", caps.modelSelection),
  ].join("  ");
}

/**
 * Everything `doctor` checks, gathered without printing. Separated from the rendering so the
 * checks can be tested for what they CONCLUDE rather than for how they are spelled.
 *
 * Every problem here is one somebody actually hit: a worker silently losing its `todo_*` tools
 * because Docket Core was not built, a profile's `skills:` entry silently injecting nothing,
 * `crew/*` branches piling up unnoticed, and a daemon from a previous session still holding
 * the port while `daemon.json` says nothing is running.
 */
export interface DoctorReport {
  /** Docket Core's built dist, which is what supplies workers their `todo_*` MCP tools. */
  docketDist: { path: string } | { error: string };
  skills: {
    roots: { kind: string; dir: string; present: boolean }[];
    /** One row per profile: what it asked for, what it got, and from where. */
    profiles: {
      profile: string;
      resolved: { name: string; source: string; shadowed: string[] }[];
      missing: string[];
    }[];
    errors: string[];
  };
  /** Only when the crew is running inside a git repository. */
  worktrees: { checkouts: number; branches: number; oldestBranch?: string } | null;
  /** A daemon answering on the port that this crew home does not know about. */
  strayDaemon: { port: number; reason: string } | null;
}

export async function collectDoctor(paths: CrewPaths, config: CrewConfig, workspaceRoot: string | null): Promise<DoctorReport> {
  const report: DoctorReport = {
    docketDist: { error: "not checked" },
    skills: { roots: [], profiles: [], errors: [] },
    worktrees: null,
    strayDaemon: null,
  };

  try {
    report.docketDist = { path: await findDocketDist() };
  } catch (err) {
    report.docketDist = { error: (err as Error).message };
  }

  // The same roots the orchestrator resolves against at turn time (runtime.ts passes
  // `<crew home>/skills` as crewHomeDir), so what doctor prints is what an agent will get.
  const roots = defaultSkillRoots({ crewHomeDir: join(paths.root, "skills") });
  const catalog = await discoverSkills(roots);
  report.skills.roots = roots.map((r) => ({
    kind: r.kind,
    dir: r.dir,
    present: !catalog.missingRoots.includes(r.dir),
  }));
  for (const profile of Object.values(config.profiles)) {
    const composed = composeSkills(catalog, skillNamesForProfile(profile));
    report.skills.profiles.push({
      profile: profile.name,
      resolved: composed.included.map((s) => ({ name: s.name, source: s.path, shadowed: s.shadows })),
      missing: composed.omitted.map((o) => `${o.name} (${o.reason})`),
    });
    for (const d of composed.diagnostics) if (d.severity === "error") report.skills.errors.push(d.message);
  }
  for (const d of catalog.diagnostics) if (d.severity === "error") report.skills.errors.push(d.message);

  if (workspaceRoot && (await isGitRepo(workspaceRoot))) {
    try {
      const [checkouts, branches] = await Promise.all([listWorktrees(workspaceRoot), listCrewBranches(workspaceRoot)]);
      report.worktrees = {
        checkouts: checkouts.length,
        branches: branches.length,
        ...(branches[0] ? { oldestBranch: `${branches[0].branch} (${branches[0].lastCommit})` } : {}),
      };
    } catch {
      // A repo git refuses to describe is not a doctor failure; the rest of the report stands.
    }
  }

  /**
   * A daemon nobody is tracking. Two ways to get one: a `docket-crew start` from a DIFFERENT
   * DOCKET_CREW_HOME that took the same port, or a daemon whose daemon.json was deleted. Both
   * present identically to a user — `start` reports success and the Office shows another
   * crew's agents — so name the case rather than leaving them to guess.
   */
  const port = desiredPort();
  const record = await readDaemonRecord(paths);
  const answering = Boolean(await fetchJson(`http://127.0.0.1:${port}/api/health`));
  if (answering && (!record || !pidAlive(record.pid))) {
    report.strayDaemon = {
      port,
      reason: record
        ? `daemon.json names pid ${record.pid}, which is gone, but something still answers on ${port}`
        : `no daemon.json in ${paths.root}, but something already answers on ${port}`,
    };
  } else if (answering && record && record.port !== port) {
    report.strayDaemon = { port, reason: `this crew home's daemon is on ${record.port}, but something else holds ${port}` };
  }

  return report;
}

const doctor: CrewCommand = async ({ paths }) => {
  await ensureCrewTree(paths);
  const [config, runtimes, docket, workspace] = await Promise.all([
    loadConfig(paths),
    detectAllRuntimes(),
    detectDocket(),
    resolveWorkspace(process.cwd()),
  ]);
  const report = await collectDoctor(paths, config, workspace.root);

  console.log(`Docket Crew ${CREW_VERSION} — doctor\n`);
  console.log("Docket Core:");
  console.log(`  docket CLI:  ${docket.cli ?? "not found on PATH"}`);
  console.log(`  web UI:      ${docket.webReachable ? `reachable at ${docket.webUrl}` : `not reachable at ${docket.webUrl}`}`);
  /**
   * The footgun this line exists for: workers are handed Docket's MCP server only when its
   * dist is findable (runtime.ts buildMcpServerSpecs). Without it they lose every `todo_*`
   * tool with no error anywhere — they simply cannot claim the task they were told to claim.
   */
  console.log(
    report.docketDist && "path" in report.docketDist
      ? `  built dist:  ${report.docketDist.path} — workers get the todo_* tools`
      : `  built dist:  NOT FOUND — workers will silently have NO todo_* tools. Run \`npm run build\` in the Docket repo.`,
  );
  console.log(
    `  workspace:   ${workspace.workspace ?? "(none)"} (source: ${workspace.source}${workspace.root ? `, root: ${workspace.root}` : ""})`,
  );

  console.log("\nRuntimes:");
  let missing = 0;
  for (const runtime of Object.values(runtimes)) {
    if (runtime.installed) {
      console.log(`  [ok] ${runtime.id.padEnd(9)} ${runtime.version ?? "?"}  ${runtime.executable}`);
      const caps = capabilitySummary(runtime);
      if (caps) console.log(`       ${caps}`);
      if (runtime.id === "opencode" && runtime.executable) {
        const providers = await listOpencodeProviders(runtime.executable);
        if (providers.length > 0) console.log(`       providers: ${providers.join(", ")}`);
      }
    } else {
      missing += 1;
      console.log(`  [--] ${runtime.id.padEnd(9)} ${runtime.error ?? "not found"}`);
    }
  }

  console.log("\nCrew profiles (config.yml):");
  for (const profile of Object.values(config.profiles)) {
    const extras = [profile.model, profile.provider && `via ${profile.provider}`].filter(Boolean).join(", ");
    console.log(`  ${profile.name.padEnd(18)} ${profile.runtime.padEnd(9)} ${profile.role}${extras ? `  (${extras})` : ""}`);
  }
  console.log(`  manager: ${config.manager.profile}`);

  console.log("\nSkills (what each profile's turns will actually carry):");
  for (const root of report.skills.roots) {
    console.log(`  root ${root.kind.padEnd(9)} ${root.dir}${root.present ? "" : "  (does not exist)"}`);
  }
  for (const row of report.skills.profiles) {
    console.log(`  ${row.profile}`);
    for (const s of row.resolved) {
      console.log(`    [ok] ${s.name.padEnd(16)} ${s.source}`);
      for (const shadowed of s.shadowed) console.log(`         overrides ${shadowed}`);
    }
    for (const m of row.missing) console.log(`    [!!] ${m} — this profile's agents run WITHOUT it`);
  }
  for (const e of report.skills.errors) console.log(`  [!!] ${e}`);

  console.log("\nWorktrees and crew branches:");
  if (!report.worktrees) {
    console.log("  (not running inside a git repository — isolated assignments are unavailable)");
  } else {
    console.log(`  live checkouts: ${report.worktrees.checkouts}   crew/* branches: ${report.worktrees.branches}`);
    if (report.worktrees.oldestBranch) console.log(`  oldest:         ${report.worktrees.oldestBranch}`);
    /**
     * Deliberately advice, not a cleanup. §29 makes the branch the deliverable, and Crew has
     * no way to know which of these a human still wants — so the accumulation is made visible
     * and the deletion stays theirs. See docs/OPERATIONS.md.
     */
    if (report.worktrees.branches > 0) {
      console.log(`  Nothing removes these automatically — each one is an assignment's deliverable.`);
      console.log(`  Review with: git branch --list 'crew/*'   then delete the merged ones yourself.`);
    }
  }

  if (report.strayDaemon) {
    console.log(`\n[!!] Stray daemon: ${report.strayDaemon.reason}.`);
    console.log(`     \`docket-crew start\` will reuse it, and the Office will show ITS crew, not yours.`);
    console.log(`     Set DOCKET_CREW_PORT to another port, or stop the process holding ${report.strayDaemon.port}.`);
  }

  console.log(`\nCrew home: ${paths.root}`);
  // A missing runtime is informational (nobody installs all three); a skill a profile names
  // but cannot load, or a missing Docket dist, is a real misconfiguration.
  const broken = report.skills.errors.length > 0 || !("path" in report.docketDist);
  return missing === 0 && !broken ? 0 : 1;
};

// ---------------------------------------------------------------------------
// start / __daemon / stop / status
// ---------------------------------------------------------------------------

/**
 * Print the Office URL the way the user should actually see it: on its own, unmissable — and
 * carrying `?key=…`, because the page only mints a UI session for a load that presents the
 * daemon's UI key (crew/src/server.ts, UI_KEY_HEADER). THIS TERMINAL is where the human gets
 * that link; a page opened without it renders but cannot command the crew.
 */
async function announceOffice(paths: CrewPaths, port: number): Promise<void> {
  const url = await officeUrlFor(paths, port);
  console.log("");
  console.log(`  Office UI:  ${url}`);
  console.log("  Everything else — starting the manager, giving it a goal, watching the team — happens there.");
  console.log("");
}

/** The keyed Office URL, from the orchestration layer when it is present. */
async function officeUrlFor(paths: CrewPaths, port: number): Promise<string> {
  const base = `http://127.0.0.1:${port}`;
  try {
    const mod = (await import(ORCHESTRATOR_SPECIFIER)) as {
      officeUrl?: (paths: CrewPaths, base: string) => Promise<string>;
    };
    return (await mod.officeUrl?.(paths, base)) ?? `${base}/`;
  } catch {
    return `${base}/`;
  }
}

async function maybeOpen(open: boolean, paths: CrewPaths, port: number): Promise<void> {
  if (!open) return;
  try {
    const mod = (await import(ORCHESTRATOR_SPECIFIER)) as { openInBrowser?: (url: string) => Promise<void> };
    await mod.openInBrowser?.(await officeUrlFor(paths, port));
  } catch {
    // No orchestration layer, or no opener on this platform: the URL is already printed.
  }
}

const start: CrewCommand = async ({ args, paths }) => {
  const open = args.includes("--open");
  await ensureCrewTree(paths);
  const config = await loadConfig(paths);
  const workspace = await resolveWorkspace(process.cwd());
  const runtimes = await detectAllRuntimes();
  const installed = Object.values(runtimes).filter((r) => r.installed);
  console.log(`workspace: ${workspace.workspace ?? "(none)"} (${workspace.source})`);
  console.log(`runtimes:  ${installed.map((r) => `${r.id} ${r.version ?? ""}`.trim()).join(", ") || "none detected"}`);
  console.log(`profiles:  ${Object.keys(config.profiles).join(", ")} (manager: ${config.manager.profile})`);

  /**
   * A LIVE pid is the authority on "is a daemon running", not a health probe's patience.
   *
   * This used to be `pidAlive && healthy ? reuse : delete daemon.json and spawn another one`,
   * so a daemon that merely answered slowly — which the old whole-file `/api/events` read
   * made ordinary — was declared dead, and a second `__daemon` was launched against the same
   * crew home. That second process rewrote state.json, fabricated "interrupted" results for
   * in-flight assignments and rotated the agent token before dying on EADDRINUSE. The home
   * lock in `__daemon` now makes that harmless, but the right answer here is still: never
   * conclude a live pid is dead, and never spawn a second writer for a home that has one.
   */
  const existing = await readDaemonRecord(paths);
  if (existing && pidAlive(existing.pid)) {
    const healthUrl = `http://127.0.0.1:${existing.port}/api/health`;
    // Second, patient probe: a busy daemon deserves more than 1.5 s before it is called dead.
    const health = (await fetchJson(healthUrl)) ?? (await fetchJson(healthUrl, 8000));
    if (health) {
      console.log(`crew daemon already running (pid ${existing.pid})`);
      await announceOffice(paths, existing.port);
      await maybeOpen(open, paths, existing.port);
      return 0;
    }
    console.error(
      `crew daemon pid ${existing.pid} is alive but did not answer on port ${existing.port}.\n` +
        `  Refusing to start a second daemon over the same crew home (${paths.root}) — two writers corrupt it.\n` +
        `  Either wait for it, or run \`docket-crew stop\` and start again.`,
    );
    return 1;
  }
  if (existing) await rm(paths.daemonFile, { force: true }).catch(() => {});

  const cliPath = fileURLToPath(import.meta.url);
  // O_NOFOLLOW: same class as the events.jsonl and run-log appends — the daemon must not be
  // made to write its own stdout through a symlink an agent planted in logs/.
  const daemonLog = openSync(
    `${paths.logsDir}/daemon.log`,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  const child = spawn(process.execPath, [cliPath, "__daemon"], {
    detached: true, // own session + process group: `stop` can account for every Crew-owned pid
    cwd: process.cwd(), // the daemon resolves its workspace where the user ran `start`
    stdio: ["ignore", daemonLog, daemonLog],
    env: process.env,
  });
  child.unref();

  const port = desiredPort();
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  for (let attempt = 0; attempt < 50; attempt++) {
    await sleep(200);
    const health = await fetchJson(healthUrl);
    if (health) {
      console.log(`crew daemon started (pid ${child.pid})`);
      await announceOffice(paths, port);
      await maybeOpen(open, paths, port);
      return 0;
    }
    if (child.pid !== undefined && !pidAlive(child.pid)) break;
  }
  /**
   * Print WHY, not just where to look. The overwhelmingly common cause is `EADDRINUSE` — another
   * daemon (or an unrelated local service) already holds the port — and the daemon logs that as a
   * plain stack trace nobody reads before they have been told to. One line here turns "it didn't
   * start" into "port 8790 is taken", which is the sentence that fixes it.
   */
  console.error(`crew daemon did not become healthy — see ${paths.logsDir}/daemon.log`);
  const reason = await lastLogLines(`${paths.logsDir}/daemon.log`, 3);
  for (const line of reason) console.error(`  ${line}`);
  return 1;
};

/**
 * The last `n` meaningful lines of a log file, for a failure message. Never throws.
 *
 * Stack FRAMES (`    at ...`) are dropped, which is the whole point: a naive tail of a crashed
 * Node process returns the bottom three frames of the trace and hides the one line that says
 * `EADDRINUSE`. What is wanted is the message, which sits above them.
 */
export async function lastLogLines(file: string, n: number): Promise<string[]> {
  try {
    const text = await readFile(file, "utf8");
    return text
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() && !/^\s+at\s/.test(l))
      .slice(-n);
  } catch {
    return [];
  }
}

/**
 * Reap-before-die guard for the two ways a Node process dies without a signal.
 *
 * There was none, anywhere in crew/src, and the cost was concrete: the daemon spawns runtime
 * children in their own process groups, so an uncaught exception (a `RangeError` out of the
 * old whole-file `/api/events` read, say) exited the process with `stopAll()` never running —
 * every child kept going, kept editing worktrees, and `daemon.json` still claimed a daemon
 * that no longer existed. A crash we cannot prevent must at least not leave that behind.
 *
 * Exported and dependency-injected so the reaping can be tested without crashing a test run.
 */
export interface CrashGuardDeps {
  reap: () => Promise<unknown>;
  cleanup: () => Promise<unknown>;
  exit: (code: number) => void;
  timeoutMs?: number;
}

export function makeCrashHandler(deps: CrashGuardDeps): (err: unknown, kind: string) => Promise<void> {
  let handling = false;
  return async (err: unknown, kind: string) => {
    if (handling) return; // a second crash while reaping must not restart the reaping
    handling = true;
    const error = err as Error;
    console.error(`crew daemon: FATAL ${kind}: ${error?.stack ?? String(err)}`);
    console.error(`crew daemon: killing supervised children before exiting — they must not outlive the daemon`);
    const deadline = new Promise<void>((r) => setTimeout(r, deps.timeoutMs ?? 10_000).unref?.());
    try {
      await Promise.race([Promise.allSettled([deps.reap(), deps.cleanup()]), deadline]);
    } catch {
      // Nothing above this to report to; we are already dying.
    }
    deps.exit(1);
  };
}

const daemonMain: CrewCommand = async ({ paths }) => {
  await ensureCrewTree(paths);

  /**
   * FIRST ACT, before a single byte of this crew home is read or written.
   *
   * Every destructive thing a duplicate daemon did — rewriting state.json, fabricating
   * "interrupted" results for another daemon's in-flight assignments, phantom failures in the
   * shared event log, a rotated agent-token that 401s every subsequent turn and silently
   * strips the crew_* tools — happened BEFORE it ever tried to bind the port and discovered
   * it was the second one. Binding cannot protect a directory. This does.
   */
  let lock: CrewHomeLock;
  try {
    lock = await acquireCrewHomeLock(paths);
  } catch (err) {
    if (err instanceof CrewHomeLockedError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  const config = await loadConfig(paths);
  const workspace = await resolveWorkspace(process.cwd());
  const [runtimes, docket] = await Promise.all([detectAllRuntimes(), detectDocket()]);
  const port = desiredPort();

  const store = new StateStore(paths.stateFile, () => freshState(workspace.workspace ?? "unfiled", port));
  const bus = new EventBus(paths.eventsFile);
  const supervisor = new Supervisor({
    store,
    bus,
    paths,
    maxConcurrentRuns: config.automation.maxConcurrentRuns,
    // The turn watchdog's policy is configuration (config.yml automation.turnIdleTimeoutMs);
    // the supervisor owns only the mechanism. Undefined here keeps the shipped default.
    ...(config.automation.turnIdleTimeoutMs === undefined
      ? {}
      : { turnIdleTimeoutMs: config.automation.turnIdleTimeoutMs }),
  });

  const crewServer: CrewServer = createCrewServer({ store, bus, config, paths, supervisor, runtimes, docket, workspace });

  /**
   * Installed BEFORE anything can spawn a child, not after the daemon is fully up: a crash
   * during boot must reap and clean up exactly like a crash at hour six.
   */
  const onCrash = makeCrashHandler({
    reap: () => supervisor.stopAll(2_000),
    cleanup: async () => {
      await rm(paths.daemonFile, { force: true }).catch(() => {});
      await lock.release();
    },
    exit: (code) => process.exit(code),
  });
  process.on("uncaughtException", (err) => void onCrash(err, "uncaughtException"));
  process.on("unhandledRejection", (reason) => void onCrash(reason, "unhandledRejection"));

  /**
   * Bind BEFORE touching state — but answer 503 until everything below has run.
   *
   * Order matters twice over: nothing may mutate this home until we know we are the daemon
   * for it (the lock says so, the successful bind confirms it), and nothing may be SERVED
   * from a daemon whose restart recovery and orchestration routes are still being wired.
   * `docket-crew start` polls /api/health, which stays unhealthy through the 503 window, so
   * it reports success only once the daemon is genuinely up.
   */
  crewServer.hold();
  const boundPort = await crewServer.start(port);

  // Orchestration layer hook (Agent 3): crew/src/orchestrator.ts may export
  // `attachToDaemon({ctx, router, supervisor, ...})` to register Office routes, control
  // endpoints and the manager loop. Its absence is a normal foundation-only run.
  try {
    const mod = (await import(ORCHESTRATOR_SPECIFIER)) as {
      attachToDaemon?: (ctx: {
        server: CrewServer;
        store: StateStore;
        bus: EventBus;
        supervisor: Supervisor;
        config: typeof config;
        paths: CrewPaths;
      }) => Promise<void> | void;
    };
    await mod.attachToDaemon?.({ server: crewServer, store, bus, supervisor, config, paths });
  } catch (err) {
    if ((err as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw err;
  }

  // Restart recovery (spec §46): whatever was mid-run when the previous daemon died is
  // failed, never successful — committed before the server answers its first real request.
  const interruptions = await store.withState((state) => {
    state.port = boundPort;
    if (workspace.workspace) state.workspace = workspace.workspace;
    return recoverInterruptedRuns(state);
  });
  for (const agentId of interruptions.interruptedAgents) {
    await bus.publish("agent.failed", { agentId, summary: `${agentId}: run interrupted by daemon restart` });
  }
  for (const assignmentId of interruptions.interruptedAssignments) {
    await bus.publish("assignment.failed", { assignmentId, summary: "assignment interrupted by daemon restart" });
  }
  /**
   * Mail the dead turn had already drained is unread again (state.ts restoreLastDrainedBatch).
   * Say so: an un-delivery that leaves no trace is how the same message ends up either lost or
   * mysteriously read twice, with nothing in the log either way.
   */
  if (interruptions.restoredMessages.length > 0) {
    await bus.publish("message.sent", {
      summary: `${interruptions.restoredMessages.length} message(s) un-delivered: the turn that drained them never finished`,
      data: { restored: interruptions.restoredMessages, reason: "daemon restart" },
    });
  }

  await atomicWriteFile(
    paths.daemonFile,
    JSON.stringify({ pid: process.pid, port: boundPort, startedAt: new Date().toISOString() } satisfies DaemonRecord, null, 2) + "\n",
  );

  /**
   * Total amnesia must not be quiet (state.ts StateQuarantine). If state.json could not be
   * adopted, this is the ONE place a human is ever going to see it — the daemon otherwise
   * boots looking brand new while `crew/*` branches and worktrees sit on disk with nothing
   * left to explain them.
   */
  const quarantine = store.quarantine;
  if (quarantine) {
    console.error(`crew daemon: started from an EMPTY state — ${quarantine.reason}. Evidence: ${quarantine.file}`);
  }

  await bus.publish("crew.started", {
    summary: quarantine
      ? `crew daemon up on 127.0.0.1:${boundPort} — WARNING: previous state was unreadable and has been set aside`
      : `crew daemon up on 127.0.0.1:${boundPort} (workspace ${workspace.workspace ?? "unfiled"})`,
    data: {
      pid: process.pid,
      port: boundPort,
      interruptions,
      ...(quarantine ? { stateQuarantine: quarantine } : {}),
      ...(bus.degraded ? { eventLogDegraded: bus.degraded } : {}),
    },
  });
  crewServer.markReady();
  console.log(`crew daemon listening on http://127.0.0.1:${boundPort}/ (pid ${process.pid})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`crew daemon: ${signal} — shutting down`);
    try {
      /**
       * Let the orchestration layer finish what it is holding BEFORE anything is torn down.
       * `shutdown` used to race `process.exit(0)` against continuations it never awaited — a
       * report on its way into the assignment book, a state write on its way to disk — and
       * exit(0) does not wait for the event loop.
       *
       * Deliberately NOT closing the control surface first: a worker's in-flight `crew_report`
       * is exactly the finished work that must not be dropped on the floor, and refusing it
       * with a 503 while we wait for the crew to go quiet would be the same silent loss in a
       * new place. The wait is bounded, and stopAll() below is what actually stops the work.
       */
      await quiesceOrchestrator();
      const sweep = await supervisor.stopAll();
      await bus.publish("crew.stopped", {
        summary: `crew daemon stopped (${sweep.cancelledRuns.length} run(s) cancelled)`,
        data: sweep,
      });
      await crewServer.stop();
      await removeDaemonSecrets(paths);
      await rm(paths.daemonFile, { force: true }).catch(() => {});
      await lock.release();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Keep the process alive for the server's lifetime.
  return new Promise<number>(() => {});
};

/**
 * Give the orchestration layer a bounded chance to finish its in-flight continuations before
 * the process exits. `settle()` is orchestrator.ts's own "await every background wake/pump" —
 * documented there as the thing shutdown may await. Optional: a foundation-only build has no
 * orchestrator at all, and a crew that refuses to go quiet must not block shutdown forever.
 */
async function quiesceOrchestrator(timeoutMs = 5_000): Promise<void> {
  try {
    const mod = (await import(ORCHESTRATOR_SPECIFIER)) as {
      currentRuntime?: () => { orchestrator?: { settle?: (rounds?: number) => Promise<unknown> } } | null;
    };
    const settled = mod.currentRuntime?.()?.orchestrator?.settle?.();
    if (!settled) return;
    const timer = new Promise<void>((r) => {
      setTimeout(r, timeoutMs).unref?.();
    });
    await Promise.race([settled.catch(() => {}), timer]);
  } catch {
    // No orchestration layer, or it refused to settle: shutdown proceeds either way.
  }
}

const stop: CrewCommand = async ({ paths }) => {
  const record = await readDaemonRecord(paths);
  if (!record) {
    console.log("crew daemon is not running (no daemon.json)");
    return 0;
  }
  if (!pidAlive(record.pid)) {
    console.log(`crew daemon pid ${record.pid} already gone — cleaning up stale daemon.json`);
    await removeDaemonSecrets(paths);
    await rm(paths.daemonFile, { force: true }).catch(() => {});
    await releaseStaleLock(paths);
    return 0;
  }

  process.kill(record.pid, "SIGTERM");
  for (let attempt = 0; attempt < 40 && pidAlive(record.pid); attempt++) await sleep(200);
  if (pidAlive(record.pid)) {
    console.error(`crew daemon pid ${record.pid} ignored SIGTERM — sending SIGKILL`);
    process.kill(record.pid, "SIGKILL");
    await sleep(300);
  }

  // The daemon led its own process group (spawned detached), so any straggler a runtime
  // left behind is still in group <pid>. Zero survivors is the contract (spec §30).
  let survivors = (await processGroupPids(record.pid)).filter((pid) => pid !== process.pid);
  if (survivors.length > 0) {
    console.error(`killing ${survivors.length} leftover crew process(es): ${survivors.join(", ")}`);
    for (const pid of survivors) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await sleep(300);
    survivors = (await processGroupPids(record.pid)).filter((pid) => pid !== process.pid);
  }
  await removeDaemonSecrets(paths);
  await rm(paths.daemonFile, { force: true }).catch(() => {});
  await releaseStaleLock(paths);
  if (survivors.length > 0) {
    console.error(`WARNING: ${survivors.length} process(es) survived SIGKILL: ${survivors.join(", ")}`);
    return 1;
  }
  console.log(`crew daemon stopped (pid ${record.pid}) — zero crew-owned processes remain`);
  return 0;
};

/**
 * A stopped daemon leaves no live secrets behind.
 *
 * `agent-token` used to survive `stop`: a 0600, secret-shaped file naming a credential nothing
 * would ever accept again — and, if an agent had planted a SYMLINK there, the thing the next
 * start would write through. The per-agent tokens and the UI key go the same way: they are
 * per-process by construction, so anything still on disk after `stop` is litter at best and a
 * planted link at worst.
 */
export async function removeDaemonSecrets(paths: CrewPaths): Promise<void> {
  for (const target of [join(paths.root, "agent-token"), join(paths.root, "ui-key")]) {
    await rm(target, { force: true }).catch(() => {});
  }
  await rm(join(paths.root, "agent-tokens"), { recursive: true, force: true }).catch(() => {});
}

/**
 * Drop the crew-home lock left by a daemon that is definitively gone (SIGKILL, panic).
 * A live holder is never touched — acquireCrewHomeLock reclaims stale locks by itself, so
 * this is tidiness, not the safety net.
 */
async function releaseStaleLock(paths: CrewPaths): Promise<void> {
  try {
    const holder = JSON.parse(await readFile(paths.lockFile, "utf8")) as { pid?: number };
    if (typeof holder.pid === "number" && pidAlive(holder.pid)) return;
  } catch {
    // no lock, or unreadable — removing it is still the right move
  }
  await rm(paths.lockFile, { force: true }).catch(() => {});
}

const status: CrewCommand = async ({ paths }) => {
  const record = await readDaemonRecord(paths);
  if (!record || !pidAlive(record.pid)) {
    console.log("crew: stopped");
    return record ? 1 : 0;
  }
  const health = (await fetchJson(`http://127.0.0.1:${record.port}/api/health`)) as {
    ok?: boolean;
    version?: string;
    activeRuns?: number;
  } | null;
  if (!health?.ok) {
    console.log(`crew: pid ${record.pid} is alive but not answering on port ${record.port}`);
    return 1;
  }
  const stateBody = (await fetchJson(`http://127.0.0.1:${record.port}/api/state`)) as {
    state?: { agents?: Record<string, unknown>; assignments?: Record<string, unknown>; workspace?: string };
  } | null;
  const agents = Object.keys(stateBody?.state?.agents ?? {}).length;
  const assignments = Object.keys(stateBody?.state?.assignments ?? {}).length;
  console.log(`crew: running (pid ${record.pid}, v${health.version}, since ${record.startedAt})`);
  console.log(`office: http://127.0.0.1:${record.port}/`);
  console.log(`workspace: ${stateBody?.state?.workspace ?? "?"} — ${agents} agent(s), ${assignments} assignment(s), ${health.activeRuns ?? 0} active run(s)`);
  return 0;
};

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

registry.register("doctor", "check runtimes, Docket Core, workspace and profiles", doctor);
registry.register("start", "start the crew daemon and Office server", start);
registry.register("stop", "stop the crew daemon, leaving zero crew-owned processes", stop);
registry.register("status", "show daemon status", status);
commands.set("__daemon", { description: "internal: run the daemon in the foreground", handler: daemonMain, hidden: true });

function usage(): void {
  console.log(`docket-crew ${CREW_VERSION}\n\nusage: docket-crew <command>\n`);
  for (const { name, description } of registry.list()) console.log(`  ${name.padEnd(10)} ${description}`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [name, ...args] = argv;
  if (name === "--version" || name === "-v") {
    console.log(CREW_VERSION);
    return 0;
  }

  // Orchestration layer adds ask/office/agents/profiles/agent. Loaded BEFORE the help path
  // so `docket-crew help` lists the real command set rather than the foundation's subset.
  try {
    const mod = (await import(ORCHESTRATOR_SPECIFIER)) as { registerCrewCommands?: (r: CommandRegistry) => void };
    mod.registerCrewCommands?.(registry);
  } catch (err) {
    if ((err as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw err;
  }

  if (!name || name === "help" || name === "--help" || name === "-h") {
    usage();
    return name ? 0 : 2;
  }

  const command = commands.get(name);
  if (!command) {
    console.error(`docket-crew: unknown command "${name}"\n`);
    usage();
    return 2;
  }
  return command.handler({ args, paths: crewPaths() });
}

// Run when invoked as a script (bin or `node dist/cli.js`), not when imported by tests.
// realpath both sides: an npm bin install invokes through a symlink.
function isDirectInvocation(): boolean {
  const invokedAs = process.argv[1];
  if (!invokedAs) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invokedAs);
  } catch {
    return false;
  }
}
if (isDirectInvocation()) {
  main().then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (err) => {
      // A user-facing error is one sentence; a real bug keeps its stack.
      const error = err as Error;
      const readable = error.name === "CrewUserError" || error.name === "CrewConfigError";
      console.error(`docket-crew: ${readable ? error.message : (error.stack ?? error.message)}`);
      process.exitCode = 1;
    },
  );
}
