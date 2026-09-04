import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-corrupt-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { encryptToBuffer, encryptWithKey } = await import("./crypto.js");
const { CURRENT_FORMAT_VERSION, readStore, withStore } = await import("./storage.js");
const { createTodo } = await import("./mutations.js");
const { loadPeers } = await import("./peers.js");
const { readHistoryLog } = await import("./history-store.js");
const { listSessions } = await import("./sessions.js");

const STORE = join(dataDirectory, "todos.json.enc");
const HISTORY = join(dataDirectory, "history.json.enc");
const PEERS = join(dataDirectory, "peers.json.enc");
const SESSIONS = join(dataDirectory, "sessions.json");

test.after(async () => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  await chmod(dataDirectory, 0o700).catch(() => {});
  await rm(dataDirectory, { recursive: true, force: true });
});

/** Puts a real, healthy store on disk so each corruption starts from something valid. */
async function seedStore(): Promise<void> {
  await rm(STORE, { force: true });
  await withStore((store) => {
    createTodo(store, { title: "real data", agent: "codex", session: "s", category: "OPS" }, "device-a", "A");
    createTodo(store, { title: "more real data", agent: "codex", session: "s" }, "device-a", "A");
  });
}

/**
 * The rule every case here checks, stated once: a store that cannot be read must FAIL, not
 * come back half-loaded. A partial load is the dangerous outcome, because the next write
 * persists it — turning a recoverable file into a permanent loss of whatever didn't parse.
 */
async function assertRefusesToLoad(what: string): Promise<void> {
  await assert.rejects(() => readStore(), `${what}: loaded anyway instead of refusing`);
  await assert.rejects(() => withStore(() => {}), `${what}: a write proceeded on top of unreadable data`);
}

test("corrupt store: truncated ciphertext is refused, not partially read", async () => {
  await seedStore();
  const intact = await readFile(STORE);
  await writeFile(STORE, intact.subarray(0, Math.floor(intact.length / 2)));
  await assertRefusesToLoad("truncated");
});

test("corrupt store: a single flipped bit is caught by the auth tag", async () => {
  await seedStore();
  const intact = await readFile(STORE);
  const flipped = Buffer.from(intact);
  flipped[flipped.length - 5] ^= 0x01;
  await writeFile(STORE, flipped);
  await assertRefusesToLoad("bit-flipped");
});

test("corrupt store: ciphertext from a different key is refused", async () => {
  await seedStore();
  await writeFile(STORE, encryptWithKey(randomBytes(32), JSON.stringify({ formatVersion: 8, nextId: 1, todos: [], deletedUuids: [], seqCounter: 0 })));
  await assertRefusesToLoad("wrong key");
});

test("corrupt store: an empty file is refused rather than treated as an empty list", async () => {
  await seedStore();
  await writeFile(STORE, Buffer.alloc(0));
  // The distinction that matters: "no store yet" is an absent FILE. A zero-byte file is a
  // failed write or a truncated copy, and reading it as "you have no todos" would invite the
  // next write to make that true.
  await assertRefusesToLoad("empty file");
});

test("corrupt store: valid encryption wrapping invalid JSON is refused", async () => {
  await seedStore();
  await writeFile(STORE, await encryptToBuffer("{ this is not json"));
  await assertRefusesToLoad("bad JSON");
});

test("corrupt store: a NEWER format version is a hard, explanatory error", async () => {
  await seedStore();
  await writeFile(STORE, await encryptToBuffer(JSON.stringify({ formatVersion: CURRENT_FORMAT_VERSION + 1, nextId: 1, todos: [], deletedUuids: [], seqCounter: 0 })));
  await assert.rejects(
    () => readStore(),
    (err: Error) => {
      // The message has to say what to DO. A process running stale code that guesses at
      // unfamiliar fields is how a downgrade silently strips them.
      assert.match(err.message, new RegExp(`v${CURRENT_FORMAT_VERSION + 1}`));
      assert.match(err.message, /stale code|Rebuild|restart/i, `unhelpful message: ${err.message}`);
      return true;
    },
  );
});

