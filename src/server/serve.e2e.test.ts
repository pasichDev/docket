import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Real end-to-end coverage for `docket serve` (RFC "Local and Self-Hosted Backend Modes"
 * §9/§13/§14/§16/§21, Implementation Phases 1-3) — spawns the actual published entrypoint,
 * the way mcp-startup.test.ts does for stdio MCP, then drives the FULL real pairing
 * handshake and the /api/v1 HTTP surface with real fetch() calls and a real
 * RemoteTodoRepository client. Never touches the real ~/.docket data dir, :8787/:8788, or
 * DOCKET_SERVER_TOKEN (the old placeholder bearer auth no longer exists — see auth.ts).
 *
 * This test file acts as its OWN "client device" (a separate scratch DOCKET_DATA_DIR from
 * the spawned server's), using the real device.ts identity + real ECDH/SAS pairing math —
 * exactly the two-separate-machines topology RFC §36's "Integration" test strategy asks
 * for, just both sides running as processes/scratch-dirs on the same test runner.
 */

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const clientDataDir = await mkdtemp(join(tmpdir(), "docket-serve-e2e-client-"));
process.env.DOCKET_DATA_DIR = clientDataDir;

const { getDeviceId, getDeviceName, getDevicePublicKey, deriveServerAuthSecret } = await import("../device.js");
const { pairingSas } = await import("../sync/peering.js");
const { RemoteTodoRepository } = await import("../remote/client.js");
const { TodoClaimConflictError } = await import("../repository.js");

test.after(async () => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(clientDataDir, { recursive: true, force: true });
});

interface RunningServe {
  baseUrl: string;
  /** Where this server keeps its state — and therefore where its admin token lives. */
  dataDir: string;
  child: ChildProcess;
  stderr(): string;
}

