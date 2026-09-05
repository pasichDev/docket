import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTodo } from "./mutations.js";
import type { TodoStore } from "./types.js";

/**
 * What happens when the OTHER side misbehaves: an old peer that cannot page, a connection
 * that dies mid-response, a server that starts failing halfway through a backlog.
 *
 * The rule every test here checks is the same one, from the other direction: the cursor may
 * only ever advance to records that actually landed. Advancing past a gap is silent and
 * permanent — the skipped range is never requested again and nothing anywhere reports it.
 */
const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-resilience-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { buildLegacySyncPayload, buildSyncPayload, encryptSyncPayload, MAX_INCOMING_ITEMS, PAGE_SIZE } = await import("./sync/payload.js");
const { pullFromPeer, V1_PEER_WARNING } = await import("./sync/client.js");
const { verifySyncRequest } = await import("./sync/auth.js");
const { addPeer, loadPeers } = await import("./peers.js");

const SECRET = randomBytes(32).toString("hex");

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

function emptyStore(): TodoStore {
  return { formatVersion: 8, nextId: 1, todos: [], deletedUuids: [], seqCounter: 0 };
}

function seeded(count: number, prefix = "item"): TodoStore {
  const store = emptyStore();
  for (let i = 0; i < count; i++) {
    createTodo(store, { title: `${prefix} ${i}`, agent: null, session: null }, "device-remote", "Remote");
  }
  return store;
}

type Handler = (req: { sinceSeq: string | null; since: string; deviceId: string; timestamp: string; signature: string }, res: import("node:http").ServerResponse) => void;

async function startRawPeer(handler: Handler): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    handler(
      {
        sinceSeq: url.searchParams.get("sinceSeq"),
        since: url.searchParams.get("since") ?? "",
        deviceId: url.searchParams.get("deviceId") ?? "",
        timestamp: url.searchParams.get("timestamp") ?? "",
        signature: url.searchParams.get("signature") ?? "",
      },
      res,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

const ok = (res: import("node:http").ServerResponse, payload: unknown) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(encryptSyncPayload(SECRET, payload as never)));
};

let peerSeq = 0;
async function pairWith(url: string): Promise<string> {
  const id = `peer-resilience-${++peerSeq}`;
  await addPeer({ id, name: "Remote", url, secret: SECRET, pairedAt: new Date().toISOString(), lastSyncAt: null, lastSyncOk: false });
  return id;
}
const peerById = async (id: string) => (await loadPeers()).find((p) => p.id === id)!;

/* ==========================================================================================
 * A peer that predates paging
 * ========================================================================================== */

test("v1 peer: its records still arrive, and the peer is flagged rather than quietly trusted", async () => {
  const remote = seeded(12, "legacy");
  const asked: string[] = [];
  // A real v1 server reads only `since`. Handed a sinceSeq request it verifies the signature
  // over the ABSENT since (""), which cannot match what we signed — so it answers 403, not a
  // 200 without maxSeq. That is the detection this path actually has to survive.
  const { server, url } = await startRawPeer((req, res) => {
    if (req.sinceSeq !== null) {
      asked.push("sinceSeq");
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "signature invalid" }));
      return;
    }
    asked.push("since");
    if (!verifySyncRequest(SECRET, req.deviceId, req.since, req.timestamp, req.signature)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "signature invalid" }));
      return;
    }
    ok(res, buildLegacySyncPayload(remote, req.since));
  });

  try {
    const id = await pairWith(url);
    const local = emptyStore();
    await pullFromPeer(await peerById(id), "device-local", async (fn) => fn(local));

    assert.equal(local.todos.length, 12, "a degraded peer still has to deliver what it can");
    assert.deepEqual(asked, ["sinceSeq", "since"], "it must try the modern cursor first, then fall back exactly once");

    const after = await peerById(id);
    assert.equal(after.lastSyncOk, true, "the pull worked — it is degraded, not failed");
    assert.equal(after.lastError, V1_PEER_WARNING, "the user has to be told this peer cannot relay a third device's edits");
    assert.notEqual(after.lastSyncAt, null, "the legacy timestamp cursor must be stored, or every tick re-delivers everything");
  } finally {
    server.close();
  }
});

/* ==========================================================================================
 * A connection that dies mid-response
 * ========================================================================================== */

test("a response cut off mid-body leaves the cursor exactly where it was", async () => {
  const remote = seeded(30, "cut");
  let cutTheNext = true;
  const { server, url } = await startRawPeer((req, res) => {
    if (!verifySyncRequest(SECRET, req.deviceId, req.sinceSeq ?? req.since, req.timestamp, req.signature)) {
      res.writeHead(403).end();
      return;
    }
    if (cutTheNext) {
      cutTheNext = false;
      // Headers, then half a body, then the socket goes away — a wifi drop mid-page, not a
      // clean error the peer chose to send.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"encrypted":"AAAAAAAAAAAAAAAA');
      res.socket?.destroy();
      return;
    }
    ok(res, buildSyncPayload(remote, Number(req.sinceSeq ?? 0)));
  });

  try {
    const id = await pairWith(url);
    const local = emptyStore();
    await pullFromPeer(await peerById(id), "device-local", async (fn) => fn(local));

    const afterCut = await peerById(id);
    assert.equal(local.todos.length, 0, "nothing may be merged out of a body that never finished");
    assert.equal(afterCut.lastSyncOk, false, "a truncated response is a failure, not a quiet success");
    assert.equal(afterCut.lastSeq ?? 0, 0, "the cursor must not move for a page that never arrived");

    // The next tick, on a healthy connection, has to recover all of it.
    await pullFromPeer(afterCut, "device-local", async (fn) => fn(local));
    assert.equal(local.todos.length, 30, "the next tick must deliver everything the broken one did not");
    assert.equal((await peerById(id)).lastSeq, remote.seqCounter);
  } finally {
    server.close();
  }
});

