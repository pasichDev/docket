import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-digests-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const digests = await import("./digests.js");
const { buildDigestPage, createDigest, deleteDigestRecord, digestCursorAfterPage, DIGEST_PAGE_SIZE, mergeDigestPage, validateDigestInput, DigestValidationError } =
  digests;
type DigestStore = import("./digests.js").DigestStore;

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

const ctx = { agent: "claude-code", deviceId: "dev-a", deviceName: "A", workspace: null };

function store(): DigestStore {
  return { formatVersion: 1, seqCounter: 0, digests: [], deleted: [] };
}

function sample(title = "Fri digest") {
  return {
    title,
    summary: "Two MRs **await review**.",
    highlights: ["!154 is blocking the release"],
    metrics: [{ label: "MRs merged", value: 3, tone: "good" as const }],
    sections: [
      {
        title: "Needs you",
        items: [{ kind: "mr" as const, title: "Fix enroll route", url: "https://gitlab.com/g/r/-/merge_requests/154", ref: "!154", status: "open", tone: "warn" as const, attention: true }],
      },
    ],
    sources: [{ name: "gitlab", ok: true, detail: "9 MRs" }],
    windowFrom: "2026-10-03",
    windowTo: "2026-10-04T18:00:00Z",
  };
}

/** One peer pulling from another, in memory, to the end. Returns the new cursor. */
function pullAll(from: DigestStore, into: DigestStore, cursor: number): number {
  for (let guard = 0; guard < 100; guard++) {
    const page = buildDigestPage(from, cursor);
    const merged = mergeDigestPage(into, page);
    const next = digestCursorAfterPage(page, cursor, merged.rejectedBelow);
    const done = !page.hasMore || next === cursor;
    cursor = next;
    if (done) return cursor;
  }
  throw new Error("pull did not converge");
}

test("validateDigestInput: a metric value sent as a number is kept as text, not rejected", () => {
  const body = validateDigestInput(sample());
  assert.equal(body.metrics[0].value, "3");
  assert.equal(body.sections[0].items[0].attention, true);
});

test("validateDigestInput: a section's group is kept, trimmed and length-checked", () => {
  const body = validateDigestInput({ ...sample(), sections: [{ ...sample().sections[0], group: "  Work  " }] });
  assert.equal(body.sections[0].group, "Work");
  assert.equal(validateDigestInput(sample()).sections[0].group, null);
  assert.throws(() => validateDigestInput({ ...sample(), sections: [{ ...sample().sections[0], group: "g".repeat(61) }] }), /group is 61 characters/);
});

test("validateDigestInput: names the field that broke a limit, so the agent can fix its call", () => {
  const tooLong = { ...sample(), title: "x".repeat(201) };
  assert.throws(() => validateDigestInput(tooLong), (err: Error) => err instanceof DigestValidationError && /title is 201 characters/.test(err.message));
});

test("validateDigestInput: a javascript: link is refused at publish (it would become a clickable href)", () => {
  const bad = sample();
  bad.sections[0].items[0].url = "javascript:alert(1)";
  assert.throws(() => validateDigestInput(bad), /must be an http/);
});

test("validateDigestInput: the item cap counts across every section, not per section", () => {
  const items = Array.from({ length: 160 }, (_, i) => ({ kind: "note" as const, title: `n${i}` }));
  const body = { title: "big", summary: "", sections: [{ title: "a", items }, { title: "b", items }] };
  assert.throws(() => validateDigestInput(body), /320 items; the limit is 300/);
});

test("sanitizeRemoteDigest: a peer's javascript: link is dropped, the item is kept", () => {
  const s = store();
  const d = createDigest(s, sample(), ctx);
  const hostile = structuredClone(d);
  hostile.sections[0].items[0].url = "javascript:alert(1)";
  const clean = digests.sanitizeRemoteDigest(hostile)!;
  assert.equal(clean.sections[0].items[0].url, null);
  assert.equal(clean.sections[0].items[0].title, "Fix enroll route");
});

