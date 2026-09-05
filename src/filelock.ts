import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { log } from "./log.js";

/** A lock whose mtime hasn't moved in this long is treated as abandoned by a crashed holder. */
export const LOCK_STALE_MS = 10_000;
/** How often a live holder refreshes its lock's mtime. A third of the staleness window, so two consecutive missed beats still don't make a live lock look dead. */
export const LOCK_HEARTBEAT_MS = Math.floor(LOCK_STALE_MS / 3);
const LOCK_RETRY_MS = 30;
const HOSTNAME = hostname(); // resolved once; it cannot change under a running process
const LOCK_TIMEOUT_MS = 5_000;

/**
 * Written into the lock file itself. Costs one small write per acquisition and answers the
 * only question that matters the first time someone reports "docket hung": which process,
 * on which machine, since when.
 */
interface LockHolder {
  /** Distinguishes two acquisitions by the same pid — see reapStaleLock's compare-and-swap. */
  id: string;
  pid: number;
  host: string;
  startedAt: string;
}

/**
 * Which locks the CURRENT async context already holds, and where it took them. Scoped per
 * call chain rather than per process: two independent requests holding two different locks
 * is normal, while one call chain re-entering its own lock is a deadlock waiting to happen.
 *
 * The value is an unformatted Error, not a string. Constructing one is cheap; `.stack`
 * is what forces V8 to materialise and format the trace, and that only happens on the
 * failure path — which by design never runs.
 */
const heldLocks = new AsyncLocalStorage<ReadonlyMap<string, Error>>();

