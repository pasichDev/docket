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

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-pagination-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { buildSyncPayload, encryptSyncPayload, MAX_PAGES_PER_TICK, PAGE_SIZE, pullFromPeer, verifySyncRequest } = await import("./sync.js");
const { addPeer, loadPeers } = await import("./peers.js");

const SECRET = randomBytes(32).toString("hex");
const TOTAL_ITEMS = 2500;

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

function emptyStore(): TodoStore {
  return { formatVersion: 8, nextId: 1, todos: [], deletedUuids: [], seqCounter: 0 };
}

/**
 * A real peer, over real HTTP, answering the real signed endpoint. Stubbing the fetch
 * instead would let the test pass while the client and server disagreed about the wire
 * format — which is precisely the seam the silent-truncation bug lived in.
 */
async function startPeer(store: TodoStore, seen: number[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const sinceSeq = url.searchParams.get("sinceSeq") ?? "";
    const deviceId = url.searchParams.get("deviceId") ?? "";
    const timestamp = url.searchParams.get("timestamp") ?? "";
    const signature = url.searchParams.get("signature") ?? "";
    if (!verifySyncRequest(SECRET, deviceId, sinceSeq, timestamp, signature)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "signature invalid" }));
      return;
    }
    seen.push(Number(sinceSeq));
    const payload = buildSyncPayload(store, Number(sinceSeq));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(encryptSyncPayload(SECRET, payload)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test("pullFromPeer: a first sync of 2500 items delivers every one of them, in pages", async () => {
  const remote = emptyStore();
  for (let i = 0; i < TOTAL_ITEMS; i++) {
    createTodo(remote, { title: `item ${i}`, agent: "codex", session: "s" }, "device-remote", "Remote");
  }

  const requestedCursors: number[] = [];
  const { server, url } = await startPeer(remote, requestedCursors);
  try {
    await addPeer({
      id: "peer-pagination",
      name: "Remote",
      url,
      secret: SECRET,
      pairedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastSyncOk: false,
    });

    const local = emptyStore();
    const [peer] = await loadPeers();
    await pullFromPeer(peer, "device-local", async (fn) => fn(local));

    assert.equal(local.todos.length, TOTAL_ITEMS, "every item must arrive — a first sync must not silently drop the tail");
    const arrived = new Set(local.todos.map((t) => t.uuid));
    for (const t of remote.todos) assert.ok(arrived.has(t.uuid), `item ${t.uuid} never arrived`);
  } finally {
    server.close();
  }

  // The cursor must climb strictly, one page at a time, starting from zero — never jump.
  assert.equal(requestedCursors[0], 0);
  assert.equal(requestedCursors.length, Math.ceil(TOTAL_ITEMS / PAGE_SIZE), "one request per page, no more and no fewer");
  for (let i = 1; i < requestedCursors.length; i++) {
    assert.ok(requestedCursors[i] > requestedCursors[i - 1], "the cursor must advance between pages");
    assert.ok(requestedCursors[i] <= requestedCursors[i - 1] + PAGE_SIZE, "the cursor must never skip past unmerged records");
  }
});

test("pullFromPeer: the stored cursor advances only to what was actually merged", async () => {
  const remote = emptyStore();
  for (let i = 0; i < 10; i++) createTodo(remote, { title: `item ${i}`, agent: null, session: null }, "device-remote", "Remote");

  const { server, url } = await startPeer(remote, []);
  try {
    await addPeer({
      id: "peer-cursor",
      name: "Remote",
      url,
      secret: SECRET,
      pairedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastSyncOk: false,
    });
    const local = emptyStore();
    const peer = (await loadPeers()).find((p) => p.id === "peer-cursor")!;
    await pullFromPeer(peer, "device-local", async (fn) => fn(local));

    const after = (await loadPeers()).find((p) => p.id === "peer-cursor")!;
    assert.equal(after.lastSeq, remote.seqCounter, "the cursor lands exactly on the peer's high-water mark, no further");
    assert.equal(after.lastSyncOk, true);
    assert.equal(after.lastError, null);

    // A second pull from that cursor has nothing left to say, and must not re-deliver.
    await pullFromPeer(after, "device-local", async (fn) => fn(local));
    assert.equal(local.todos.length, 10, "a repeat sync from the stored cursor must not duplicate anything");
  } finally {
    server.close();
  }
});

/**
 * A peer still on sync protocol v1. It rejects a request signed over a numeric cursor
 * (it verifies the HMAC over `since`, which such a request doesn't carry), and it does not
 * page — it answers with everything since the timestamp it was given.
 *
 * That combination is the trap: clamping its response the way a paged response is clamped
 * would drop the tail, and then advancing the timestamp cursor to the peer's "now" would
 * step straight over the gap. This is the exact bug v3.0 exists to remove, on the one path
 * that keeps a mixed-version mesh working.
 */
async function startV1Peer(store: TodoStore): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.has("sinceSeq")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "signature invalid or expired" })); // no `reason` — exactly what a v1 build sends
      return;
    }
    const since = url.searchParams.get("since") ?? "";
    if (!verifySyncRequest(SECRET, url.searchParams.get("deviceId") ?? "", since, url.searchParams.get("timestamp") ?? "", url.searchParams.get("signature") ?? "")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "signature invalid" }));
      return;
    }
    const payload = {
      todos: store.todos.filter((t) => t.updatedAt > since),
      deletedUuids: [],
      serverTime: new Date().toISOString(),
      protocolVersion: 1,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(encryptSyncPayload(SECRET, payload)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test("pullFromPeer: a v1 peer with more items than one page still delivers every one of them", async () => {
  const remote = emptyStore();
  for (let i = 0; i < 600; i++) createTodo(remote, { title: `legacy item ${i}`, agent: null, session: null }, "device-remote", "Remote");

  const { server, url } = await startV1Peer(remote);
  try {
    await addPeer({
      id: "peer-v1",
      name: "Old peer",
      url,
      secret: SECRET,
      pairedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastSyncOk: false,
    });
    const local = emptyStore();
    const peer = (await loadPeers()).find((p) => p.id === "peer-v1")!;
    await pullFromPeer(peer, "device-local", async (fn) => fn(local));

    assert.equal(local.todos.length, 600, "a v1 peer's whole backlog must arrive — it cannot page for us");

    const after = (await loadPeers()).find((p) => p.id === "peer-v1")!;
    assert.equal(after.lastSyncOk, true, "the sync succeeded — it is degraded, not broken");
    assert.match(after.lastError ?? "", /sync protocol v1/, "and it must say so out loud rather than syncing quietly");
    // Nothing was clamped, so everything the peer offered landed and the cursor may move to
    // the peer's own reported clock. Staying in THAT clock is the invariant: a merged record
    // can have been authored by a third device, whose timestamps say nothing about where
    // this peer's timeline has reached.
    assert.ok(after.lastSyncAt && after.lastSyncAt >= remote.todos.at(-1)!.updatedAt);

    // A second pull from that cursor must neither duplicate nor lose anything.
    await pullFromPeer(after, "device-local", async (fn) => fn(local));
    assert.equal(local.todos.length, 600, "a repeat sync from the stored timestamp cursor must be a no-op");
  } finally {
    server.close();
  }
});

test("pullFromPeer: a peer that restored a backup voids the cursor instead of going silent", async () => {
  const remote = emptyStore();
  for (let i = 0; i < 5; i++) createTodo(remote, { title: `before ${i}`, agent: null, session: null }, "device-remote", "Remote");

  let epoch = "epoch-one";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const sinceSeq = url.searchParams.get("sinceSeq") ?? "";
    if (!verifySyncRequest(SECRET, url.searchParams.get("deviceId") ?? "", sinceSeq, url.searchParams.get("timestamp") ?? "", url.searchParams.get("signature") ?? "")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "signature invalid" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(encryptSyncPayload(SECRET, buildSyncPayload(remote, Number(sinceSeq), epoch))));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await addPeer({
      id: "peer-epoch",
      name: "Remote",
      url: `http://127.0.0.1:${address.port}`,
      secret: SECRET,
      pairedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastSyncOk: false,
    });
    const local = emptyStore();
    let peer = (await loadPeers()).find((p) => p.id === "peer-epoch")!;
    await pullFromPeer(peer, "device-local", async (fn) => fn(local));
    peer = (await loadPeers()).find((p) => p.id === "peer-epoch")!;
    assert.equal(peer.lastSeq, remote.seqCounter);
    assert.equal(peer.epoch, "epoch-one");

    // The peer restores an older backup: its counter goes backwards and it re-mints its
    // epoch. Our cursor now points past everything it has, so without the epoch check we
    // would sit at a number it will not reach again for a long time and hear nothing.
    const restored = emptyStore();
    for (let i = 0; i < 3; i++) createTodo(restored, { title: `after restore ${i}`, agent: null, session: null }, "device-remote", "Remote");
    remote.todos = restored.todos;
    remote.seqCounter = restored.seqCounter;
    epoch = "epoch-two";

    const fresh = emptyStore();
    await pullFromPeer(peer, "device-local", async (fn) => fn(fresh));
    assert.equal(fresh.todos.length, 3, "the restored store must arrive despite our cursor being far ahead of it");
    peer = (await loadPeers()).find((p) => p.id === "peer-epoch")!;
    assert.equal(peer.epoch, "epoch-two", "and the new incarnation is recorded so it isn't re-detected forever");
  } finally {
    server.close();
  }
});

/**
 * Killed mutant: `pages < MAX_PAGES_PER_TICK` → `<=`.
 *
 * A peer that always claims `hasMore` — buggy, hostile, or genuinely enormous — must not be
 * able to hold this device's store lock for an unbounded number of pages. The cap is what
 * makes a first sync of a huge store take several ticks instead of one very long one, and
 * nothing else asserts the boundary is where it says it is.
 */
test("pullFromPeer: a peer that claims hasMore forever is stopped at exactly MAX_PAGES_PER_TICK", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const sinceSeq = Number(url.searchParams.get("sinceSeq") ?? "0");
    if (!verifySyncRequest(SECRET, url.searchParams.get("deviceId") ?? "", String(sinceSeq), url.searchParams.get("timestamp") ?? "", url.searchParams.get("signature") ?? "")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    requests += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    // Always one more item, always more to come — the cursor advances, so this is a peer
    // that genuinely never finishes rather than one stuck resending the same page.
    const store = emptyStore();
    store.seqCounter = sinceSeq + 1;
    const todo = createTodo(store, { title: `endless ${sinceSeq}`, agent: null, session: null }, "device-remote", "R");
    todo.localSeq = sinceSeq + 1;
    res.end(JSON.stringify(encryptSyncPayload(SECRET, { todos: [todo], deletedUuids: [], serverTime: new Date().toISOString(), protocolVersion: 2, maxSeq: sinceSeq + 1, hasMore: true })));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await addPeer({ id: "peer-endless", name: "Endless", url: `http://127.0.0.1:${address.port}`, secret: SECRET, pairedAt: new Date().toISOString(), lastSyncAt: null, lastSyncOk: false });
    const local = emptyStore();
    const peer = (await loadPeers()).find((p) => p.id === "peer-endless")!;
    await pullFromPeer(peer, "device-local", async (fn) => fn(local));

    assert.equal(requests, MAX_PAGES_PER_TICK, `made ${requests} requests; the per-tick cap must bound it exactly`);
    assert.equal(local.todos.length, MAX_PAGES_PER_TICK, "everything fetched is still merged — the cap yields, it does not discard");
    const after = (await loadPeers()).find((p) => p.id === "peer-endless")!;
    assert.equal(after.lastSeq, MAX_PAGES_PER_TICK, "and the cursor records exactly what landed, so the next tick resumes");
  } finally {
    server.close();
  }
});

