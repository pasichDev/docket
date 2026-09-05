import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-convergence-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;

/* ==========================================================================================
 * A clock the seed controls
 *
 * The point of a seeded property test is that a failure reproduces. This one did not: the
 * seed drove the topology, the operations and the skews, but `mutations.ts` reads the real
 * clock, so whether two operations landed in the same millisecond depended on how fast the
 * machine was. A seed that failed on a CI runner passed everywhere else — which is the worst
 * possible outcome, because it makes a genuine convergence failure indistinguishable from
 * noise and trains everyone to re-run the job.
 *
 * The clock is now part of the seed. It is installed before mutations.js is imported, since
 * that module captures nothing but does call `new Date()` on every mutation.
 * ========================================================================================== */
const RealDate = Date;
const EPOCH = RealDate.parse("2026-03-01T12:00:00.000Z");
let virtualNow = EPOCH;

/**
 * How far the clock may jump between operations, and how many seeds to sweep.
 *
 * The defaults keep the suite fast. Both are overridable because the interesting question
 * after a failure is "does this survive a deeper search?", and answering it should not
 * require editing the test:
 *
 *   DOCKET_CONVERGENCE_SEEDS=20000 DOCKET_CONVERGENCE_CLOCK_STEP=1 npm test
 *
 * A step of 1 means `Math.floor(random() * 1)` — always zero — so every operation in a run
 * shares one millisecond and every comparison falls through to the tie-break. That is the
 * hardest case for last-write-wins and the cheapest one to search.
 */
const CLOCK_STEP_MS = Number(process.env.DOCKET_CONVERGENCE_CLOCK_STEP ?? 3);
const SEED_COUNT = Number(process.env.DOCKET_CONVERGENCE_SEEDS ?? 500);

class VirtualDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date> | []) {
    if (args.length === 0) super(virtualNow);
    else super(...(args as ConstructorParameters<typeof Date>));
  }
  static now(): number {
    return virtualNow;
  }
}
globalThis.Date = VirtualDate as unknown as DateConstructor;

const { applyEdits, createTodo, tombstoneDelete } = await import("./mutations.js");
const { buildSyncPayload, cursorAfterPage } = await import("./sync/payload.js");
const { mergeSyncPayload } = await import("./sync/merge.js");
import type { Todo, TodoStore } from "./types.js";

