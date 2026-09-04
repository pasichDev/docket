import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-migration-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { decryptFromBuffer, encryptToBuffer } = await import("./crypto.js");
const { CURRENT_FORMAT_VERSION, migrateLegacyFields, readStore } = await import("./storage.js");

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

/**
 * A v7 record exactly as a real install has it on disk: no `localSeq`, no `workspace`,
 * every other field present. Built through the real encryption path rather than by hand-
 * editing a JSON file, so this exercises the same bytes a v7 → v8 upgrade actually reads.
 */
function v7Todo(id: number, uuid: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    uuid,
    title: `item ${id}`,
    description: null,
    done: false,
    list: "todo",
    category: null,
    priority: null,
    dueDate: null,
    sourceUrl: null,
    agent: "claude-code",
    session: "sess",
    workingAgent: null,
    workingSince: null,
    workingSession: null,
    workingLeaseExpiresAt: null,
    workingDeviceId: null,
    createdAt,
    updatedAt: createdAt,
    fieldTimestamps: {},
    completedAt: null,
    revision: 1,
    deviceId: "device-a",
    deviceName: "A",
    history: [{ at: createdAt, agent: "claude-code", deviceName: "A", action: "created", detail: `title: "item ${id}"` }],
    ...extra,
  };
}

const V7_STORE = {
  formatVersion: 7,
  nextId: 4,
  todos: [
    // Deliberately NOT in creation order on disk: array order reflects nothing in
    // particular, so the migration must not depend on it.
    v7Todo(2, "bbbbbbbb-0000-0000-0000-000000000002", "2026-01-02T00:00:00.000Z"),
    v7Todo(1, "aaaaaaaa-0000-0000-0000-000000000001", "2026-01-01T00:00:00.000Z"),
    v7Todo(3, "cccccccc-0000-0000-0000-000000000003", "2026-01-03T00:00:00.000Z", { done: true, completedAt: "2026-01-04T00:00:00.000Z" }),
  ],
  deletedUuids: [{ uuid: "dddddddd-0000-0000-0000-000000000004", deletedAt: "2026-01-05T00:00:00.000Z", deviceId: "device-a" }],
};

await writeFile(join(dataDirectory, "todos.json.enc"), await encryptToBuffer(JSON.stringify(V7_STORE, null, 2)), { mode: 0o600 });
await migrateLegacyFields(); // the one locked startup write that persists the migration

test("migration v7 → v8: every item and tombstone survives, unchanged apart from the new fields", async () => {
  const store = await readStore();
  assert.equal(store.formatVersion, CURRENT_FORMAT_VERSION);
  assert.equal(store.nextId, 4, "the local id counter is not disturbed");
  assert.equal(store.todos.length, 3);
  assert.equal(store.deletedUuids.length, 1);

  for (const original of V7_STORE.todos) {
    const migrated = store.todos.find((t) => t.uuid === original.uuid);
    assert.ok(migrated, `item ${original.uuid} was lost in migration`);
    assert.equal(migrated.title, original.title);
    assert.equal(migrated.createdAt, original.createdAt);
    assert.equal(migrated.updatedAt, original.updatedAt);
    assert.equal(migrated.done, original.done);
    assert.equal(migrated.agent, original.agent);
    assert.equal(migrated.revision, original.revision);
    assert.deepEqual(migrated.history, original.history);
  }
});

test("migration v7 → v8: localSeq is assigned in creation order, not on-disk array order", async () => {
  const store = await readStore();
  const seqOf = (uuid: string) => store.todos.find((t) => t.uuid === uuid)!.localSeq;

  assert.equal(seqOf("aaaaaaaa-0000-0000-0000-000000000001"), 1);
  assert.equal(seqOf("bbbbbbbb-0000-0000-0000-000000000002"), 2);
  assert.equal(seqOf("cccccccc-0000-0000-0000-000000000003"), 3);
  assert.equal(store.deletedUuids[0].localSeq, 4, "tombstones continue the same counter, after the todos");
  assert.equal(store.seqCounter, 4, "the high-water mark is the highest number handed out");
});

test("migration v7 → v8: legacy items get workspace null rather than a guess", async () => {
  const store = await readStore();
  for (const t of store.todos) assert.equal(t.workspace, null);
});