test("sanitizeRemoteDigest: an over-long peer record is clamped, not refused", () => {
  const s = store();
  const d = createDigest(s, sample(), ctx);
  const long = { ...structuredClone(d), summary: "y".repeat(20_000) };
  assert.equal(digests.sanitizeRemoteDigest(long)!.summary.length, digests.DIGEST_LIMITS.summary);
});

test("sanitizeRemoteDigest: a field of an unexpected type is dropped, not the whole digest (it would stall the cursor)", () => {
  const s = store();
  const d = createDigest(s, sample(), ctx) as unknown as Record<string, unknown>;
  const odd = structuredClone(d) as any;
  odd.sections[0].items[0].ref = 154; // a number where a string was expected
  odd.sections[0].items.push({ kind: "mr" }); // no title: this one entry goes
  odd.sections[0].items.push("not an object");
  odd.metrics = { not: "an array" };
  odd.highlights = [{ an: "object" }, "kept"];
  const clean = digests.sanitizeRemoteDigest(odd)!;
  assert.ok(clean, "the digest itself must survive");
  assert.equal(clean.sections[0].items.length, 1);
  assert.equal(clean.sections[0].items[0].ref, "154");
  assert.deepEqual(clean.metrics, []);
  assert.deepEqual(clean.highlights, ["kept"]);
});

test("digest store: the file mints its epoch once and keeps it, and a fresh file gets a different one", async () => {
  const { digestPageEpoch } = await import("./sync/digests.js");
  await digests.publishDigest(sample("epoch a"), ctx);
  const first = (await digests.readDigestStore()).epoch;
  assert.ok(first);
  await digests.publishDigest(sample("epoch b"), ctx);
  assert.equal((await digests.readDigestStore()).epoch, first, "every write must keep the same epoch");
  const recreated = { ...(await digests.readDigestStore()), epoch: "another" };
  assert.notEqual(digestPageEpoch("store", recreated), digestPageEpoch("store", await digests.readDigestStore()));
  assert.notEqual(digestPageEpoch("store-1", recreated), digestPageEpoch("store-2", recreated), "a restore (new store epoch) must void cursors too");
});

test("digest sync: a digest made on C reaches A through B, though A and C never paired", () => {
  const a = store();
  const b = store();
  const c = store();
  const fromC = createDigest(c, sample("from C"), { ...ctx, deviceId: "dev-c" });
  // B already has history of its own, so C's record arrives at a LOWER number than A's
  // cursor into B would have to skip — unless B re-stamps it on arrival.
  for (let i = 0; i < 3; i++) createDigest(b, sample(`b${i}`), { ...ctx, deviceId: "dev-b" });
  let aCursorIntoB = pullAll(b, a, 0);
  assert.equal(a.digests.length, 3);

  pullAll(c, b, 0);
  aCursorIntoB = pullAll(b, a, aCursorIntoB);
  assert.ok(a.digests.some((d) => d.uuid === fromC.uuid), "C's digest must reach A via B");
});

test("digest sync: a deletion propagates, and a late copy of the deleted digest is not resurrected", () => {
  const a = store();
  const b = store();
  const d = createDigest(a, sample(), ctx);
  const bCursor = pullAll(a, b, 0);
  const stale = structuredClone(b.digests[0]);
  deleteDigestRecord(a, a.digests[0], "dev-a");
  pullAll(a, b, bCursor);
  assert.equal(b.digests.length, 0);
  // A third device that still had the digest sends it to B afterwards.
  const third = store();
  third.digests.push({ ...stale, localSeq: 1 });
  third.seqCounter = 1;
  pullAll(third, b, 0);
  assert.equal(b.digests.length, 0, "a tombstoned digest must stay deleted");
  assert.ok(b.deleted.some((t) => t.uuid === d.uuid));
});

