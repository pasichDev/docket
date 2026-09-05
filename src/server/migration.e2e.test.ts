import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Moving a workspace between local and self-hosted, end to end, against a real `docket
 * serve` over real HTTP.
 *
 * The thing under test is not "does the data arrive" — the per-item loop this replaces did
 * that much. It is whether what arrives is still the same workspace: the same item
 * identities, the same projects, the same chronology, the same audit log. Every one of
 * those used to be dropped silently, and the only place the loss is observable is on the
 * far side of the wire.
 */
const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const clientDataDir = await mkdtemp(join(tmpdir(), "docket-migration-client-"));
process.env.DOCKET_DATA_DIR = clientDataDir;

const { getDeviceId, getDeviceName, getDevicePublicKey, deriveServerAuthSecret } = await import("../device.js");
const { pairingSas } = await import("../sync/peering.js");
const { RemoteTodoRepository } = await import("../remote/client.js");
const { LocalTodoRepository } = await import("../repository.js");
const { withStore, readStore } = await import("../storage.js");
const { transferWorkspace } = await import("../backend.js");
const { saveRemoteCredentials } = await import("../remote/credentials.js");

test.after(async () => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  await rm(clientDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface RunningServe {
  baseUrl: string;
  dataDir: string;
  child: ChildProcess;
}

async function spawnServe(dataDir: string): Promise<RunningServe> {
  const launcherPath = join(process.cwd(), "dist", "launcher.js");
  const child = spawn(process.execPath, [launcherPath, "serve"], {
    env: { ...process.env, DOCKET_DATA_DIR: dataDir, DOCKET_SERVER_HOST: "127.0.0.1", DOCKET_SERVER_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c) => (stdout += String(c)));
  child.stderr?.on("data", (c) => (stderr += String(c)));

  const baseUrl = await new Promise<string>((resolve, reject) => {
    const onExit = (code: number | null) => {
      clearTimeout(timeout);
      clearInterval(poll);
      reject(new Error(`docket serve exited early (${code}). stdout:\n${stdout}\nstderr:\n${stderr}`));
    };
    const timeout = setTimeout(() => {
      clearInterval(poll);
      child.off("exit", onExit);
      reject(new Error(`docket serve didn't start within 8s. stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 8000);
    const poll = setInterval(() => {
      const match = /API:\s+(http:\/\/[^/\s]+)\/api\/v1/.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        clearInterval(poll);
        child.off("exit", onExit);
        resolve(match[1]);
      }
    }, 20);
    child.once("exit", onExit);
  });
  return { baseUrl, dataDir, child };
}

async function stopServe(running: RunningServe): Promise<void> {
  if (running.child.exitCode !== null || running.child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    running.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    running.child.kill();
  });
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function adminFetch(dataDir: string, url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const token = (await readFile(join(dataDir, "admin-token"), "utf8")).trim();
  return fetchJson(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
}

async function pairThisDevice(server: RunningServe): Promise<{ deviceId: string; deviceName: string; secret: string }> {
  const info = await fetchJson(`${server.baseUrl}/api/v1/info`);
  const identity = info.body as { devicePublicKeyX: string };
  const deviceId = await getDeviceId();
  const deviceName = await getDeviceName();
  const ownPublicKeyX = await getDevicePublicKey();
  const secret = await deriveServerAuthSecret(identity.devicePublicKeyX);

  const codeRes = await adminFetch(server.dataDir, `${server.baseUrl}/api/v1/admin/devices/pairing-code`, { method: "POST" });
  assert.equal(codeRes.status, 200);
  const request = await fetchJson(`${server.baseUrl}/api/v1/pair/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: (codeRes.body as { code: string }).code, deviceId, deviceName, publicKeyX: ownPublicKeyX }),
  });
  assert.equal(request.status, 200);
  assert.equal((request.body as { sas: string }).sas, pairingSas(secret, ownPublicKeyX, identity.devicePublicKeyX));

  const pending = await adminFetch(server.dataDir, `${server.baseUrl}/api/v1/admin/devices/pending`);
  const found = (pending.body as { requests: Array<{ requestId: string; deviceId: string }> }).requests.find((r) => r.deviceId === deviceId);
  assert.ok(found, "expected a pending pairing request");
  const approve = await adminFetch(server.dataDir, `${server.baseUrl}/api/v1/admin/devices/pending/${found!.requestId}/approve`, { method: "POST" });
  assert.equal(approve.status, 200);
  return { deviceId, deviceName, secret };
}

test("a workspace moved to a self-hosted server is still the same workspace on the other side", async () => {
  const serverDataDir = await mkdtemp(join(tmpdir(), "docket-migration-server-"));
  let server: RunningServe | undefined;
  try {
    server = await spawnServe(serverDataDir);
    const { deviceId, deviceName, secret } = await pairThisDevice(server);
    const remote = new RemoteTodoRepository({ serverUrl: server.baseUrl, deviceId, deviceName, secret });

    // A workspace with the things that used to disappear: two projects, a completion, a
    // deletion, and an item with a history worth keeping.
    const local = new LocalTodoRepository();
    const ctx = { agent: "test", session: null, deviceId, deviceName };
    const a = await local.create({ title: "Ship the release" }, ctx);
    const b = await local.create({ title: "Write the changelog" }, ctx);
    const c = await local.create({ title: "Retire the old host" }, ctx);
    await local.edit(a.id, { description: "with the audit log intact" }, ctx);
    await local.complete(b.id, ctx);
    await local.delete(c.id, ctx);
    await withStore((store) => {
      for (const todo of store.todos) todo.workspace = todo.title.includes("changelog") ? "acme/docs" : "acme/backend";
    });

    const before = await readStore();
    const result = await transferWorkspace(local, remote);
    assert.equal(result.imported, before.todos.length, `expected ${before.todos.length} items on the server`);

    const after = await remote.list({ filter: "all", list: "all" });
    assert.equal(after.length, before.todos.length);

    const byUuid = new Map(after.map((t) => [t.uuid, t]));
    for (const original of before.todos) {
      const moved = byUuid.get(original.uuid);
      assert.ok(moved, `"${original.title}" arrived with a different uuid — to every paired device that is a delete plus an unrelated create`);
      assert.equal(moved.workspace, original.workspace, `"${original.title}" lost its project, which in v3 means it lands in Unfiled`);
      assert.equal(moved.createdAt, original.createdAt, `"${original.title}" was re-dated to today`);
      assert.equal(moved.done, original.done);
      assert.equal(moved.completedAt, original.completedAt);
      assert.equal(moved.revision, original.revision);
    }

    // The deletion travelled too, rather than the server quietly having one more item than
    // the source did.
    assert.ok(!after.some((t) => t.title === "Retire the old host"), "a deleted item was resurrected by the migration");

    const history = await remote.history(byUuid.get(before.todos[0].uuid)!.id);
    assert.ok(history.length >= 2, `the audit log did not travel: ${JSON.stringify(history)}`);

    // Repeating the whole migration must change nothing — the case a dropped connection puts
    // every user in.
    const repeat = await transferWorkspace(local, remote, result.migrationId);
    assert.equal(repeat.alreadyApplied, true, "the server did not recognise a migration it had already applied");
    assert.equal((await remote.list({ filter: "all", list: "all" })).length, after.length, "re-running the migration duplicated the workspace");
  } finally {
    if (server) await stopServe(server);
    await rm(serverDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a fresh transfer of an already-migrated workspace adds nothing, even under a new migration id", async () => {
  const serverDataDir = await mkdtemp(join(tmpdir(), "docket-migration-server-2-"));
  let server: RunningServe | undefined;
  try {
    server = await spawnServe(serverDataDir);
    const { deviceId, deviceName, secret } = await pairThisDevice(server);
    const remote = new RemoteTodoRepository({ serverUrl: server.baseUrl, deviceId, deviceName, secret });
    const local = new LocalTodoRepository();

    const first = await transferWorkspace(local, remote);
    // A different migration id is the "I lost the terminal and started over" case: the
    // migration-id short circuit does not apply, so idempotence has to hold by uuid too.
    const second = await transferWorkspace(local, remote);
    assert.equal(second.alreadyApplied, false, "premise broken: this was supposed to be a genuinely new migration");
    assert.equal(second.imported, 0, "a second transfer copied the workspace again");
    assert.equal(second.alreadyPresent, first.imported);
  } finally {
    if (server) await stopServe(server);
    await rm(serverDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/* ==========================================================================================
 * B14 — in remote mode, the CLI must read and write the server, never a stale local file
 * ========================================================================================== */

async function runCli(dataDir: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  const launcherPath = join(process.cwd(), "dist", "launcher.js");
  const child = spawn(process.execPath, [launcherPath, ...args], {
    env: { ...process.env, DOCKET_DATA_DIR: dataDir, DOCKET_WEB_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (c) => (out += String(c)));
  child.stderr?.on("data", (c) => (err += String(c)));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, out, err: `${err}\n(timed out)` });
    }, 15_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

test("in remote mode the CLI reads the server's workspace and creates no local store", async () => {
  const serverDataDir = await mkdtemp(join(tmpdir(), "docket-cli-remote-server-"));
  // A data directory that has never held a store, so "no local store was created" is a
  // statement about this test and not about leftovers.
  const cliDataDir = await mkdtemp(join(tmpdir(), "docket-cli-remote-client-"));
  let server: RunningServe | undefined;
  try {
    server = await spawnServe(serverDataDir);

    // Seed the server with something only it has, through its own API.
    const { deviceId, deviceName, secret } = await pairThisDevice(server);
    const remote = new RemoteTodoRepository({ serverUrl: server.baseUrl, deviceId, deviceName, secret });
    await remote.create({ title: "Only on the server" }, { agent: "test", session: null, deviceId, deviceName });

    // Persist the pairing the way `docket pair` does, then hand the CLI child the same
    // identity and key — it has to look, to the server, like this already-approved device.
    const info = (await fetchJson(`${server.baseUrl}/api/v1/info`)).body as { deviceId: string };
    await saveRemoteCredentials({ serverUrl: server.baseUrl, serverDeviceId: info.deviceId, secret, pairedAt: new Date().toISOString() });
    const { writeFile } = await import("node:fs/promises");
    for (const name of ["device.json", "key", "remote-server.json.enc"]) {
      await writeFile(join(cliDataDir, name), await readFile(join(clientDataDir, name)));
    }

    const env = { DOCKET_MODE: "remote", DOCKET_SERVER_URL: server.baseUrl, DOCKET_ALLOW_INSECURE_REMOTE: "1" };
    const listed = await runCli(cliDataDir, ["list", "--all"], env);
    assert.equal(listed.code, 0, `docket list failed in remote mode: ${listed.err}`);
    assert.match(listed.out, /Only on the server/, `the CLI read a local store instead of the server:\n${listed.out}`);

    const entries = await readdir(cliDataDir);
    assert.ok(
      !entries.includes("todos.json.enc"),
      `remote mode created a local store — this is the split brain the user can see: ${entries.join(", ")}`,
    );
  } finally {
    if (server) await stopServe(server);
    await rm(serverDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(cliDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