test.after(() => {
  globalThis.Date = RealDate;
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

/** Deterministic PRNG — a failing seed has to reproduce exactly, or the report is useless. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Device {
  store: TodoStore;
  id: string;
  /** Wall-clock offset in ms. Devices do NOT agree about "now", which is the whole difficulty. */
  skewMs: number;
}

/** Directed pull edge: `from` is pulled BY `to`. A pairing produces one in each direction. */
interface Edge {
  from: number;
  to: number;
}

function makeDevices(count: number, random: () => number): Device[] {
  return Array.from({ length: count }, (_, i) => ({
    store: { formatVersion: 8, nextId: 1, todos: [], deletedUuids: [], seqCounter: 0 },
    id: `device-${String.fromCharCode(97 + i)}`,
    // Up to ±90s in either direction: enough to invert the order of two edits made seconds
    // apart on different machines, which is exactly the case last-write-wins gets wrong.
    skewMs: Math.floor((random() - 0.5) * 180_000),
  }));
}

/**
 * Random topologies, deliberately including ones that are NOT fully connected. A full mesh
 * hides the bug this whole format bump exists for: an item only reaches a third device by
 * being handed on, and a chain is where "handed on" is load-bearing.
 */
function makeTopology(count: number, random: () => number): { edges: Edge[]; shape: string } {
  const pairs: Array<[number, number]> = [];
  const shape = ["chain", "star", "ring", "partial-mesh"][Math.floor(random() * 4)];
  if (shape === "chain") for (let i = 0; i + 1 < count; i++) pairs.push([i, i + 1]);
  else if (shape === "star") for (let i = 1; i < count; i++) pairs.push([0, i]);
  else if (shape === "ring") for (let i = 0; i < count; i++) pairs.push([i, (i + 1) % count]);
  else {
    for (let i = 0; i < count; i++)
      for (let j = i + 1; j < count; j++) if (random() < 0.6) pairs.push([i, j]);
    // A partitioned mesh can never converge, and asserting that it does would be asserting
    // a falsehood. Counting edges is NOT enough to rule that out — a triangle plus an
    // isolated pair has plenty of edges and two components — so this checks reachability
    // and stitches any leftover components together.
    const parent = Array.from({ length: count }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (const [a, b] of pairs) parent[find(a)] = find(b);
    for (let i = 1; i < count; i++) {
      if (find(i) !== find(0)) {
        pairs.push([0, i]);
        parent[find(i)] = find(0);
      }
    }
  }
  const edges: Edge[] = [];
  for (const [a, b] of pairs) edges.push({ from: a, to: b }, { from: b, to: a });
  return { edges, shape };
}

/**
 * Applies a mutation and re-stamps its timestamps into the device's own skewed clock.
 *
 * `mutations.ts` reads the real clock, and this needs devices that disagree about the time.
 * The order matters and is easy to get wrong: production reads `new Date()` — which on a
 * skewed machine is ALREADY skewed — and then clamps the result forward past the version it
 * overwrites. So the model must shift first and clamp second. Shifting after the clamp
 * instead would silently undo it and model a device that cannot exist, which is exactly the
 * mistake that made this test blame the code for its own error once already.
 *
 * `floor` is the record's timestamp BEFORE the mutation, i.e. what production would have
 * clamped against.
 */
function withSkew(device: Device, floor: string | null, mutate: () => Todo | null): void {
  const item = mutate();
  if (!item) return;
  const stamped = item.updatedAt;
  let shifted = new Date(Date.parse(stamped) + device.skewMs).toISOString();
  if (floor && shifted <= floor) shifted = new Date(Date.parse(floor) + 1).toISOString();
  for (const [field, at] of Object.entries(item.fieldTimestamps ?? {})) {
    if (at === stamped) item.fieldTimestamps[field] = shifted;
  }
  // EVERY timestamp this mutation just wrote moves onto the device's clock, `createdAt`
  // included. Shifting only `updatedAt` modelled a machine whose creation time came from a
  // correct clock and whose edit time came from a skewed one — which does not exist, and
  // which puts `createdAt` up to a minute and a half AHEAD of the record's own `updatedAt`.
  //
  // That is not a harmless inaccuracy. A field with no per-field timestamp falls back to
  // `createdAt`, so a creation time in the future made an untouched field unbeatable: a
  // genuinely newer edit from another device lost every comparison, for ever, and the test
  // reported a convergence failure the code could not produce. The comment above about
  // getting the order wrong applies to which timestamps move, not just to when.
  if (item.createdAt === stamped) item.createdAt = shifted;
  item.updatedAt = shifted;
}

type OpLog = string[];

function randomOperation(devices: Device[], random: () => number, log: OpLog): void {
  // Zero is deliberately in range: two operations inside one millisecond is the case that
  // used to depend on how fast the machine was, and it is the case last-write-wins finds
  // hardest — equal timestamps fall through to the tie-break.
  virtualNow += Math.floor(random() * CLOCK_STEP_MS);
  const index = Math.floor(random() * devices.length);
  const device = devices[index];
  const { store } = device;
  const live = store.todos;
  const roll = random();

  if (roll < 0.35 || live.length === 0) {
    withSkew(device, null, () => createTodo(store, { title: `t${Math.floor(random() * 1000)}`, agent: "a", session: "s" }, device.id, device.id));
    log.push(`${device.id}: create`);
    return;
  }
  const target = live[Math.floor(random() * live.length)];
  if (roll < 0.75) {
    withSkew(device, target.updatedAt, () =>
      applyEdits(store, target, { title: `edited-${Math.floor(random() * 1000)}` }, "a", device.id, device.id) ? target : null,
    );
    log.push(`${device.id}: edit ${target.uuid.slice(0, 8)}`);
    return;
  }
  // Deletion, on the device's own skewed clock. The skew is applied and THEN re-clamped
  // above the deleted version, because that is the order it happens for real: production
  // reads `new Date()` — already skewed on that machine — and clamps the result. Shifting
  // afterwards instead would silently undo the clamp and model a device that cannot exist.
  const deletedVersion = target.updatedAt;
  tombstoneDelete(store, target, device.id);
  const tombstone = store.deletedUuids.at(-1)!;
  const skewed = new Date(Date.parse(tombstone.deletedAt) + device.skewMs).toISOString();
  tombstone.deletedAt = skewed > deletedVersion ? skewed : new Date(Date.parse(deletedVersion) + 1).toISOString();
  log.push(`${device.id}: delete ${target.uuid.slice(0, 8)}`);
}

function pull(devices: Device[], cursors: Map<string, number>, edge: Edge): void {
  const key = `${edge.to}<-${edge.from}`;
  const cursor = cursors.get(key) ?? 0;
  const payload = buildSyncPayload(devices[edge.from].store, cursor);
  const merged = mergeSyncPayload(devices[edge.to].store, payload, devices[edge.from].id);
  // The cursor advances the way the real client advances it, through the same function.
  //
  // It used to jump straight to `payload.maxSeq`, which is the rule the client stopped using
  // in 3.0: a page carries at most PAGE_SIZE records, so `maxSeq` — the peer's high-water
  // mark — can sit well above the last record actually delivered. Modelling the old rule
  // made this test report non-convergence for a gap the client cannot open, and, worse, made
  // it silent about whether the real rule converges. It is the client's rule that has to be
  // under test here; nothing else in this file exercises it.
  cursors.set(key, cursorAfterPage(payload, cursor, merged.rejectedBelow));
}

/** The live set as every device should agree on it: which items exist, and what they say. */
function liveSet(store: TodoStore): string {
  return JSON.stringify(
    [...store.todos]
      .sort((a, b) => a.uuid.localeCompare(b.uuid))
      .map((t) => [t.uuid, t.title, t.done, t.list, t.priority, t.workspace]),
  );
}

function runSeed(seed: number): { converged: boolean; report: string } {
  virtualNow = EPOCH;
  const random = rng(seed);
  const count = 3 + Math.floor(random() * 3); // 3–5 devices
  const devices = makeDevices(count, random);
  const { edges, shape } = makeTopology(count, random);
  const cursors = new Map<string, number>();
  const log: OpLog = [`seed=${seed} devices=${count} shape=${shape} skew=${devices.map((d) => d.skewMs).join(",")}`];

  const rounds = 3 + Math.floor(random() * 4);
  for (let round = 0; round < rounds; round++) {
    const ops = 1 + Math.floor(random() * 5);
    for (let i = 0; i < ops; i++) randomOperation(devices, random, log);

    // Partial and failed syncs: a real tick reaches some peers and not others, and the
    // order it reaches them in is not stable.
    const shuffled = [...edges].sort(() => random() - 0.5);
    for (const edge of shuffled) {
      if (random() < 0.3) {
        log.push(`skip ${edge.to}<-${edge.from}`);
        continue; // this peer was unreachable this tick
      }
      pull(devices, cursors, edge);
      log.push(`pull ${edge.to}<-${edge.from}`);
    }
  }

  // Quiescence: keep syncing every edge until a full pass changes nothing anywhere. This is
  // what "eventually" means — the property is about the resting state, not about any tick.
  for (let pass = 0; pass < 60; pass++) {
    const before = devices.map((d) => liveSet(d.store)).join("|");
    for (const edge of edges) pull(devices, cursors, edge);
    if (devices.map((d) => liveSet(d.store)).join("|") === before) break;
  }

  const sets = devices.map((d) => liveSet(d.store));
  const converged = sets.every((s) => s === sets[0]);
  if (converged) return { converged, report: "" };

  const detail = devices
    .map((d, i) => `  ${d.id}: ${d.store.todos.length} live, ${d.store.deletedUuids.length} tombstones\n    ${sets[i].slice(0, 400)}`)
    .join("\n");
  return { converged, report: `\nOperation log:\n  ${log.join("\n  ")}\n\nFinal state:\n${detail}\n` };
}

/**
 * The property the entire sync layer exists for, and the only test that checks it rather
 * than checking a scenario somebody thought of: once the dust settles, every device holds
 * the same items. Random topologies, random operations, random clock skew, random partial
 * failures — because every specific case anyone writes by hand is a case they already
 * suspected.
 */
test("sync: every reachable device converges on the same live set (500 random seeds)", () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= SEED_COUNT; seed++) {
    const { converged, report } = runSeed(seed);
    if (!converged) {
      failures.push(`SEED ${seed} DID NOT CONVERGE${report}`);
      if (failures.length >= 3) break; // three is enough to see a pattern
    }
  }
  assert.deepEqual(failures, [], failures.join("\n\n"));
});

