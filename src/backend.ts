import { assertSecureRemoteUrl, writeDeploymentConfig } from "./config.js";
import { createLineReader, type LineReader } from "./cli-prompt.js";
import { getDataDirectory } from "./data-dir.js";
import { getDeviceId, getDeviceName } from "./device.js";
import { beginServerPairing, finishServerPairing, PairingError } from "./remote/enrolment.js";
import { loadRemoteCredentials } from "./remote/credentials.js";
import { RemoteProtocolError, RemoteTodoRepository, RemoteUnavailableError } from "./remote/client.js";
import { LocalTodoRepository, type SnapshotImportResult, type TodoRepository } from "./repository.js";
import { readStore, replaceStoreSnapshot } from "./storage.js";
import type { Todo } from "./types.js";

/**
 * `docket backend use <url>` / `docket backend localize` — RFC "Local and Self-Hosted
 * Backend Modes" §28/§29 (Implementation Phase 6). Deliberately narrow: the only automatic
 * path is empty-destination + source-has-data → copy (RFC §28's one explicitly allowed
 * automatic case); anything else stops and asks, and two-sided data ("both sides contain
 * data") is refused outright rather than guessing at a merge — the RFC is explicit that
 * inventing automatic reconciliation is out of scope for v1.
 */

function insecureRemoteAllowed(): boolean {
  return process.env.DOCKET_ALLOW_INSECURE_REMOTE === "1" || process.env.DOCKET_ALLOW_INSECURE_REMOTE === "true";
}

/**
 * Moves a whole workspace from `source` to `target`, as one snapshot.
 *
 * This replaces a per-item loop of create()/complete() calls that was described, honestly
 * enough, as "faithful in user-visible content but not a byte-identical replica". What it
 * actually produced on the far side was a set of NEW items — new uuids, so every paired
 * device saw the whole workspace vanish and a different one appear; today's timestamps, so
 * the chronology went; no history; and, once v3 made project structure the centre of the
 * product, no workspace either, so everything landed in Unfiled. None of that was reported.
 *
 * It also could not be retried. Halfway through, a dropped connection left both sides
 * populated, and the next attempt refused to continue and told the user to repair it by
 * hand. A snapshot carries a migration id, so the destination can recognise a repeat and
 * report what already landed instead of copying it twice — which makes "run it again" the
 * correct advice at every point of failure.
 */
export async function transferWorkspace(
  source: TodoRepository,
  target: TodoRepository,
  migrationId?: string,
): Promise<SnapshotImportResult> {
  const snapshot = await source.exportSnapshot(migrationId);
  return target.importSnapshot(snapshot);
}

async function askChoice(reader: LineReader, question: string, options: string[]): Promise<number> {
  console.log(question);
  options.forEach((option, index) => console.log(`  ${index + 1}) ${option}`));
  const answer = (await reader.next("> ")).trim();
  const n = Number(answer);
  return Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : options.length - 1; // unrecognized input falls through to the last option (always "Cancel" in both flows below), never silently proceeds
}

function localSummary(todos: Todo[]): string {
  const completed = todos.filter((t) => t.done).length;
  const historyEntries = todos.reduce((n, t) => n + (t.history?.length ?? 0), 0);
  return `  ${todos.length} todos\n  ${completed} completed\n  ${historyEntries} history entries`;
}

async function pairInline(reader: LineReader, serverUrl: string, allowInsecureRemote: boolean): Promise<string | null> {
  console.log(`This device isn't paired with ${serverUrl} yet — pairing now.`);
  const code = (await reader.next("Pairing code (from `docket devices pair` on the server): ")).trim();
  if (!code) {
    console.error("Error: a pairing code is required.");
    process.exitCode = 1;
    return null;
  }
  let step: Awaited<ReturnType<typeof beginServerPairing>>;
  try {
    step = await beginServerPairing(serverUrl, code, allowInsecureRemote);
  } catch (err) {
    console.error(`Error: ${err instanceof PairingError ? err.message : (err as Error).message}`);
    process.exitCode = 1;
    return null;
  }
  console.log("✓ Server reachable");
  console.log(`✓ docket server v${step.probe.serverVersion}`);
  console.log("✓ Protocol compatible");
  console.log(`Confirmation code: ${step.sas} — verify this matches on the server before approving.`);
  console.log("Waiting for approval...");
  const result = await finishServerPairing(serverUrl, step);
  if (result.outcome !== "approved") {
    console.error(result.outcome === "denied" ? "Pairing was denied on the server." : "Timed out waiting for approval — the pairing code may have expired.");
    process.exitCode = 1;
    return null;
  }
  const creds = await loadRemoteCredentials();
  if (!creds) {
    console.error("Internal error: pairing reported success but no credentials were saved.");
    process.exitCode = 1;
    return null;
  }
  console.log("✓ Device paired\n");
  return creds.secret;
}

