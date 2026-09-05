import { randomUUID } from "node:crypto";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The two filesystem primitives every persistent write in Docket goes through.
 *
 * Both exist because "temp file + rename" is an ATOMICITY guarantee and was being relied on
 * as a DURABILITY one. Rename means a reader never sees a half-written file; it says nothing
 * about whether either the data or the directory entry reached the disk before the power
 * did. Without the fsyncs below, a crash seconds after a successful `withStore` can leave
 * the old contents, the new contents, or — on some filesystems — a rename that landed while
 * the data it points at did not, which is an empty or truncated file where the store was.
 */

/**
 * Write `data` to `path` so that a reader sees either the previous contents or the complete
 * new ones, and so that a successful return survives a power cut.
 *
 * Order matters and each step earns its place:
 *   1. exclusive create of a unique temp — never reuse a name another process may hold;
 *   2. write, then fsync the FILE — the bytes are on the medium, not just in page cache;
 *   3. rename over the target — atomic, so no reader observes a partial file;
 *   4. fsync the DIRECTORY — the rename itself is metadata, and without this the entry can
 *      be lost even though the data was flushed.
 *
 * Step 4 is best-effort: some platforms and filesystems refuse to open a directory for
 * fsync. Failing the whole write because the extra guarantee is unavailable would be worse
 * than the guarantee is valuable, so it is attempted and its failure ignored.
 */
export async function atomicWriteFile(path: string, data: Buffer | string, mode = 0o600): Promise<void> {
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(tmpPath, "wx", mode);
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle?.close().catch(() => {});
    await rm(tmpPath, { force: true });
    throw err;
  }
  await handle.close();

  try {
    await rename(tmpPath, path);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  await syncDirectory(dirname(path));
}

/** Best-effort: makes a completed rename durable. Not every platform allows it. */
export async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Windows, and some network filesystems, cannot fsync a directory handle. The rename
    // already happened; this only sharpens when it becomes durable.
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Create a secret exactly once, even when several fresh processes reach for it at the same
 * instant — and hand every loser the winner's value.
 *
 * The pattern this replaces was: read, and if absent, generate and write. Two processes
 * starting against an empty data directory both read nothing, both generate, and both write
 * — after which each has cached a DIFFERENT value in memory. For the at-rest key that is not
 * a cosmetic race: whichever process wrote last owns the file, and everything the other one
 * encrypts afterwards is unreadable by anyone, including itself after a restart.
 *
 * Exclusive create decides the winner atomically. Losers re-read, and `validate` is what
 * makes the re-read safe: a partially written or truncated file must not be adopted just
 * because it exists.
 */
export async function atomicCreateOrRead(
  path: string,
  generate: () => Buffer,
  validate: (contents: Buffer) => boolean,
  mode = 0o600,
): Promise<Buffer> {
  for (let attempt = 0; attempt < 20; attempt++) {
    // Read first: the overwhelmingly common case is that it already exists.
    const existing = await readIfValid(path, validate);
    if (existing) return existing;

    const candidate = generate();
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "wx", mode);
      await handle.writeFile(candidate);
      await handle.sync();
      await handle.close();
      await syncDirectory(dirname(path));
      return candidate;
    } catch (err) {
      await handle?.close().catch(() => {});
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Someone else won the create. Loop: re-read, and adopt their value.
      await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 5));
    }
  }
  throw new Error(`docket: could not settle on a value for ${path} — it keeps appearing and failing validation`);
}

async function readIfValid(path: string, validate: (contents: Buffer) => boolean): Promise<Buffer | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const contents = await handle.readFile();
    return validate(contents) ? contents : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