test("migration v7 → v8: is idempotent — a second load hands out no new numbers", async () => {
  const first = await readStore();
  await migrateLegacyFields();
  const second = await readStore();
  assert.equal(second.seqCounter, first.seqCounter);
  assert.deepEqual(
    second.todos.map((t) => [t.uuid, t.localSeq]),
    first.todos.map((t) => [t.uuid, t.localSeq]),
  );
});

/**
 * `docket restore` puts an older store back, taking its lower sequence counter with it.
 * Every peer's cursor then sits ABOVE the new high-water mark, so nothing this device says
 * is delivered again — a failure mode v8's counter introduces, on the exact path
 * CHANGELOG.md recommends for rolling back. The epoch is what lets a peer notice, and it
 * lives outside both the store and the backup so that restoring onto NEW hardware (which
 * brings paired peers back with it) mints a fresh one too.
 */
test("restoring re-mints the store epoch, so peers know their cursors are void", async () => {
  const { getStoreEpoch, resetStoreEpoch } = await import("./storage.js");
  const { readFile } = await import("node:fs/promises");

  const before = await getStoreEpoch();
  assert.match(before, /^[0-9a-f-]{36}$/);
  assert.equal(await getStoreEpoch(), before, "stable across reads — it identifies an incarnation, not a moment");
  assert.equal((await readFile(join(dataDirectory, "store-epoch"), "utf8")).trim(), before);

  await resetStoreEpoch();
  const after = await getStoreEpoch();
  assert.notEqual(after, before, "a bulk replacement must produce a different incarnation");
});

/**
 * The downgrade trap this backup exists for: v2.3.1's `saveStore` serialises from its own
 * v7 type shape, so its FIRST write after a reinstall strips `localSeq`, `workspace` and
 * `seqCounter` from every item — silently. A later re-upgrade then hands out fresh sequence
 * numbers and every paired peer's cursor means something different. 2.3.1 cannot be
 * patched, so the only defence is keeping the pre-migration bytes.
 */
test("migration v7 → v8: the pre-migration store is copied aside, byte-for-byte", async () => {
  const { readFile } = await import("node:fs/promises");
  const backup = await readFile(join(dataDirectory, "todos.v7-pre-upgrade.enc"));
  assert.ok(backup.length > 0, "no pre-upgrade backup was written");

  // Byte-equal to the v7 file as it was on disk before the migration — not a re-encryption
  // of the same content, which would decrypt to v8 fields under a fresh IV.
  assert.deepEqual(JSON.parse(await decryptFromBuffer(backup)), V7_STORE);
});

test("migration v7 → v8: a second startup never overwrites the backup", async () => {
  const { readFile, writeFile } = await import("node:fs/promises");
  const first = await readFile(join(dataDirectory, "todos.v7-pre-upgrade.enc"));

  // Put a v7 store back and migrate again. The backup must still hold the ORIGINAL bytes:
  // overwriting it with a later copy is exactly how the safety net gets quietly removed.
  await writeFile(join(dataDirectory, "todos.json.enc"), await encryptToBuffer(JSON.stringify({ ...V7_STORE, nextId: 99 })), { mode: 0o600 });
  await migrateLegacyFields();

  assert.deepEqual(await readFile(join(dataDirectory, "todos.v7-pre-upgrade.enc")), first);
  assert.equal(JSON.parse(await decryptFromBuffer(first)).nextId, 4, "still the first migration's bytes, not the second's");
});

test("restore --from-v7 puts the v7 store back and moves the v8 one aside", async () => {
  const { restorePreUpgradeStore } = await import("./storage.js");
  const { readFile, stat } = await import("node:fs/promises");

  const restored = await restorePreUpgradeStore();
  assert.ok(restored, "there is a pre-upgrade backup, so this must succeed");
  assert.ok((await stat(restored.movedAside)).isFile(), "the v8 store is moved aside, never deleted");

  const onDisk = JSON.parse(await decryptFromBuffer(await readFile(join(dataDirectory, "todos.json.enc"))));
  assert.equal(onDisk.formatVersion, 7, "2.x must find a store it can actually read");
  assert.equal(onDisk.todos[0].localSeq, undefined, "and one with none of the v8 fields it would strip");
});
