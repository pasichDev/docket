import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Peer } from "./types.js";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-peers-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { addPeer, loadPeers, markPeerSynced, peerFingerprint, peerTrustState, restorePeer, revokePeer } = await import("./peers.js");

test.after(async () => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

function makePeer(id: string): Peer {
  return {
    id,
    name: `peer-${id}`,
    url: "http://192.168.1.2:8787",
    secret: "a".repeat(64),
    pairedAt: new Date().toISOString(),
    lastSyncAt: null,
    lastSyncOk: false,
  };
}

test("peerTrustState: a freshly paired peer that has never synced is pending", () => {
  assert.equal(peerTrustState(makePeer("p1")), "pending");
});

test("peerTrustState: a peer whose most recent sync succeeded is trusted", () => {
  assert.equal(peerTrustState({ ...makePeer("p2"), lastSyncAt: new Date().toISOString(), lastSyncOk: true }), "trusted");
});

test("peerTrustState: a peer that has synced before but is currently failing is verified, not pending or trusted", () => {
  assert.equal(peerTrustState({ ...makePeer("p3"), lastSyncAt: new Date().toISOString(), lastSyncOk: false }), "verified");
});

test("peerTrustState: revoked overrides everything else, even a peer that was trusted", () => {
  assert.equal(peerTrustState({ ...makePeer("p4"), lastSyncAt: new Date().toISOString(), lastSyncOk: true, revoked: true }), "revoked");
});

test("revokePeer/restorePeer: round-trips the revoked flag and returns false for an unknown id", async () => {
  await addPeer(makePeer("p5"));
  assert.equal(await revokePeer("p5"), true);
  assert.equal((await loadPeers()).find((p) => p.id === "p5")?.revoked, true);
  assert.equal(await restorePeer("p5"), true);
  assert.equal((await loadPeers()).find((p) => p.id === "p5")?.revoked, false);
  assert.equal(await revokePeer("does-not-exist"), false);
});

test("markPeerSynced: a failed sync records lastError and does not advance lastSyncAt", async () => {
  await addPeer(makePeer("p6"));
  await markPeerSynced("p6", false, { error: "boom" });
  const peer = (await loadPeers()).find((p) => p.id === "p6");
  assert.equal(peer?.lastSyncOk, false);
  assert.equal(peer?.lastError, "boom");
  assert.equal(peer?.lastSyncAt, null);
});

test("peerFingerprint: deterministic and different for different keys, formatted as readable groups", () => {
  const fp1 = peerFingerprint("a".repeat(64));
  const fp2 = peerFingerprint("b".repeat(64));
  assert.equal(fp1, peerFingerprint("a".repeat(64)));
  assert.notEqual(fp1, fp2);
  assert.match(fp1, /^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);
});

test("markPeerSynced: a successful sync clears lastError and stores protocolVersion/clockSkewMs", async () => {
  await addPeer(makePeer("p7"));
  await markPeerSynced("p7", false, { error: "boom" });
  const cursor = new Date().toISOString();
  await markPeerSynced("p7", true, { cursor, protocolVersion: 1, clockSkewMs: 42 });
  const peer = (await loadPeers()).find((p) => p.id === "p7");
  assert.equal(peer?.lastSyncOk, true);
  assert.equal(peer?.lastError, null);
  assert.equal(peer?.lastSyncAt, cursor);
  assert.equal(peer?.protocolVersion, 1);
  assert.equal(peer?.clockSkewMs, 42);
});