test("digest sync: pages larger than one page arrive whole, and the cursor never skips a tombstone stream", () => {
  const a = store();
  const b = store();
  for (let i = 0; i < DIGEST_PAGE_SIZE * 2 + 7; i++) createDigest(a, sample(`d${i}`), ctx);
  for (const d of a.digests.slice(0, DIGEST_PAGE_SIZE + 3)) deleteDigestRecord(a, d, "dev-a");
  pullAll(a, b, 0);
  assert.equal(b.digests.length, a.digests.length);
  assert.deepEqual(new Set(b.digests.map((d) => d.uuid)), new Set(a.digests.map((d) => d.uuid)));
});

test("digest sync: a record that fails validation holds the cursor below it instead of stepping over it", () => {
  const a = store();
  createDigest(a, sample("ok"), ctx);
  const bad = createDigest(a, sample("bad"), ctx);
  createDigest(a, sample("after"), ctx);
  (bad as { createdAt: string }).createdAt = "not a date";
  const b = store();
  const page = buildDigestPage(a, 0);
  const merged = mergeDigestPage(b, page);
  assert.equal(merged.rejectedBelow, bad.localSeq);
  assert.equal(digestCursorAfterPage(page, 0, merged.rejectedBelow), bad.localSeq - 1);
});

test("digest sync: a peer that lies about maxSeq cannot move the cursor past what it delivered", () => {
  const a = store();
  createDigest(a, sample(), ctx);
  const page = { ...buildDigestPage(a, 0), maxSeq: 999 };
  assert.equal(digestCursorAfterPage(page, 0, null), 1);
});

test("seen marks: last write wins across devices, the undo syncs too, and the loser re-advertises", async () => {
  const { setSeenRecord, seenIndex, isSeen } = digests;
  const a = store();
  const b = store();
  const item = { url: "https://gitlab.com/g/r/-/merge_requests/9", repo: "g/r", ref: "!9", title: "t", status: "merged" };
  setSeenRecord(a, { key: digests.seenKey(item), status: "merged", title: "t" }, true, "dev-a");
  let bCursor = pullAll(a, b, 0);
  assert.ok(isSeen(seenIndex(b), item), "a mark must reach the other device");
  assert.ok(!isSeen(seenIndex(b), { ...item, status: "reverted" }), "a changed status is news again");
  await new Promise((r) => setTimeout(r, 2));
  setSeenRecord(b, { key: digests.seenKey(item), status: "merged", title: "t" }, false, "dev-b");
  const aCursor = pullAll(b, a, 0);
  assert.ok(!isSeen(seenIndex(a), item), "the undo must reach the first device");
  // A stale copy arriving later must not win, and must make the newer side re-send.
  const stale = store();
  stale.seen = [{ ...a.seen![0], seen: true, at: "2020-01-01T00:00:00.000Z", localSeq: 1 }];
  stale.seqCounter = 1;
  const before = a.seqCounter;
  pullAll(stale, a, 0);
  assert.ok(!isSeen(seenIndex(a), item));
  assert.ok(a.seqCounter > before, "the winning copy must be re-stamped so the stale peer hears it");
  void bCursor;
  void aCursor;
});

test("findDigest: resolves the D- short id in any case, with or without the prefix", () => {
  const s = store();
  const d = createDigest(s, sample(), ctx);
  const short = digests.digestShortId(d.uuid);
  assert.match(short, /^D-[0-9A-Z]{6}$/);
  assert.equal(digests.findDigest(s, short.toLowerCase())?.uuid, d.uuid);
  assert.equal(digests.findDigest(s, short.slice(2))?.uuid, d.uuid);
  assert.equal(digests.findDigest(s, d.uuid)?.uuid, d.uuid);
});

test("publish/list/delete: round trip through the encrypted file", async () => {
  const published = await digests.publishDigest(sample("on disk"), ctx);
  const { digests: listed } = await digests.listDigests();
  assert.equal(listed[0].uuid, published.uuid);
  assert.equal((await digests.getDigest(digests.digestShortId(published.uuid)))?.title, "on disk");
  assert.ok(await digests.deleteDigest(published.uuid, "dev-a"));
  assert.equal(await digests.getDigest(published.uuid), null);
});

