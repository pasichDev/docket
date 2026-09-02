import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 30;
const LOCK_TIMEOUT_MS = 5_000;

async function acquireLock(lockPath: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Another process's lock — reap it if it's stale (crashed holder).
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // lock disappeared between EEXIST and stat — retry immediately
      }
      if (Date.now() > deadline) {
        throw new Error(`todo-mcp: timed out waiting for lock at ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

/**
 * Cross-process advisory file lock (a `<path>.lock` sentinel file, reaped if
 * its holder crashed) so concurrent processes touching the same file — e.g.
 * one todo-mcp instance per MCP host session, or a sync tick racing a human
 * clicking Approve — can't interleave a read-modify-write and silently drop
 * each other's changes.
 */
export async function withFileLock<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T> {
  await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath);
  }
}
