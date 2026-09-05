import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { withFileLock, LeaseLostError, type Lease } from "./filelock.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { log } from "./log.js";

/**
 * The read-modify-write every small encrypted registry needs: peers, server devices,
 * viewers, remote credentials.
 *
 * Each of them used to open-code the same three steps — take the advisory lock, load,
 * write — and each of them was therefore missing the same protection the todo store had.
 * The advisory lock cannot stop a suspended process from being reaped: a laptop that sleeps
 * mid-hold wakes up still inside its critical section, with the lock long since taken over
 * by someone else. storage.ts caught that by comparing the file's content against what it
 * read; the registries simply wrote, and a stale writer would overwrite a newer registry —
 * silently unpairing a device that had just been added, or restoring one that had just been
 * revoked.
 *
 * Two independent guards, for the same reason storage.ts uses two: the LEASE proves the lock
 * is still ours by identity, and the CONTENT HASH proves the bytes are the ones we read,
 * whatever happened to the lock. A losing attempt retries against freshly loaded state
 * rather than failing the caller, because every mutation here is a pure function of the
 * registry it is handed.
 */
const MAX_ATTEMPTS = 3;

async function hashOf(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return null; // absent — "unchanged" then means "still absent"
  }
}

export interface RegistryOptions<T> {
  /** The encrypted file this registry lives in. */
  path: string;
  /** Its lock sentinel. */
  lockPath: string;
  /** Human name, for the log line when a write is abandoned. */
  name: string;
  load: () => Promise<T>;
  /** Must return the exact bytes to commit — serialisation and encryption included. */
  serialize: (value: T) => Promise<Buffer> | Buffer;
}

/**
 * Runs `mutate` against the registry under its lock and commits the result, or retries.
 * Returns whatever `mutate` returned.
 */
export async function withRegistry<T, R>(options: RegistryOptions<T>, mutate: (value: T) => R | Promise<R>): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withFileLock(options.lockPath, async (lease: Lease) => {
        const before = await hashOf(options.path);
        const value = await options.load();
        const result = await mutate(value);
        const bytes = await options.serialize(value);

        // Immediately before the commit, and in this order: identity first because it is the
        // cheaper question, then content because it is the stricter one.
        await lease.assertOwned();
        if ((await hashOf(options.path)) !== before) {
          throw new LeaseLostError(options.lockPath);
        }
        await atomicWriteFile(options.path, bytes);
        return result;
      });
    } catch (err) {
      if (!(err instanceof LeaseLostError) || attempt >= MAX_ATTEMPTS) {
        if (err instanceof LeaseLostError) {
          throw new Error(
            `docket: ${options.name} kept changing underneath this write (${MAX_ATTEMPTS} attempts) — is another docket process stuck?`,
          );
        }
        throw err;
      }
      log(`registry: ${options.name} changed while this process held it — retrying (attempt ${attempt + 1})`);
    }
  }
}