test("digest sync over HTTP: a paired peer pulls a signed page; a todo-sync signature is refused", async () => {
  const { addPeer, loadPeers } = await import("./peers.js");
  const { createWebServer } = await import("./web/server.js");
  const { pullDigestsFromPeer, DIGEST_SYNC_PATH } = await import("./sync/digests.js");
  const { signSyncRequest } = await import("./sync/auth.js");

  const served = await digests.publishDigest(sample("served over http"), ctx);
  const server = await createWebServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const secret = "ab".repeat(32);
    await addPeer({ id: "caller", name: "Caller", url: `http://127.0.0.1:${port}`, secret, pairedAt: new Date().toISOString(), lastSyncAt: null, lastSyncOk: true });

    // A signature over the bare cursor — what the todo sync signs — must not open this endpoint.
    const ts = new Date().toISOString();
    const replay = await fetch(`http://127.0.0.1:${port}${DIGEST_SYNC_PATH}?sinceSeq=0&deviceId=caller&timestamp=${encodeURIComponent(ts)}&signature=${signSyncRequest(secret, "caller", "0", ts)}`);
    assert.equal(replay.status, 403);

    const local = store();
    const peer = (await loadPeers()).find((p) => p.id === "caller")!;
    await pullDigestsFromPeer(peer, "caller", async (fn) => fn(local));
    assert.ok(local.digests.some((d) => d.uuid === served.uuid));
    const after = (await loadPeers()).find((p) => p.id === "caller")!;
    assert.ok((after.digestSeq ?? 0) > 0, "the cursor must be recorded on the peer");
    assert.equal(after.digestError, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("digest sync over HTTP: a peer without the endpoint is reported plainly, and the todo sync's error slot is untouched", async () => {
  const { createServer } = await import("node:http");
  const { addPeer, loadPeers } = await import("./peers.js");
  const { pullDigestsFromPeer, PEER_WITHOUT_DIGESTS } = await import("./sync/digests.js");
  const old = createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not found"}');
  });
  await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
  try {
    const port = (old.address() as AddressInfo).port;
    await addPeer({ id: "old-peer", name: "Old", url: `http://127.0.0.1:${port}`, secret: "cd".repeat(32), pairedAt: new Date().toISOString(), lastSyncAt: null, lastSyncOk: true, lastError: null });
    const peer = (await loadPeers()).find((p) => p.id === "old-peer")!;
    await pullDigestsFromPeer(peer, "me", async (fn) => fn(store()));
    const after = (await loadPeers()).find((p) => p.id === "old-peer")!;
    assert.equal(after.digestError, PEER_WITHOUT_DIGESTS);
    assert.equal(after.lastError, null);
    assert.equal(after.digestSeq ?? 0, 0);
  } finally {
    await new Promise((resolve) => old.close(resolve));
  }
});

test("remote digests: a server without the digest routes is named as too old, not read as 'no such digest'", async () => {
  const { RemoteDigestService, SERVER_PREDATES_DIGESTS } = await import("./digest-service.js");
  const { RemoteProtocolError } = await import("./remote/client.js");
  const reply = (status: number, body: unknown) => ({
    call: async () => ({ status, body }),
    unexpectedResponse: (s: number) => new Error(`unexpected ${s}`),
  });
  const old = new RemoteDigestService(reply(404, { error: "not found" }));
  for (const attempt of [() => old.list(5), () => old.get("D-ABCDEF"), () => old.seen(), () => old.publish(sample(), ctx)]) {
    await assert.rejects(attempt, (err: Error) => err instanceof RemoteProtocolError && err.message === SERVER_PREDATES_DIGESTS);
  }
  const current = new RemoteDigestService(reply(404, { error: "no such digest" }));
  assert.equal(await current.get("D-ABCDEF"), null, "the digest routes' own 404 is a plain miss");
});
