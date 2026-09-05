import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * B24: two live items whose uuids hash to the same short id.
 *
 * The short id is six characters over a 31-character alphabet, so on a shared list that
 * lives for years this is not a thought experiment. What made it a data-loss bug rather than
 * a display one is that the lookup returned the FIRST match: `todo_complete T-XXXXXX` would
 * silently complete somebody else's task, and the only trace was an audit entry on an item
 * nobody had touched.
 */
const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-shortid-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;

const { AmbiguousTodoIdError, findTodoByAnyId, withStore, readStore } = await import("./storage.js");
const { shortId } = await import("./mutations.js");
const { LocalTodoRepository } = await import("./repository.js");
const { uuidv7 } = await import("./uuid7.js");
import type { Todo, TodoStore } from "./types.js";

test.after(async () => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

/**
 * A real collision, found rather than faked: shortId is a pure function of the uuid, so two
 * uuids that genuinely hash together exist and can be searched for. Using real ones means
 * the test exercises the same code path a user would hit, not a hand-stubbed shortId.
 */
function findCollidingUuids(): [string, string] {
  const seen = new Map<string, string>();
  // 31^6 is ~887 million, so a birthday collision needs ~35k draws on average. Bounded well
  // above that, and deterministic in practice: it has never needed more than a fraction.
  for (let i = 0; i < 1_000_000; i++) {
    const uuid = uuidv7();
    const short = shortId(uuid);
    const previous = seen.get(short);
    if (previous && previous !== uuid) return [previous, uuid];
    seen.set(short, uuid);
  }
  throw new Error("no short-id collision found — the search bound is too low for this charset");
}

const [uuidA, uuidB] = findCollidingUuids();

function seed(store: TodoStore): void {
  store.todos = [];
  store.deletedUuids = [];
  store.nextId = 1;
  for (const [index, uuid] of [uuidA, uuidB].entries()) {
    store.todos.push({
      id: index + 1,
      uuid,
      title: `item ${index + 1}`,
      description: null,
      done: false,
      list: "todo",
      category: null,
      priority: null,
      dueDate: null,
      sourceUrl: null,
      agent: null,
      session: null,
      workingAgent: null,
      workingSince: null,
      workingSession: null,
      workingLeaseExpiresAt: null,
      workingDeviceId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      fieldTimestamps: {},
      completedAt: null,
      revision: 1,
      deviceId: "device-1",
      deviceName: "TestBox",
      history: [],
      localSeq: index + 1,
      workspace: null,
    } satisfies Todo);
  }
  store.nextId = 3;
  store.seqCounter = 2;
}

test("the collision this test relies on is real", () => {
  assert.notEqual(uuidA, uuidB);
  assert.equal(shortId(uuidA), shortId(uuidB), "premise broken: these two uuids do not actually collide");
});

test("a short id that matches two items is refused, naming both", async () => {
  await withStore(seed);
  const short = shortId(uuidA);

  const store = await readStore();
  assert.throws(
    () => findTodoByAnyId(store, short),
    AmbiguousTodoIdError,
    "the lookup returned one of two equally valid matches — whichever happened to be first in the array",
  );
  try {
    findTodoByAnyId(store, short);
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(message.includes(uuidA), `the error must name the first candidate: ${message}`);
    assert.ok(message.includes(uuidB), `the error must name the second candidate: ${message}`);
    assert.match(message, /full uuid/, "the error must say what to use instead");
  }
});

test("no mutation by an ambiguous short id may change either item", async () => {
  await withStore(seed);
  const short = shortId(uuidA);
  const repo = new LocalTodoRepository();
  const ctx = { agent: "test", session: null, deviceId: "device-1", deviceName: "TestBox" };

  const before = await readStore();
  const snapshot = JSON.stringify(before.todos);

  for (const attempt of [
    () => repo.complete(short, ctx),
    () => repo.edit(short, { title: "renamed by the wrong lookup" }, ctx),
    () => repo.delete(short, ctx),
    () => repo.claim(short, ctx),
  ]) {
    await assert.rejects(attempt, AmbiguousTodoIdError);
  }

  const after = await readStore();
  assert.equal(JSON.stringify(after.todos), snapshot, "an ambiguous id changed the store — this is a silent edit to the wrong item");
});

test("the full uuid still resolves each item unambiguously", async () => {
  await withStore(seed);
  const store = await readStore();
  assert.equal(findTodoByAnyId(store, uuidA)?.uuid, uuidA);
  assert.equal(findTodoByAnyId(store, uuidB)?.uuid, uuidB);
  assert.equal(findTodoByAnyId(store, 1)?.uuid, uuidA, "the local numeric id is unaffected — it was never ambiguous");
});

test("an ordinary short id with exactly one match keeps working", async () => {
  await withStore((store) => {
    seed(store);
    store.todos.pop(); // remove the colliding twin
  });
  const store = await readStore();
  assert.equal(findTodoByAnyId(store, shortId(uuidA))?.uuid, uuidA);
  assert.equal(findTodoByAnyId(store, shortId(uuidA).slice(2))?.uuid, uuidA, "the T- prefix stays optional");
});
