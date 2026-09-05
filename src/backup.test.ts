import assert from "node:assert/strict";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Builds a backup file by hand (same wire format as backup.ts's own createBackup, but with
// attacker-chosen `files` keys) — a backup is self-encrypted, so a hostile bundle is
// trivially constructible by anyone who knows the format; this is exactly the
// capability a real attacker handing someone a crafted ".backup" file would have.
function buildRawBackup(password: string, files: Record<string, string>): Buffer {
  const plaintext = JSON.stringify({ magic: "docket-backup-v1", createdAt: new Date().toISOString(), files });
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N: 2 ** 14, r: 8, p: 1 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const header = Buffer.from(JSON.stringify({ magic: "docket-backup-v1", salt: salt.toString("base64"), iv: iv.toString("base64") }), "utf8");
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32BE(header.length);
  return Buffer.concat([headerLen, header, authTag, ciphertext]);
}

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-backup-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { createBackup, isBackupFile, restoreBackup } = await import("./backup.js");

test.after(async () => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

test("createBackup/restoreBackup: round-trips real data-directory files (device.json, key, todos.json.enc) and restore renames prior files aside as .bak", async () => {
  await writeFile(join(dataDirectory, "device.json"), JSON.stringify({ id: "device-1", name: "TestBox" }));
  await writeFile(join(dataDirectory, "key"), Buffer.from("0123456789abcdef0123456789abcdef", "hex"));
  await writeFile(join(dataDirectory, "todos.json.enc"), Buffer.from("fake-ciphertext-bytes"));

  const bundle = await createBackup("correct horse battery staple");
  assert.ok(isBackupFile(bundle));
  assert.equal(isBackupFile(Buffer.from("not a backup at all")), false);

  // Simulate the live files having since changed, to prove restore renames them aside rather than clobbering silently.
  await writeFile(join(dataDirectory, "device.json"), JSON.stringify({ id: "device-CHANGED", name: "Overwritten" }));

  const { restoredFiles } = await restoreBackup(bundle, "correct horse battery staple");
  assert.ok(restoredFiles.includes("device.json"));
  assert.ok(restoredFiles.includes("key"));
  assert.ok(restoredFiles.includes("todos.json.enc"));

  const restoredDevice = JSON.parse(await readFile(join(dataDirectory, "device.json"), "utf8"));
  assert.equal(restoredDevice.id, "device-1", "restore must bring back the BACKED-UP identity, not leave the changed one");

  const fs = await import("node:fs/promises");
  const entries = await fs.readdir(dataDirectory);
  assert.ok(entries.some((e) => e.startsWith("device.json.pre-restore-") && e.endsWith(".bak")), "the overwritten device.json must be preserved as a .bak, not deleted");
});

test("restoreBackup: the wrong password is rejected with a clear error, not silent garbage", async () => {
  await writeFile(join(dataDirectory, "device.json"), JSON.stringify({ id: "device-2" }));
  const bundle = await createBackup("right-password");
  await assert.rejects(() => restoreBackup(bundle, "wrong-password"), /wrong password/);
});

test("restoreBackup: a file that isn't a docket backup at all is rejected up front", async () => {
  await assert.rejects(() => restoreBackup(Buffer.from("just some random file contents"), "any"), /not a docket backup file/);
});

test("restoreBackup: a path-traversal filename in the bundle's own files map is ignored, not written outside the data directory (regression: a crafted backup could otherwise write arbitrary files, since a backup is self-encrypted — the attacker controls both the plaintext and the password)", async () => {
  const outsideTarget = join(tmpdir(), `docket-restore-escape-${Date.now()}.txt`);
  await rm(outsideTarget, { force: true });
  const malicious = buildRawBackup("pw", {
    "../../../../../../../../tmp/PWNED": Buffer.from("owned").toString("base64"),
    [outsideTarget]: Buffer.from("owned via absolute path").toString("base64"),
    "device.json": Buffer.from(JSON.stringify({ id: "legit" })).toString("base64"), // one legitimate entry, to prove the allowlist doesn't just reject the whole bundle
  });
  const { restoredFiles } = await restoreBackup(malicious, "pw");
  assert.deepEqual(restoredFiles, ["device.json"], "only allowlisted filenames should ever be restored");
  await assert.rejects(() => readFile(outsideTarget), /ENOENT/, "the absolute-path entry must not have been written");
  const fs = await import("node:fs/promises");
  const tmpEntries = await fs.readdir(tmpdir());
  assert.ok(!tmpEntries.includes("PWNED"), "the traversal entry must not have escaped the data directory");
});

test("a server backup carries the device registry, or restoring it locks every client out", async () => {
  /*
   * docs/headless.md tells operators to take exactly this backup before a server upgrade and
   * to restore it if the upgrade goes wrong. `docket serve` keeps its list of authorised
   * devices in devices.json.enc — and that file was not in the bundle.
   *
   * So the documented disaster-recovery path produced a server with the right todos and the
   * right identity, and no memory of which clients were allowed to talk to it: every paired
   * device silently stops authenticating, at the exact moment the operator is already having
   * a bad day. The store survived; the trust state did not.
   */
  await writeFile(join(dataDirectory, "device.json"), '{"id":"server-1"}');
  await writeFile(join(dataDirectory, "key"), "server-key");
  await writeFile(join(dataDirectory, "todos.json.enc"), "todo-bytes");
  await writeFile(join(dataDirectory, "devices.json.enc"), "authorised-devices");

  const bundle = await createBackup("pw");

  // A fresh machine: nothing but the bundle.
  for (const name of ["device.json", "key", "todos.json.enc", "devices.json.enc"]) {
    await rm(join(dataDirectory, name), { force: true });
  }
  const { restoredFiles } = await restoreBackup(bundle, "pw");

  assert.ok(restoredFiles.includes("devices.json.enc"), `devices.json.enc was not restored — got ${restoredFiles.join(", ")}`);
  assert.equal(await readFile(join(dataDirectory, "devices.json.enc"), "utf8"), "authorised-devices");
  // ...alongside the things that already worked, so this is an addition and not a swap.
  assert.equal(await readFile(join(dataDirectory, "todos.json.enc"), "utf8"), "todo-bytes");
  assert.equal(await readFile(join(dataDirectory, "device.json"), "utf8"), '{"id":"server-1"}');
});