test("corrupt store: an OLDER format version is migrated, not refused", async () => {
  await rm(STORE, { force: true });
  await rm(join(dataDirectory, "todos.v7-pre-upgrade.enc"), { force: true });
  await writeFile(
    STORE,
    await encryptToBuffer(
      JSON.stringify({
        formatVersion: 7,
        nextId: 2,
        todos: [{ id: 1, uuid: "aaaaaaaa-0000-0000-0000-000000000001", title: "old", description: null, done: false, list: "todo", category: null, priority: null, dueDate: null, sourceUrl: null, agent: null, session: null, workingAgent: null, workingSince: null, workingSession: null, workingLeaseExpiresAt: null, workingDeviceId: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", fieldTimestamps: {}, completedAt: null, revision: 1, deviceId: null, deviceName: null, history: [] }],
        deletedUuids: [],
      }),
    ),
  );
  const store = await readStore();
  assert.equal(store.formatVersion, CURRENT_FORMAT_VERSION, "an older store must be readable — that is what migration is for");
  assert.equal(store.todos[0].title, "old");
});

test("corrupt store: a store that cannot be read is left on disk untouched", async () => {
  await seedStore();
  const intact = await readFile(STORE);
  const damaged = Buffer.from(intact);
  damaged[10] ^= 0xff;
  await writeFile(STORE, damaged);

  await assert.rejects(() => withStore(() => {}));
  // The bytes are the only remaining copy of that data. Overwriting them with an empty
  // store — or with a partial parse — is the difference between "restore your backup" and
  // "your data is gone".
  assert.deepEqual(await readFile(STORE), damaged, "the unreadable store was overwritten");
});

test("corrupt history: an unreadable side file is skipped, never overwritten", async () => {
  await seedStore();
  await writeFile(HISTORY, Buffer.from("not encrypted at all"));
  const before = await readFile(HISTORY);

  // History is an audit log, not the source of truth: an unreadable one must not stop the
  // user editing their todos. But it must not be silently replaced either — a transient
  // failure (a wrong key mid-restore) would otherwise become permanent loss.
  assert.deepEqual(await readHistoryLog(), { entries: {}, readable: false });
  await withStore((store) => {
    for (let i = 0; i < 60; i++) createTodo(store, { title: `churn ${i}`, agent: null, session: null }, "device-a", "A");
  });
  assert.deepEqual(await readFile(HISTORY), before, "a flush overwrote a history file it could not read");
});

test("corrupt peers: an unreadable peer list fails loudly rather than syncing with nobody", async () => {
  await writeFile(PEERS, Buffer.from("garbage"));
  // Silently returning an empty list would mean sync just stops, with no error anywhere —
  // the exact failure mode this release exists to remove.
  await assert.rejects(() => loadPeers(), "an unreadable peer list was read as 'no peers'");
  await rm(PEERS, { force: true });
});

test("corrupt sessions: a damaged registry degrades to empty, because it holds nothing durable", async () => {
  for (const contents of ["", "not json", '{"not":"an array"}', "[1,2,3]"]) {
    await writeFile(SESSIONS, contents);
    // The opposite call from peers.json, and deliberately so: this file is a cache of which
    // terminals are open right now. It is rebuilt within one heartbeat, so refusing to list
    // todos because it is damaged would trade something useful for something decorative.
    assert.deepEqual(await listSessions(), [], `contents ${JSON.stringify(contents)} should degrade to empty`);
  }
  await rm(SESSIONS, { force: true });
});

test("unreadable data directory: the error names the file, not just 'EACCES'", async (t) => {
  if (process.getuid?.() === 0) return t.skip("running as root, where permissions do not apply");
  await seedStore();
  await chmod(STORE, 0o000);
  try {
    await assert.rejects(
      () => readStore(),
      (err: NodeJS.ErrnoException) => {
        assert.equal(err.code, "EACCES");
        assert.match(err.message, /todos\.json\.enc/, `the error does not say which file: ${err.message}`);
        return true;
      },
    );
  } finally {
    await chmod(STORE, 0o600);
  }
  assert.ok((await stat(STORE)).size > 0, "the store survived the failed read");
});
