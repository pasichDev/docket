import { rename } from "node:fs/promises";
import { assertSecureRemoteUrl, writeDeploymentConfig } from "./config.js";
import { createLineReader, type LineReader } from "./cli-prompt.js";
import { dataPath, getDataDirectory } from "./data-dir.js";
import { getDeviceId, getDeviceName } from "./device.js";
import { beginServerPairing, finishServerPairing, PairingError } from "./remote/enrolment.js";
import { loadRemoteCredentials } from "./remote/credentials.js";
import { RemoteProtocolError, RemoteTodoRepository, RemoteUnavailableError } from "./remote/client.js";
import { LocalTodoRepository, type MutationContext, type TodoRepository } from "./repository.js";
import { readStore } from "./storage.js";
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

async function migrationContext(): Promise<MutationContext> {
  return { agent: "docket-migration", session: null, deviceId: await getDeviceId(), deviceName: await getDeviceName() };
}

/**
 * Re-creates every item from `source` in `target` via the ordinary TodoRepository
 * create()/complete() calls — the SAME mutation rules every other caller goes through
 * (RFC §8), not a raw store copy. This intentionally does NOT preserve uuid, history,
 * original timestamps, or claim state: a migrated item is a fresh item on the
 * destination side, faithful in user-visible content (title/description/category/
 * priority/dueDate/sourceUrl/list/done) but not a byte-identical replica. Good enough for
 * "move my workspace to a new home"; explicitly not a backup/restore substitute (see
 * `docket backup`/`restore` for that).
 */
export async function copyTodos(source: TodoRepository, target: TodoRepository, context: MutationContext): Promise<number> {
  const todos = await source.list({ filter: "all", list: "all" });
  for (const todo of todos) {
    const created = await target.create(
      {
        title: todo.title,
        description: todo.description,
        list: todo.list,
        category: todo.category,
        priority: todo.priority,
        dueDate: todo.dueDate,
        sourceUrl: todo.sourceUrl,
      },
      context,
    );
    if (todo.done) await target.complete(created.id, context);
  }
  return todos.length;
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
      const uploaded = await copyTodos(new LocalTodoRepository(), remoteRepo, await migrationContext());
      console.log(`Uploaded ${uploaded} todo(s) to ${serverUrl}.`);
    }

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
    if (localStore.todos.length > 0) {
      console.log(`Warning: the local store at ${await getDataDirectory()} already has ${localStore.todos.length} local todo(s).`);
      const overwrite = await reader.askYesNo(
        "Overwrite them with the downloaded snapshot? The current local store is renamed aside as a .bak file, not deleted.",
        false,
      );
      if (!overwrite) {
        console.log("Cancelled.");
        return;
      }
      const storePath = await dataPath("todos.json.enc");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      try {
        await rename(storePath, `${storePath}.pre-localize-${stamp}.bak`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    const downloaded = await copyTodos(remoteRepo, new LocalTodoRepository(), await migrationContext());
    // Remote credentials are deliberately NOT cleared (RFC §29: "Remote credentials remain
    // stored but inactive so reconnecting later is possible") — only deployment.mode flips.
    await writeDeploymentConfig({ mode: "local" });
    console.log(`Downloaded ${downloaded} todo(s) from ${creds.serverUrl} into the local store.`);
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