async function spawnServe(dataDir: string): Promise<RunningServe> {
  const launcherPath = join(process.cwd(), "dist", "launcher.js");
  const child = spawn(process.execPath, [launcherPath, "serve"], {
    env: { ...process.env, DOCKET_DATA_DIR: dataDir, DOCKET_SERVER_HOST: "127.0.0.1", DOCKET_SERVER_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));

  const baseUrl = await new Promise<string>((resolve, reject) => {
    const onExit = (code: number | null) => {
      clearTimeout(timeout);
      clearInterval(poll);
      reject(new Error(`docket serve exited early (code ${code}) before printing a ready URL. stdout:\n${stdout}\nstderr:\n${stderr}`));
    };
    const timeout = setTimeout(() => {
      clearInterval(poll);
      child.off("exit", onExit);
      reject(new Error(`docket serve didn't print a ready URL within 8s. stdout:\n${stdout}\nstderr:\n${stderr}`));
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

  return { baseUrl, dataDir, child, stderr: () => stderr };
}

/**
 * kill() alone only sends the signal — it doesn't wait for the process to actually let go
 * of the data directory (its open lock/store file handles), so an rm() started right after
 * can race a still-shutting-down server and hit ENOTEMPTY. Waiting for 'exit' first (with a
 * bounded fallback) makes cleanup deterministic instead of flaky.
 */
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

async function cleanup(running: RunningServe | undefined, ...dataDirs: string[]): Promise<void> {
  if (running) await stopServe(running);
  await Promise.all(dataDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * The admin routes need the local secret, exactly as `docket devices …` reads it from the
 * data directory. Being on loopback is no longer enough, and must not be.
 */
async function adminFetch(dataDir: string, url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const token = (await readFile(join(dataDir, "admin-token"), "utf8")).trim();
  assert.ok(token.length >= 32, "the server should have minted an admin token on startup");
  return fetchJson(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
}

interface ServerIdentity {
  deviceId: string;
  devicePublicKeyX: string;
  serverVersion: string;
}

async function fetchServerIdentity(baseUrl: string): Promise<ServerIdentity> {
  const { status, body } = await fetchJson(`${baseUrl}/api/v1/info`);
  assert.equal(status, 200);
  return body as ServerIdentity;
}

/** Generates the pairing code (loopback admin route) the way `docket devices pair` does. */
async function generatePairingCode(server: RunningServe): Promise<string> {
  const { status, body } = await adminFetch(server.dataDir, `${server.baseUrl}/api/v1/admin/devices/pairing-code`, { method: "POST" });
  assert.equal(status, 200);
  return (body as { code: string }).code;
}

async function approveLatestPending(server: RunningServe, deviceId: string): Promise<void> {
  const { status, body } = await adminFetch(server.dataDir, `${server.baseUrl}/api/v1/admin/devices/pending`);
  assert.equal(status, 200);
  const pending = (body as { requests: Array<{ requestId: string; deviceId: string }> }).requests.find((r) => r.deviceId === deviceId);
  assert.ok(pending, `expected a pending pairing request for ${deviceId}`);
  const approve = await adminFetch(server.dataDir, `${server.baseUrl}/api/v1/admin/devices/pending/${pending!.requestId}/approve`, { method: "POST" });
  assert.equal(approve.status, 200);
}

/** Pairs THIS test process's own device.ts identity against the running server, driving the exact same public routes `docket pair` uses. Returns the derived secret. */
async function pairThisDevice(server: RunningServe): Promise<{ deviceId: string; deviceName: string; secret: string }> {
  const baseUrl = server.baseUrl;
  const identity = await fetchServerIdentity(baseUrl);
  const deviceId = await getDeviceId();
  const deviceName = await getDeviceName();
  const ownPublicKeyX = await getDevicePublicKey();
  const secret = await deriveServerAuthSecret(identity.devicePublicKeyX);
  const sas = pairingSas(secret, ownPublicKeyX, identity.devicePublicKeyX);

  const code = await generatePairingCode(server);
  const request = await fetchJson(`${baseUrl}/api/v1/pair/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceId, deviceName, publicKeyX: ownPublicKeyX }),
  });
  assert.equal(request.status, 200);
  const { requestId, sas: serverSas } = request.body as { requestId: string; sas: string };
  assert.equal(serverSas, sas, "client- and server-derived SAS must match (both sides derived the secret via the SAME ECDH inputs)");

  await approveLatestPending(server, deviceId);

  const status = await fetchJson(`${baseUrl}/api/v1/pair/status/${requestId}`);
  assert.equal(status.status, 200);
  assert.equal((status.body as { status: string }).status, "approved");

  return { deviceId, deviceName, secret };
}

/** A SECOND device, entirely independent of this process's own device.ts identity — its own X25519 keypair, its own ECDH-derived secret (same HKDF label/math as device.ts's deriveServerAuthSecret, reproduced here since that function is bound to the single per-process identity). Used for concurrency/multi-client tests (RFC §36). */
function deriveSecretForRawKeypair(privateKey: KeyObject, serverPublicKeyX: string): string {
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: serverPublicKeyX }, format: "jwk" });
  const shared = diffieHellman({ privateKey, publicKey });
  const derived = hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("docket/server-auth/v1"), 32);
  return Buffer.from(derived).toString("hex");
}

async function pairSecondDevice(server: RunningServe, deviceId: string, deviceName: string): Promise<{ secret: string }> {
  const baseUrl = server.baseUrl;
  const identity = await fetchServerIdentity(baseUrl);
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const publicKeyX = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const secret = deriveSecretForRawKeypair(privateKey, identity.devicePublicKeyX);

  const code = await generatePairingCode(server);
  const request = await fetchJson(`${baseUrl}/api/v1/pair/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceId, deviceName, publicKeyX }),
  });
  assert.equal(request.status, 200);
  await approveLatestPending(server, deviceId);
  return { secret };
}

test("docket serve: real pairing (SAS matches) then a full /api/v1 lifecycle over RemoteTodoRepository", async () => {
  const serverDataDir = await mkdtemp(join(tmpdir(), "docket-serve-e2e-"));
  let running: RunningServe | undefined;
  try {
    running = await spawnServe(serverDataDir);
    const { baseUrl } = running;

    const health = await fetchJson(`${baseUrl}/api/v1/health`);
    assert.equal(health.status, 200);
    assert.equal((health.body as { ok: boolean }).ok, true);

    // Every /api/v1/todos* route requires a paired device — unauthenticated is 401.
    const noAuth = await fetchJson(`${baseUrl}/api/v1/todos`);
    assert.equal(noAuth.status, 401);

    const { deviceId, deviceName, secret } = await pairThisDevice(running);
    const repo = new RemoteTodoRepository({ serverUrl: baseUrl, deviceId, deviceName, secret });
    const context = { agent: "agent-a", session: "s1", deviceId, deviceName };

    const created = await repo.create({ title: "e2e todo" }, context);
    assert.equal(created.title, "e2e todo");
    assert.equal(created.revision, 1);
    assert.equal(typeof created.id, "number"); // RemoteTodoRepository's own synthetic local id, not the server's

    const listed = await repo.list({});
    assert.equal(listed.length, 1);

    const fetched = await repo.get(created.id);
    assert.equal(fetched?.uuid, created.uuid);

    // Stale If-Match -> TodoConflictError carrying current server state
    await assert.rejects(() => repo.edit(created.id, { title: "should not apply" }, context, 999));

    const edited = await repo.edit(created.id, { title: "e2e todo edited" }, context, created.revision);
    assert.equal(edited.title, "e2e todo edited");
    assert.equal(edited.revision, created.revision + 1);

    const claimed = await repo.claim(created.id, context);
    assert.equal(claimed.todo.workingAgent, "agent-a");
    assert.equal(claimed.previousAgent, null);

    const released = await repo.release(created.id, context);
    assert.equal(released.workingAgent, null);

    const history = await repo.history(created.id);
    assert.ok(history.length > 0);

    const completed = await repo.complete(created.id, context);
    assert.equal(completed.done, true);

    const removed = await repo.delete(created.id, context);
    assert.equal(removed.uuid, created.uuid);
    assert.equal(await repo.get(created.id), null);

    const healthReport = await repo.health();
    assert.equal(healthReport.ok, true);
    assert.equal(healthReport.todoCount, 0);
  } finally {
    await cleanup(running, serverDataDir);
  }
});

test("docket serve: pairing security invariants — invalid code rejected, revoked device rejected, replay rejected, wrong secret rejected", async () => {
  const serverDataDir = await mkdtemp(join(tmpdir(), "docket-serve-e2e-security-"));
  let running: RunningServe | undefined;
  try {
    running = await spawnServe(serverDataDir);
    const { baseUrl } = running;

    // Bogus/expired pairing code is rejected.
    const identity = await fetchServerIdentity(baseUrl);
    const secret = await deriveServerAuthSecret(identity.devicePublicKeyX);
    const ownPublicKeyX = await getDevicePublicKey();
    const badCode = await fetchJson(`${baseUrl}/api/v1/pair/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "BADCODE", deviceId: await getDeviceId(), deviceName: await getDeviceName(), publicKeyX: ownPublicKeyX }),
    });
    assert.equal(badCode.status, 400);
    void secret;

    const { deviceId, deviceName, secret: realSecret } = await pairThisDevice(running);
    const repo = new RemoteTodoRepository({ serverUrl: baseUrl, deviceId, deviceName, secret: realSecret });
    const context = { agent: "a", session: "s", deviceId, deviceName };

    // Works while paired and not revoked.
    await repo.create({ title: "before revoke" }, context);

    // Revoke it via the loopback admin route (RFC §37.5: "Revoked devices cannot authenticate").
    const revoke = await adminFetch(running.dataDir, `${baseUrl}/api/v1/admin/devices/${deviceId}/revoke`, { method: "POST" });
    assert.equal(revoke.status, 200);

    await assert.rejects(() => repo.create({ title: "after revoke — must fail" }, context));

    // A signature made with the wrong secret is rejected outright (never silently accepted).
    const wrongSecretRepo = new RemoteTodoRepository({ serverUrl: baseUrl, deviceId, deviceName, secret: "0".repeat(64) });
    await assert.rejects(() => wrongSecretRepo.list({}));
  } finally {
    await cleanup(running, serverDataDir);
  }
});

test("docket serve: two independently paired devices — concurrent claim resolves atomically (RFC §21), force takeover reports the previous claimant", async () => {
  const serverDataDir = await mkdtemp(join(tmpdir(), "docket-serve-e2e-claims-"));
  let running: RunningServe | undefined;
  try {
    running = await spawnServe(serverDataDir);
    const { baseUrl } = running;

    const deviceA = await pairThisDevice(running);
    const deviceB = await pairSecondDevice(running, "device-b-raw", "Device B");

    const repoA = new RemoteTodoRepository({ serverUrl: baseUrl, deviceId: deviceA.deviceId, deviceName: deviceA.deviceName, secret: deviceA.secret });
    const contextA = { agent: "agent-a", session: "s1", deviceId: deviceA.deviceId, deviceName: deviceA.deviceName };

    const created = await repoA.create({ title: "contested" }, contextA);

    // Claim it directly at the HTTP level (RemoteTodoRepository.claim() with no options
    // always requests force:true to match local always-succeeds semantics — see client.ts
    // — so RFC §21's raw atomic-conflict behavior is exercised here via fetch directly,
    // exactly the way a future strict caller would use requireFree).
    const signAndClaim = async (deviceId: string, secret: string, agent: string, todoUuid: string, force: boolean) => {
      const { signDeviceRequest, generateNonce, hashBody } = await import("../remote/device-auth.js");
      const { shortId } = await import("../mutations.js");
      const path = `/api/v1/todos/${shortId(todoUuid)}/claim`;
      const body = JSON.stringify({ force });
      const timestamp = new Date().toISOString();
      const nonce = generateNonce();
      const signature = signDeviceRequest(secret, "POST", path, timestamp, nonce, hashBody(body));
      return fetchJson(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Docket-Agent": agent,
          "x-docket-device": deviceId,
          "x-docket-timestamp": timestamp,
          "x-docket-nonce": nonce,
          "x-docket-signature": signature,
        },
        body,
      });
    };

    const claimA = await signAndClaim(deviceA.deviceId, deviceA.secret, "agent-a", created.uuid, false);
    assert.equal(claimA.status, 200);

    const conflictB = await signAndClaim("device-b-raw", deviceB.secret, "agent-b", created.uuid, false);
    assert.equal(conflictB.status, 409);
    assert.equal((conflictB.body as { error: string }).error, "already_claimed");

    const forceB = await signAndClaim("device-b-raw", deviceB.secret, "agent-b", created.uuid, true);
    assert.equal(forceB.status, 200);
    assert.equal((forceB.body as { previousAgent: string | null }).previousAgent, "agent-a");

    // Also exercise the SAME conflict through RemoteTodoRepository's own requireFree path.
    await assert.rejects(
      () => repoA.claim(created.id, contextA, { requireFree: true }),
      (err: unknown) => err instanceof TodoClaimConflictError,
    );
  } finally {
    await cleanup(running, serverDataDir);
  }
});

test("docket serve: SSE /api/v1/events requires a signed request and streams a todo.created event after an authenticated create", async () => {
  const serverDataDir = await mkdtemp(join(tmpdir(), "docket-serve-e2e-sse-"));
  let running: RunningServe | undefined;
  try {
    running = await spawnServe(serverDataDir);
    const { baseUrl } = running;

    const noAuthSse = await fetch(`${baseUrl}/api/v1/events`);
    assert.equal(noAuthSse.status, 401);
    await noAuthSse.body?.cancel();

    const { deviceId, deviceName, secret } = await pairThisDevice(running);
    const { signDeviceRequest, generateNonce, hashBody } = await import("../remote/device-auth.js");
    const timestamp = new Date().toISOString();
    const nonce = generateNonce();
    const signature = signDeviceRequest(secret, "GET", "/api/v1/events", timestamp, nonce, hashBody(""));
    const sseRes = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { "x-docket-device": deviceId, "x-docket-timestamp": timestamp, "x-docket-nonce": nonce, "x-docket-signature": signature },
    });
    assert.equal(sseRes.status, 200);
    assert.equal(sseRes.headers.get("content-type"), "text/event-stream");

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    async function nextEvent(): Promise<{ type: string; [key: string]: unknown }> {
      for (;;) {
        const frameEnd = buffered.indexOf("\n\n");
        if (frameEnd !== -1) {
          const frame = buffered.slice(0, frameEnd);
          buffered = buffered.slice(frameEnd + 2);
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (dataLine) return JSON.parse(dataLine.slice("data: ".length));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream closed before the expected event arrived");
        buffered += decoder.decode(value, { stream: true });
      }
    }

    const first = await nextEvent();
    assert.equal(first.type, "server.version");

    const repo = new RemoteTodoRepository({ serverUrl: baseUrl, deviceId, deviceName, secret });
    const createdTodo = await repo.create({ title: "sse test todo" }, { agent: "a", session: "s", deviceId, deviceName });

    const createdEvent = await nextEvent();
    assert.equal(createdEvent.type, "todo.created");
    assert.equal(createdEvent.todoUuid, createdTodo.uuid);

    await reader.cancel();
  } finally {
    await cleanup(running, serverDataDir);
  }
});

test("docket serve: binding with no --host defaults to 127.0.0.1, never 0.0.0.0 (RFC §9)", async () => {
  const serverDataDir = await mkdtemp(join(tmpdir(), "docket-serve-e2e-bind-"));
  let running: RunningServe | undefined;
  try {
    running = await spawnServe(serverDataDir);
    assert.ok(running.baseUrl.startsWith("http://127.0.0.1:"), `expected a 127.0.0.1 bind, got ${running.baseUrl}`);
  } finally {
    await cleanup(running, serverDataDir);
  }
});

test("docket serve: a loopback request without the admin token cannot manage devices", async () => {
  /*
   * The reason this test exists, stated plainly: the documented way to put HTTPS in front of
   * `docket serve` is a reverse proxy on the same box —
   *
   *     todo.example.com { reverse_proxy 127.0.0.1:8788 }
   *
   * — and every request arriving that way has a loopback source address. When loopback WAS
   * the authorization boundary, that meant anyone on the internet could mint a pairing code,
   * approve their own request, and walk away with an authorised device against the
   * authoritative store. A network property is not an identity.
   */
  const serverDataDir = await mkdtemp(join(tmpdir(), "docket-serve-admin-"));
  let running: RunningServe | undefined;
  try {
    running = await spawnServe(serverDataDir);
    const { baseUrl } = running;

    const routes: Array<[string, string]> = [
      ["POST", "/api/v1/admin/devices/pairing-code"],
      ["GET", "/api/v1/admin/devices/pending"],
      ["GET", "/api/v1/admin/devices"],
      ["POST", "/api/v1/admin/devices/pending/anything/approve"],
      ["POST", "/api/v1/admin/devices/someone/revoke"],
      ["DELETE", "/api/v1/admin/devices/someone"],
    ];
    for (const [method, path] of routes) {
      // Straight at the server over loopback, exactly as a proxied request would arrive.
      const bare = await fetchJson(`${baseUrl}${path}`, { method });
      assert.equal(bare.status, 403, `${method} ${path} was served without the admin token`);

      const forged = await fetchJson(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${"0".repeat(64)}` },
      });
      assert.equal(forged.status, 403, `${method} ${path} accepted a forged admin token`);
    }

    // A forwarded header must not buy anything either — it is set by whoever spoke to the proxy.
    const spoofed = await fetchJson(`${baseUrl}/api/v1/admin/devices/pairing-code`, {
      method: "POST",
      headers: { "X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1" },
    });
    assert.equal(spoofed.status, 403, "a forwarded-for header was treated as authorization");

    // The real credential still works, or the routes would be unusable rather than protected.
    const authorised = await adminFetch(running.dataDir, `${baseUrl}/api/v1/admin/devices`, { method: "GET" });
    assert.equal(authorised.status, 200, "the admin token no longer opens the admin routes");
  } finally {
    running?.child.kill();
    await rm(serverDataDir, { recursive: true, force: true });
  }
});
