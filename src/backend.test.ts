import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HistoryEntry } from "./history.js";
import type {
  ClaimOptions,
  ClaimResult,
  CreateTodoInput,
  MutationContext,
  RepositoryHealth,
  SnapshotImportResult,
  TodoId,
  TodoQuery,
  TodoRepository,
} from "./repository.js";
import type { WorkspaceSnapshot } from "./snapshot.js";
import type { Todo } from "./types.js";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-backend-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;

// Same reason repository.test.ts does this: storage.ts resolves its on-disk paths from
// DOCKET_DATA_DIR at module-load time via a top-level await, so DOCKET_DATA_DIR must be
// set before this dynamic import, not before a static one.
const { transferWorkspace } = await import("./backend.js");
const { LocalTodoRepository } = await import("./repository.js");
const snapshotModule = await import("./snapshot.js");
const { applySnapshot, buildSnapshot, SnapshotFormatError } = snapshotModule;
// Named with its own type annotation: an `asserts` signature is only usable through a
// binding TypeScript can see the assertion on, which a destructured const is not.
const assertUsableSnapshot: (value: unknown) => asserts value is WorkspaceSnapshot = snapshotModule.assertUsableSnapshot;
const { withStore } = await import("./storage.js");

test.after(async () => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

function context(): MutationContext {
  return { agent: "docket-migration", session: null, deviceId: "device-1", deviceName: "TestBox" };
}

/**
 * A destination that behaves like a real one for the properties under test — idempotent by
 * migration id and by uuid — and can be told to fail partway through, which is the case the
 * per-item loop this replaces could not survive.
 */
class FakeTargetRepository implements TodoRepository {
  readonly store = new Map<string, Todo>();
  readonly appliedMigrations = new Map<string, Omit<SnapshotImportResult, "alreadyApplied">>();
  /** Set to make the next import throw after accepting this many items. */
  failAfter: number | null = null;
  importCalls = 0;
  private nextId = 1;

  async list(_query: TodoQuery): Promise<Todo[]> {
    return [...this.store.values()];
  }
  async get(id: TodoId): Promise<Todo | null> {
    return [...this.store.values()].find((t) => t.id === Number(id)) ?? null;
  }
  async create(_input: CreateTodoInput, _context: MutationContext): Promise<Todo> {
    throw new Error("a snapshot transfer must not go through create()");
  }
  async edit(): Promise<Todo> {
    throw new Error("not exercised");
  }
  async complete(): Promise<Todo> {
    throw new Error("not exercised");
  }
  async delete(): Promise<Todo> {
    throw new Error("not exercised");
  }
  async claim(_id: TodoId, _context: MutationContext, _options?: ClaimOptions): Promise<ClaimResult> {
    throw new Error("not exercised");
  }
  async release(): Promise<Todo> {
    throw new Error("not exercised");
  }
  async history(_id: TodoId): Promise<HistoryEntry[]> {
    return [];
  }
  async health(): Promise<RepositoryHealth> {
    return { ok: true, formatVersion: 8, todoCount: this.store.size };
  }
  async exportSnapshot(migrationId?: string): Promise<WorkspaceSnapshot> {
    return buildSnapshot(
      { formatVersion: 8, nextId: this.nextId, todos: [...this.store.values()], deletedUuids: [], seqCounter: 0 },
      {},
      "fake-device",
      migrationId,
    );
  }
  async importSnapshot(snapshot: WorkspaceSnapshot): Promise<SnapshotImportResult> {
    this.importCalls += 1;
    assertUsableSnapshot(snapshot);
    const already = this.appliedMigrations.get(snapshot.migrationId);
    if (already) return { ...already, alreadyApplied: true };

    let imported = 0;
    let alreadyPresent = 0;
    for (const item of snapshot.items) {
      if (this.store.has(item.uuid)) {
        alreadyPresent += 1;
        continue;
      }
      if (this.failAfter !== null && imported >= this.failAfter) {
        // A dropped connection: some of it landed, the caller is told nothing about which.
        throw new Error("connection reset by peer");
      }
      this.store.set(item.uuid, { ...item, id: this.nextId++, localSeq: this.nextId, history: snapshot.history?.[item.uuid] ?? [] } as Todo);
      imported += 1;
    }
    const result = { migrationId: snapshot.migrationId, appliedAt: new Date().toISOString(), imported, alreadyPresent, tombstones: 0 };
    this.appliedMigrations.set(snapshot.migrationId, result);
    return { ...result, alreadyApplied: false };
  }
}

/* ==========================================================================================
 * What a migration has to preserve
 * ========================================================================================== */

test("transferWorkspace: an empty source transfers nothing (checked first — the on-disk store is shared across this file)", async () => {
  const target = new FakeTargetRepository();
  const result = await transferWorkspace(new LocalTodoRepository(), target);
  assert.equal(result.imported, 0);
  assert.equal(target.store.size, 0);
});

test("transferWorkspace: identity, project, chronology and history all survive the move", async () => {
  const source = new LocalTodoRepository();
  const ctx = context();
  const open = await source.create({ title: "Open item", category: "work", priority: "high" }, ctx);
  const doneItem = await source.create({ title: "Done item", description: "desc", list: "backlog", sourceUrl: "https://example.com/x" }, ctx);
  await source.complete(doneItem.id, ctx);
  // A project, which is what v3 is actually about, and which the old copy dropped entirely.
  await withStore((store) => {
    for (const todo of store.todos) todo.workspace = "acme/backend";
  });

  const target = new FakeTargetRepository();
  const result = await transferWorkspace(source, target);
  assert.equal(result.imported, 2);

  const before = await source.list({ filter: "all", list: "all" });
  const after = await target.list({ filter: "all", list: "all" });
  const byTitle = (todos: Todo[]): Map<string, Todo> => new Map(todos.map((t) => [t.title, t]));
  const src = byTitle(before);
  const dst = byTitle(after);

  for (const title of ["Open item", "Done item"]) {
    const a = src.get(title)!;
    const b = dst.get(title)!;
    assert.equal(b.uuid, a.uuid, `${title}: a migration that changes uuids looks to every paired device like a delete plus an unrelated create`);
    assert.equal(b.workspace, "acme/backend", `${title}: the project was dropped — in v3 that means the item lands in Unfiled`);
    assert.equal(b.createdAt, a.createdAt, `${title}: the chronology was rewritten to today`);
    assert.equal(b.updatedAt, a.updatedAt);
    assert.equal(b.revision, a.revision);
    assert.equal(b.deviceId, a.deviceId, `${title}: provenance was lost`);
    assert.equal(b.done, a.done);
    assert.equal(b.completedAt, a.completedAt);
    assert.ok((b.history?.length ?? 0) >= (a.history?.length ?? 0), `${title}: the audit log did not travel`);
  }
  assert.equal(dst.get("Open item")?.category, "work");
  assert.equal(dst.get("Open item")?.priority, "high");
  assert.equal(dst.get("Done item")?.description, "desc");
  assert.equal(dst.get("Done item")?.list, "backlog");
  assert.equal(dst.get("Done item")?.sourceUrl, "https://example.com/x");
  assert.equal(open.uuid, dst.get("Open item")?.uuid);
});

test("transferWorkspace: a claim does not travel, because the process holding it did not", async () => {
  const source = new LocalTodoRepository();
  const ctx = context();
  const item = await source.create({ title: "Claimed item" }, ctx);
  await source.claim(item.id, ctx);

  const target = new FakeTargetRepository();
  await transferWorkspace(source, target);
  const moved = [...target.store.values()].find((t) => t.title === "Claimed item")!;
  assert.equal(moved.workingAgent ?? null, null, "a stale claim would block work on a workspace that was just migrated so someone could start working on it");
  assert.equal(moved.workingDeviceId ?? null, null);
  assert.equal(moved.workingLeaseExpiresAt ?? null, null);
});

/* ==========================================================================================
 * What a migration has to survive
 * ========================================================================================== */

test("transferWorkspace: a transfer that dies halfway converges on exactly one copy when retried", async () => {
  const source = new LocalTodoRepository();
  const before = (await source.list({ filter: "all", list: "all" })).length;
  assert.ok(before >= 3, `premise broken: only ${before} items to move`);

  const target = new FakeTargetRepository();
  target.failAfter = 1; // the connection dies after the first item
  const migrationId = "migration-under-test";
  await assert.rejects(() => transferWorkspace(source, target, migrationId), /connection reset/);
  assert.equal(target.store.size, 1, "premise broken: the failure should have left a partial workspace");

  // The retry, with the same migration id — which is what running the command again does.
  target.failAfter = null;
  const first = await transferWorkspace(source, target, migrationId);
  assert.equal(target.store.size, before, "the retry must finish what the failed attempt started");
  assert.equal(first.imported + first.alreadyPresent, before);

  // And a THIRD run, after the migration completed, must not copy anything again.
  const second = await transferWorkspace(source, target, migrationId);
  assert.equal(second.alreadyApplied, true, "a completed migration must be recognised as already applied");
  assert.equal(target.store.size, before, "re-running a completed migration duplicated the workspace");

  const uuids = [...target.store.values()].map((t) => t.uuid);
  assert.equal(new Set(uuids).size, uuids.length, "the destination holds more than one copy of some item");
});

/* ==========================================================================================
 * The snapshot itself
 * ========================================================================================== */

test("applySnapshot: importing the same snapshot twice adds nothing the second time", () => {
  const source = { formatVersion: 8, nextId: 3, seqCounter: 9, deletedUuids: [], todos: [] } as Parameters<typeof buildSnapshot>[0];
  source.todos.push({ uuid: "u-1", title: "one", workspace: "proj", history: [] } as unknown as Todo);
  source.todos.push({ uuid: "u-2", title: "two", workspace: "proj", history: [] } as unknown as Todo);
  const snapshot = buildSnapshot(source, {}, "device-a");

  const destination = { formatVersion: 8, nextId: 1, seqCounter: 0, deletedUuids: [], todos: [] } as Parameters<typeof buildSnapshot>[0];
  const first = applySnapshot(destination, snapshot);
  const second = applySnapshot(destination, snapshot);

  assert.equal(first.imported, 2);
  assert.equal(second.imported, 0);
  assert.equal(second.alreadyPresent, 2);
  assert.equal(destination.todos.length, 2);
  assert.deepEqual(destination.todos.map((t) => t.localSeq).sort(), [1, 2], "the destination must assign its OWN sequence numbers");
});

test("applySnapshot: a tombstone in the snapshot removes the item rather than being ignored", () => {
  const destination = { formatVersion: 8, nextId: 1, seqCounter: 0, deletedUuids: [], todos: [] } as Parameters<typeof buildSnapshot>[0];
  destination.todos.push({ uuid: "gone", title: "deleted upstream", history: [] } as unknown as Todo);

  const source = { formatVersion: 8, nextId: 1, seqCounter: 0, todos: [], deletedUuids: [{ uuid: "gone", deletedAt: "2026-01-01T00:00:00.000Z", deviceId: "device-a", localSeq: 4 }] } as Parameters<typeof buildSnapshot>[0];
  applySnapshot(destination, buildSnapshot(source, {}, "device-a"));

  assert.equal(destination.todos.length, 0, "a migration that ignores tombstones resurrects deleted work");
  assert.equal(destination.deletedUuids.length, 1);
});

test("applySnapshot: an item this side has already deleted is not resurrected by a migration", () => {
  const destination = { formatVersion: 8, nextId: 1, seqCounter: 0, todos: [], deletedUuids: [{ uuid: "u-1", deletedAt: "2026-02-01T00:00:00.000Z", deviceId: "device-b", localSeq: 1 }] } as Parameters<typeof buildSnapshot>[0];
  const source = { formatVersion: 8, nextId: 1, seqCounter: 0, deletedUuids: [], todos: [{ uuid: "u-1", title: "deleted here", history: [] } as unknown as Todo] } as Parameters<typeof buildSnapshot>[0];

  const result = applySnapshot(destination, buildSnapshot(source, {}, "device-a"));
  assert.equal(result.imported, 0);
  assert.equal(destination.todos.length, 0, "a migration is not a merge and does not get to overrule a deletion");
});

test("a snapshot from a newer docket is refused rather than partially applied", () => {
  const source = { formatVersion: 8, nextId: 1, seqCounter: 0, deletedUuids: [], todos: [] } as Parameters<typeof buildSnapshot>[0];
  const snapshot = buildSnapshot(source, {}, "device-a");
  const fromTheFuture = { ...snapshot, snapshotFormat: 99, contentHash: undefined };
  assert.throws(() => assertUsableSnapshot(fromTheFuture), SnapshotFormatError);
  assert.throws(() => assertUsableSnapshot(fromTheFuture), /upgrade docket on this side/);
});

test("a snapshot that does not match its own content hash is refused", () => {
  const source = { formatVersion: 8, nextId: 1, seqCounter: 0, deletedUuids: [], todos: [{ uuid: "u-1", title: "original", history: [] } as unknown as Todo] } as Parameters<typeof buildSnapshot>[0];
  const snapshot = buildSnapshot(source, {}, "device-a");
  snapshot.items[0].title = "altered in transit";
  assert.throws(() => assertUsableSnapshot(snapshot), /does not match its own content hash/);
});