/** The first stack frame outside this file — i.e. whoever asked for the lock. Matched on this module's own URL rather than a filename fragment, so a caller that happens to live in a file with a similar name isn't mistaken for internal machinery. */
function callSite(marker: Error): string {
  const frames = (marker.stack ?? "").split("\n").slice(1);
  const frame = frames.find((f) => f.includes("at ") && !f.includes(import.meta.url));
  return frame?.trim().replace(/^at\s+/, "") ?? "unknown call site";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clears a lock whose holder appears to have died, atomically.
 *
 * The obvious implementation — `rm()` then retry the create — is the bug this replaces: two
 * processes both judge the lock stale, both remove it, and the second one removes the FIRST
 * one's brand-new lock. Both then create their own and both believe they hold it, which
 * costs one of two concurrent read-modify-writes with no error anywhere.
 *
 * `rename` is atomic, so exactly one contender can win it. That alone is not quite enough:
 * between judging the lock stale and renaming it, another process may have reaped it and
 * taken a fresh one, and we would then be renaming a LIVE lock away. So the reap is a
 * compare-and-swap on the holder record — if what we took isn't what we judged, we put it
 * back with `link` (which, unlike rename, refuses to clobber an existing target) and let the
 * caller retry.
 */
async function reapStaleLock(lockPath: string, judged: string | null): Promise<void> {
  const claimPath = `${lockPath}.reap.${randomUUID()}`;
  try {
    await rename(lockPath, claimPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return; // lost the race — someone else reaped it; the acquire loop just tries again
  }

  // Two ways the file we just took can turn out not to be the one we condemned: someone
  // reaped it and took a fresh lock (different holder record), or the original holder woke
  // up and started heartbeating again (same record, fresh mtime). The second is why an
  // identity check alone isn't enough — a suspended laptop resuming looks identical.
  const claimed = await readFile(claimPath, "utf8").catch(() => null);
  const claimedMtime = await stat(claimPath).then((s) => s.mtimeMs).catch(() => 0);
  if (claimed !== judged || Date.now() - claimedMtime <= LOCK_STALE_MS) {
    // Put it back. `link` refuses to clobber, unlike rename, so a third process that has
    // already taken the slot keeps it and we drop ours instead of overwriting theirs.
    await link(claimPath, lockPath).catch(() => {});
    await rm(claimPath, { force: true });
    return;
  }
  await rm(claimPath, { force: true });
  log(`filelock: reaped stale lock ${lockPath} — previous holder ${claimed ?? "unknown (empty lock file)"}`);
}

async function acquireLock(lockPath: string): Promise<string> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const identity: LockHolder = { id: randomUUID(), pid: process.pid, host: HOSTNAME, startedAt: new Date().toISOString() };
  const serialized = JSON.stringify(identity);
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(serialized);
      } finally {
        await handle.close();
      }
      return serialized;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Another process's lock — reap it if its holder looks like it crashed.
      let info;
      let judged: string | null = null;
      try {
        judged = await readFile(lockPath, "utf8");
        info = await stat(lockPath);
      } catch {
        continue; // lock disappeared between EEXIST and the read — retry immediately
      }
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await reapStaleLock(lockPath, judged);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`docket: timed out waiting for lock at ${lockPath} (held by ${judged || "unknown"})`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

/**
 * Removes the lock ONLY if it is still ours.
 *
 * Without the check, a holder whose lock was reaped out from under it (see the residual
 * window in withFileLock's note) would go on to delete whichever process now legitimately
 * holds it — turning one bad reap into an unbounded chain of them. Comparing the holder
 * record makes a stolen lock a local problem for the process that lost it, rather than
 * something it inflicts on everyone after.
 */
async function releaseLock(lockPath: string, identity: string): Promise<void> {
  /*
   * Claim it by RENAME before deciding, rather than read-then-unlink.
   *
   * The obvious version — read the holder record, compare, unlink — has a window between the
   * two: a process suspended after the read can wake to find its lock reaped and a new
   * holder in place, and then unlink THAT holder's lock. One bad reap becomes a chain of
   * them. Rename is atomic and single-winner, so whatever this call moves aside is the file
   * this call is entitled to judge; nobody else can be looking at it any more.
   */
  const claimed = `${lockPath}.releasing.${randomUUID()}`;
  try {
    await rename(lockPath, claimed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // already reaped; nothing owed
    throw err;
  }

  const current = await readFile(claimed, "utf8").catch(() => null);
  if (current !== null && current !== identity) {
    // Not ours after all — put it back for its rightful holder and stay out of it. A failed
    // restore leaves the lock free, which is the same state a reap would have produced.
    log(`filelock: not releasing ${lockPath} — it is now held by someone else (this process's lock was reaped while held)`);
    await rename(claimed, lockPath).catch(async () => {
      await rm(claimed, { force: true });
    });
    return;
  }
  await rm(claimed, { force: true });
}

/**
 * Cross-process advisory file lock (a `<path>.lock` sentinel file, reaped if
 * its holder crashed) so concurrent processes touching the same file — e.g.
 * one docket instance per MCP host session, or a sync tick racing a human
 * clicking Approve — can't interleave a read-modify-write and silently drop
 * each other's changes.
 *
 * While held, the lock's mtime is refreshed on a timer: without that, anything slower than
 * LOCK_STALE_MS (a laptop suspended mid-hold, a network filesystem, a debugger sitting on a
 * breakpoint) has its still-valid lock reaped by the next contender. The timer is unref'd so
 * a held lock can never by itself keep a process alive.
 *
 * What this is NOT: a distributed lock with a proof of exclusion. The reap is a
 * compare-and-swap on the holder record plus a re-check of its age, which closes the window
 * that actually bites (two contenders both judging one abandoned lock stale, and the second
 * deleting the first's fresh one). A narrow window remains: a process suspended past
 * LOCK_STALE_MS — a laptop sleeping, a SIGSTOP — cannot heartbeat, has its lock legitimately
 * reaped, and wakes still inside its own critical section. No check here can help, because
 * it is already in.
 *
 * So the lost race is not prevented, it is DETECTED, one layer up: storage.ts stamps the
 * store file when it reads it and compares that stamp immediately before committing, so a
 * write that lost the lock aborts and retries instead of clobbering. Ordinary optimistic
 * concurrency. This is an advisory lock between cooperating processes on one machine, and a
 * lost race is caught before the write rather than assumed away.
 *
 * Re-entering a lock this call chain already holds throws immediately instead of waiting out
 * the acquire timeout. It cannot succeed either way — the process would be waiting on itself
 * — but a fast, specific failure names the architecture mistake instead of surfacing five
 * seconds later as a mysterious timeout.
 */
export async function withFileLock<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T> {
  const held = heldLocks.getStore();
  const heldAt = held?.get(lockPath);
  const marker = new Error();
  if (heldAt !== undefined) {
    throw new Error(
      `docket: lock ${lockPath} is already held by this call chain (taken at ${callSite(heldAt)}, re-entered at ${callSite(marker)}). ` +
        `A nested read-modify-write can never complete — do the inner work inside the outer callback, which already holds the lock.`,
    );
  }
  const nested = new Map(held ?? []);
  nested.set(lockPath, marker);

  const identity = await acquireLock(lockPath);
  const beat = setInterval(() => {
    // Refresh only while the lock is still ours. Beating on a lock someone else now holds
    // would keep THEIR lock alive past its own holder's death, which is the opposite of
    // what a heartbeat is for.
    void readFile(lockPath, "utf8")
      .then((current) => {
        if (current !== identity) return;
        const now = new Date();
        return utimes(lockPath, now, now);
      })
      .catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  beat.unref();
  try {
    return await heldLocks.run(nested, async () => fn());
  } finally {
    clearInterval(beat);
    await releaseLock(lockPath, identity);
  }
}