async function runBackendUse(args: string[]): Promise<void> {
  const serverUrl = args[0];
  if (!serverUrl) {
    console.error("Usage: docket backend use <serverUrl>");
    process.exitCode = 1;
    return;
  }
  const allowInsecureRemote = insecureRemoteAllowed();
  try {
    assertSecureRemoteUrl(serverUrl, allowInsecureRemote);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  let creds = await loadRemoteCredentials();
  const reader = createLineReader();
  try {
    if (!creds || creds.serverUrl !== serverUrl) {
      const secret = await pairInline(reader, serverUrl, allowInsecureRemote);
      if (!secret) return;
      creds = await loadRemoteCredentials();
      if (!creds) {
        console.error("Internal error: pairing reported success but credentials could not be reloaded.");
        process.exitCode = 1;
        return;
      }
    }

    const deviceId = await getDeviceId();
    const deviceName = await getDeviceName();
    const remoteRepo = new RemoteTodoRepository({ serverUrl, deviceId, deviceName, secret: creds.secret });

    let remoteTodos: Todo[];
    try {
      remoteTodos = await remoteRepo.list({ filter: "all", list: "all" });
    } catch (err) {
      console.error(err instanceof RemoteUnavailableError || err instanceof RemoteProtocolError ? err.message : (err as Error).message);
      process.exitCode = 1;
      return;
    }

    const localStore = await readStore();
    const localTodos = localStore.todos;

    if (localTodos.length === 0) {
      await writeDeploymentConfig({ mode: "remote", serverUrl });
      console.log(`Deployment mode set to remote (${serverUrl}). No local todos to migrate.`);
      return;
    }

    console.log("\nLocal workspace detected:");
    console.log(localSummary(localTodos));
    console.log("\nRemote workspace:");
    console.log(remoteTodos.length === 0 ? "  empty" : `  ${remoteTodos.length} todos`);
    console.log("");

    const choice = await askChoice(reader, "What do you want to do?", [
      "Upload local workspace to server",
      "Use server and keep local workspace untouched",
      "Cancel",
    ]);

    if (choice === 2) {
      console.log("Cancelled. No changes made.");
      return;
    }

    if (choice === 0) {
      if (remoteTodos.length > 0) {
        console.error(
          "Migration requires explicit import/merge — the remote workspace already has data. " +
            "Refusing to upload and auto-merge. Choose \"Use server and keep local workspace untouched\" instead, " +
            "or clear one side first.",
        );
        process.exitCode = 1;
        return;
      }
      let result: SnapshotImportResult;
      try {
        result = await transferWorkspace(new LocalTodoRepository(), remoteRepo);
      } catch (err) {
        // Nothing has been committed at this point except whatever the server accepted, and
        // the server records the migration id — so the honest instruction is to run the same
        // command again, not to repair anything by hand.
        console.error(`Migration failed: ${(err as Error).message}`);
        console.error("Nothing was switched over. Run `docket backend use` again — the transfer resumes rather than duplicating what already arrived.");
        process.exitCode = 1;
        return;
      }
      console.log(
        `Uploaded ${result.imported} todo(s) to ${serverUrl}` +
          `${result.alreadyPresent > 0 ? ` (${result.alreadyPresent} were already there)` : ""}` +
          `${result.tombstones > 0 ? `, plus ${result.tombstones} deletion(s)` : ""}.`,
      );
      console.log("Project structure, history, timestamps and item identities were carried over unchanged.");
    }

    // Only now: the mode switch is the last thing, so a failed transfer never leaves this
    // device pointed at a server that does not have its data.
    await stopLocalDaemon();
    await writeDeploymentConfig({ mode: "remote", serverUrl });
    console.log(`Deployment mode set to remote (${serverUrl}).`);
    if (choice === 1) console.log(`Local workspace left untouched at ${await getDataDirectory()}.`);
  } finally {
    reader.close();
  }
}

async function runBackendLocalize(): Promise<void> {
  const creds = await loadRemoteCredentials();
  if (!creds) {
    console.error("Error: this device has no remote server credentials — nothing to localize from. Run `docket pair <serverUrl>` first.");
    process.exitCode = 1;
    return;
  }

  const reader = createLineReader();
  try {
    const proceed = await reader.askYesNo(`Download current remote workspace from ${creds.serverUrl}?`, false);
    if (!proceed) {
      console.log("Cancelled.");
      return;
    }

    const deviceId = await getDeviceId();
    const deviceName = await getDeviceName();
    const remoteRepo = new RemoteTodoRepository({ serverUrl: creds.serverUrl, deviceId, deviceName, secret: creds.secret });

    let remoteTodos: Todo[];
    try {
      remoteTodos = await remoteRepo.list({ filter: "all", list: "all" });
    } catch (err) {
      console.error(err instanceof RemoteUnavailableError || err instanceof RemoteProtocolError ? err.message : (err as Error).message);
      process.exitCode = 1;
      return;
    }

    const localStore = await readStore();
    let replace = localStore.todos.length === 0;
    if (localStore.todos.length > 0) {
      console.log(`Warning: the local store at ${await getDataDirectory()} already has ${localStore.todos.length} local todo(s).`);
      replace = await reader.askYesNo(
        "Overwrite them with the downloaded snapshot? The current local store is renamed aside as a .bak file, not deleted.",
        false,
      );
      if (!replace) {
        console.log("Cancelled.");
        return;
      }
    }

    let snapshot;
    try {
      snapshot = await remoteRepo.exportSnapshot();
    } catch (err) {
      console.error(`Download failed: ${(err as Error).message}`);
      console.error("Nothing was changed locally. Run `docket backend localize` again when the server is reachable.");
      process.exitCode = 1;
      return;
    }

    // One function owns every piece of state a bulk replacement invalidates — the history
    // sidecar, the store epoch, and this device's cursors into its peers. Doing it here,
    // inline, is how the previous version left a paired device permanently deaf.
    const result = await replaceStoreSnapshot(snapshot);

    // Remote credentials are deliberately NOT cleared (RFC §29: "Remote credentials remain
    // stored but inactive so reconnecting later is possible") — only deployment.mode flips.
    await writeDeploymentConfig({ mode: "local" });
    console.log(
      `Downloaded ${result.imported} todo(s)${result.tombstones > 0 ? ` and ${result.tombstones} deletion(s)` : ""} from ${creds.serverUrl} into the local store.`,
    );
    console.log("Paired devices will re-sync this workspace from scratch — their cursors into the replaced store no longer mean anything.");
    console.log(`Deployment mode set to local. Reconnect any time with: docket backend use ${creds.serverUrl}`);
  } finally {
    reader.close();
  }
}

function printHelp(): void {
  console.log(`
docket backend - migrate this device's workspace between local and remote (RFC §28/§29)

Usage:
  docket backend use <serverUrl>   Switch this device to a self-hosted server, migrating
                                    local data to it if the server is currently empty
  docket backend localize          Download the current remote server's workspace into
                                    this device's local store and switch back to local mode
`);
}

export async function runBackendCommand(args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase();
  if (sub === "use") return runBackendUse(args.slice(1));
  if (sub === "localize") return runBackendLocalize();
  printHelp();
}

/**
 * Stops the detached local web/P2P process before this device switches to remote mode.
 *
 * The dashboard is spawned detached and unref'd by every MCP session (see
 * ensureWebUiRunning in index.ts) and runs a sync tick on a timer. Switching the MCP side to
 * remote does nothing to it: it keeps serving, keeps pulling from paired peers, and keeps
 * writing to a local store that is no longer the source of truth — so work typed into that
 * dashboard, or arriving from a peer, lands somewhere the user can no longer see.
 *
 * Best-effort by nature — there is no supervisor here, only a port and a pid — so it reports
 * what it could not do rather than pretending. What it must never do is claim success it
 * cannot verify.
 */
export async function stopLocalDaemon(): Promise<void> {
  const port = Number(process.env.DOCKET_WEB_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;

  let pid: number | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return;
    const body = (await res.json()) as { pid?: unknown };
    pid = typeof body.pid === "number" ? body.pid : null;
  } catch {
    return; // nothing running, which is the state we want
  }
  if (pid === null) {
    console.warn(`Warning: a docket dashboard is running on 127.0.0.1:${port} but did not report its pid — stop it manually before using this device in remote mode.`);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.warn(`Warning: could not stop the local dashboard (pid ${pid}): ${(err as Error).message}. Stop it manually — it is still syncing with paired devices into the local store.`);
    return;
  }

  // Verify, rather than assume. A daemon that ignored SIGTERM is exactly the case this
  // exists for, and reporting "stopped" for a process that is still running would be worse
  // than not trying.
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      process.kill(pid, 0);
    } catch {
      console.log("Stopped the local dashboard and its peer-sync loop.");
      return;
    }
  }
  console.warn(`Warning: the local dashboard (pid ${pid}) did not exit. Stop it manually — until then it keeps syncing paired devices into the local store this device no longer reads.`);
}