test("a peer that dies partway through a backlog keeps everything already merged", async () => {
  // Two and a bit pages, with the server failing after the first — the cursor must land on
  // the end of page one, not at zero (losing merged work) and not at the end (losing records).
  const remote = seeded(PAGE_SIZE * 2 + 25, "backlog");
  let served = 0;
  const { server, url } = await startRawPeer((req, res) => {
    if (!verifySyncRequest(SECRET, req.deviceId, req.sinceSeq ?? req.since, req.timestamp, req.signature)) {
      res.writeHead(403).end();
      return;
    }
    if (served++ >= 1) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "peer fell over" }));
      return;
    }
    ok(res, buildSyncPayload(remote, Number(req.sinceSeq ?? 0)));
  });

  try {
    const id = await pairWith(url);
    const local = emptyStore();
    await pullFromPeer(await peerById(id), "device-local", async (fn) => fn(local));

    const after = await peerById(id);
    assert.equal(local.todos.length, PAGE_SIZE, "the page that did arrive must be kept");
    assert.ok((after.lastSeq ?? 0) > 0, "the cursor must keep credit for the page that landed");
    assert.ok(
      (after.lastSeq ?? 0) <= local.todos[local.todos.length - 1].localSeq || (after.lastSeq ?? 0) <= remote.seqCounter,
      "the cursor must never sit above what was merged",
    );

    // Recovery: the peer comes back and the rest arrives, with nothing duplicated.
    served = 0;
    let peer = await peerById(id);
    for (let tick = 0; tick < 5 && local.todos.length < remote.todos.length; tick++) {
      served = 0; // healthy again for this tick
      await pullFromPeer(peer, "device-local", async (fn) => fn(local));
      peer = await peerById(id);
    }
    assert.equal(local.todos.length, remote.todos.length, "every record must arrive once the peer is healthy");
    assert.equal(new Set(local.todos.map((t) => t.uuid)).size, local.todos.length, "recovery must not duplicate anything");
  } finally {
    server.close();
  }
});

test("a peer answering nonsense is a failure, not a cursor advance", async () => {
  const bodies = ['{"encrypted":"not-base64-at-all"}', "{}", "[]", "null", "<html>proxy error</html>"];
  for (const body of bodies) {
    const { server, url } = await startRawPeer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
    try {
      const id = await pairWith(url);
      const local = emptyStore();
      await pullFromPeer(await peerById(id), "device-local", async (fn) => fn(local));
      const after = await peerById(id);
      assert.equal(local.todos.length, 0, `body ${body} put something in the store`);
      assert.equal(after.lastSyncOk, false, `body ${body} was treated as a successful sync`);
      assert.equal(after.lastSeq ?? 0, 0, `body ${body} moved the cursor`);
    } finally {
      server.close();
    }
  }
});

test("v1 peer: more records than one merge can take is reported as incompatible, not synced forever", async () => {
  /*
   * A protocol-v1 peer does not page — it answers with everything since the timestamp it was
   * given. Above MAX_INCOMING_ITEMS the merge clamps, and the legacy cursor deliberately does
   * not advance, so the next tick asks the same question and receives the same oversized
   * answer. For ever, while reporting a successful sync each time.
   *
   * Nothing on this side can fix that; the peer has to page, which is what v2 is. So the
   * only honest outcome is to say so, because "syncing" that never converges is worse than
   * a stated incompatibility.
   */
  const remote = seeded(MAX_INCOMING_ITEMS + 50, "flood");
  const { server, url } = await startRawPeer((req, res) => {
    if (req.sinceSeq !== null) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "signature invalid" }));
      return;
    }
    if (!verifySyncRequest(SECRET, req.deviceId, req.since, req.timestamp, req.signature)) {
      res.writeHead(403).end();
      return;
    }
    ok(res, buildLegacySyncPayload(remote, req.since));
  });

  try {
    const id = await pairWith(url);
    const local = emptyStore();
    await pullFromPeer(await peerById(id), "device-local", async (fn) => fn(local));

    const after = await peerById(id);
    assert.equal(after.lastSyncOk, false, "an unfinishable sync must not be recorded as successful");
    assert.match(after.lastError ?? "", /protocol v1/i, `unhelpful error: ${after.lastError}`);
    assert.match(after.lastError ?? "", /never complete|cannot be delivered/i, "the message must say it will not finish, not just that it is degraded");
    assert.match(after.lastError ?? "", /3\.x/, "the message must say what to do about it");

    // The legacy cursor must not have moved past a payload that was clamped.
    assert.ok(!after.lastSyncAt, "the timestamp cursor advanced past records that never landed");
  } finally {
    server.close();
  }
});
