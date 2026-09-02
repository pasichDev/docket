import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const localDataDirectory = await mkdtemp(join(tmpdir(), "docket-client-test-local-"));
process.env.DOCKET_DATA_DIR = localDataDirectory;

// See repository.test.ts for why DOCKET_DATA_DIR must be set before this dynamic import.
const { LocalTodoRepository, TodoNotFoundError } = await import("../repository.js");
const { RemoteTodoRepository, RemoteUnavailableError } = await import("./client.js");

test.after(async () => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(localDataDirectory, { recursive: true, force: true });
});

function context() {
  return { agent: "test-agent", session: "s1", deviceId: "device-1", deviceName: "TestBox" };
}

/**
 * RFC "Local and Self-Hosted Backend Modes" §22's central invariant, verified end to end:
 * every RemoteTodoRepository operation against an unreachable server throws
 * RemoteUnavailableError, AND — the part a naive implementation could get subtly wrong —
 * none of them ever touch LOCAL storage as a fallback. `localDataDirectory` above is a
 * completely separate scratch directory this repository never even references; asserting
 * it stays empty proves there's no code path that quietly writes there.
 */
test("RemoteTodoRepository: every operation against an unreachable server throws RemoteUnavailableError and creates NO local state", async () => {
  // Port 1 is a privileged, essentially-always-closed port — connecting to it fails fast
  // with ECONNREFUSED rather than hanging until a timeout, keeping this test quick.
  const repo = new RemoteTodoRepository({
    serverUrl: "http://127.0.0.1:1",
    deviceId: "device-1",
    deviceName: "TestBox",
    secret: "f".repeat(64),
    fetchTimeoutMs: 1000,
  });

  await assert.rejects(() => repo.list({}), RemoteUnavailableError);
  // get(1) resolves to null WITHOUT ever touching the network — id 1 has no known uuid
  // mapping yet (see client.ts's resolveRemoteId), so there's nothing to look up; this is
  // covered on its own below, separately from the "server unreachable" assertions here.
  await assert.rejects(() => repo.create({ title: "should never be created anywhere" }, context()), RemoteUnavailableError);
  await assert.rejects(() => repo.health(), RemoteUnavailableError);

  // The local data directory this test set DOCKET_DATA_DIR to must remain completely
  // untouched — no todos.json.enc, no key file, nothing. RemoteTodoRepository never
  // imports storage.ts at all, but this proves it end to end rather than by code reading.
  const entries = await readdir(localDataDirectory).catch(() => []);
  assert.deepEqual(entries, [], `expected the local data directory to stay empty after every failed remote call, found: ${entries.join(", ")}`);

  // And LocalTodoRepository itself — pointed at the SAME directory — confirms zero todos,
  // not just zero files (in case some other code path created an empty-but-present store).
  const local = new LocalTodoRepository();
  assert.deepEqual(await local.list({}), []);
});

test("RemoteTodoRepository: a bare numeric id with no known mapping is treated as not-found LOCALLY, never forwarded to the server's own numeric id space", async () => {
  // Deliberately pointed at nothing reachable — if resolveRemoteId ever forwarded a raw
  // numeric id instead of refusing it client-side, this would hang/fail on the network
  // instead of failing immediately and locally the way it must (see client.ts's comment on
  // PURE_DIGITS_RE: a client-side synthetic id must never collide with the SERVER's own
  // unrelated local-numeric-id space).
  const repo = new RemoteTodoRepository({
    serverUrl: "http://127.0.0.1:1",
    deviceId: "device-1",
    deviceName: "TestBox",
    secret: "f".repeat(64),
    fetchTimeoutMs: 1000,
  });

  assert.equal(await repo.get(42), null);
  assert.equal(await repo.get("42"), null);
  await assert.rejects(() => repo.edit(42, { title: "x" }, context()), TodoNotFoundError);
  await assert.rejects(() => repo.complete(42, context()), TodoNotFoundError);
  await assert.rejects(() => repo.claim(42, context()), TodoNotFoundError);
});