test("sync: convergence holds when devices are only ever connected in a chain", () => {
  // Pinned separately from the random sweep: the chain is the topology the transitive
  // propagation bug lived in, and a random sweep that happened to stop generating chains
  // would go quiet about it.
  const failures: string[] = [];
  for (let seed = 10_000; seed < 10_000 + Math.max(120, Math.floor(SEED_COUNT / 4)); seed++) {
    virtualNow = EPOCH;
    const random = rng(seed);
    const devices = makeDevices(4, random);
    const edges: Edge[] = [];
    for (let i = 0; i + 1 < devices.length; i++) edges.push({ from: i, to: i + 1 }, { from: i + 1, to: i });
    const cursors = new Map<string, number>();
    const log: OpLog = [];
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 3; i++) randomOperation(devices, random, log);
      for (const edge of edges) if (random() < 0.7) pull(devices, cursors, edge);
    }
    for (let pass = 0; pass < 60; pass++) {
      const before = devices.map((d) => liveSet(d.store)).join("|");
      for (const edge of edges) pull(devices, cursors, edge);
      if (devices.map((d) => liveSet(d.store)).join("|") === before) break;
    }
    const sets = devices.map((d) => liveSet(d.store));
    if (!sets.every((s) => s === sets[0])) failures.push(`chain seed ${seed}: ${sets.map((s) => s.length).join(" vs ")}`);
  }
  assert.deepEqual(failures, []);
});