/**
 * Killed mutant: `(peer.protocolVersion ?? 1) < 2` → `<= 2`.
 *
 * The legacy fallback exists for peers that predate the seq cursor. A peer already known to
 * speak v2 that rejects a request is telling us something real — a rotated secret, a clock
 * outside the signature window — and retrying on the legacy path would waste a round trip
 * and then report the wrong cause.
 */
test("pullFromPeer: a known-v2 peer that rejects us is not mistaken for a v1 peer", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "signature invalid or expired" })); // no `reason` — same shape a v1 build sends
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await addPeer({
      id: "peer-v2-broken",
      name: "Known v2",
      url: `http://127.0.0.1:${address.port}`,
      secret: SECRET,
      pairedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastSyncOk: false,
      protocolVersion: 2, // it has answered v2 before, so "old software" is not the explanation
    });
    const local = emptyStore();
    const peer = (await loadPeers()).find((p) => p.id === "peer-v2-broken")!;
    await pullFromPeer(peer, "device-local", async (fn) => fn(local));

    assert.equal(requests, 1, "no second, legacy-path attempt should have been made");
    const after = (await loadPeers()).find((p) => p.id === "peer-v2-broken")!;
    assert.equal(after.lastSyncOk, false);
    assert.doesNotMatch(after.lastError ?? "", /protocol v1/, "reporting 'update that peer' would send the user after the wrong problem");
  } finally {
    server.close();
  }
});
