import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, stat, type FileHandle } from "node:fs/promises";
import type { CrewEvent, CrewEventType } from "./types.js";

/**
 * events.jsonl + the in-process bus (spec §32).
 *
 * emit() persists first, fans out second: the Team Feed's history and its live stream are
 * the same log, so a subscriber can never see an event that a crash would erase. Appends are
 * serialized through an internal queue — one writer, whole lines, no interleaving.
 *
 * Subscriber callbacks run isolated: one throwing listener (a closed SSE socket, say) must
 * not take down the daemon or starve the others.
 *
 * Two properties this file is now responsible for, both learned the hard way:
 *
 *   1. READING THE LOG MUST NOT COST THE WHOLE LOG. readRecent() used to `readFile()` the
 *      entire file to hand back the last 50 lines. Every SSE connect (the Office reconnects
 *      about once every 15 s while it is open) paid that, blocking the event loop — and past
 *      ~512 MB `readFile(…, "utf8")` throws `RangeError: Invalid string length`, which took
 *      the daemon down and orphaned every runtime child with it. It now scans backwards from
 *      EOF and reads only the bytes it needs.
 *
 *   2. THE LOG MUST NOT GROW FOREVER. Rotation at EVENTS_ROTATE_BYTES keeps at most two
 *      files (`events.jsonl` + `events.jsonl.1`), and readRecent() reads across the seam so
 *      a rotation never blanks the Team Feed.
 *
 * And a failure rule: an unwritable log (full disk, EISDIR, read-only mount) DEGRADES — it
 * is reported loudly on stderr and through `degraded`/`droppedEvents`, the event still
 * reaches live subscribers, and supervision of every running agent survives. Taking the
 * daemon down because a log line could not be appended would lose far more than the line.
 */

export type EventListener = (event: CrewEvent) => void;

/** Roll over to `<file>.1` once the live log passes this. Overridable for tests. */
export const EVENTS_ROTATE_BYTES = 32 * 1024 * 1024;

/** Backwards read granularity, and the hard ceiling on how much of a tail we will scan. */
const TAIL_CHUNK_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;

export class EventBus {
  private readonly subscribers = new Set<EventListener>();
  private writeQueue: Promise<void> = Promise.resolve();
  /** Bytes in the live log; null means "unknown, stat before the next append". */
  private liveBytes: number | null = null;
  private degradedReason: string | null = null;
  private dropped = 0;

  constructor(
    private readonly file: string,
    private readonly rotateBytes: number = EVENTS_ROTATE_BYTES,
  ) {}

  /** Build a well-formed event (id + timestamp) without emitting it. */
  makeEvent(type: CrewEventType, fields: Omit<CrewEvent, "id" | "type" | "at"> = {}): CrewEvent {
    return { id: randomUUID(), type, at: new Date().toISOString(), ...fields };
  }

  /**
   * Persist to events.jsonl, then fan out to subscribers. Resolves once the line is on disk —
   * or once the append has definitively failed, which is reported through `degraded` rather
   * than thrown: see the file header.
   */
  async emit(event: CrewEvent): Promise<CrewEvent> {
    const line = JSON.stringify(event) + "\n";
    const write = this.writeQueue.then(() => this.append(line));
    this.writeQueue = write.catch(() => {});
    await write;
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // A broken listener is its own problem; the log already has the event.
      }
    }
    return event;
  }

  /** Shorthand: build and emit in one call. */
  async publish(type: CrewEventType, fields: Omit<CrewEvent, "id" | "type" | "at"> = {}): Promise<CrewEvent> {
    return this.emit(this.makeEvent(type, fields));
  }

  subscribe(listener: EventListener): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Non-null while the log is unwritable: the reason, for /api/health and the operator. */
  get degraded(): string | null {
    return this.degradedReason;
  }

  /** How many events failed to reach the log in this process. */
  get droppedEvents(): number {
    return this.dropped;
  }

  /**
   * Last `n` events from the log, read from the TAIL — the log is the durable record so this
   * must come from disk, but nothing here may depend on the log's total size. Unparseable
   * lines (a torn final line from a crash mid-append) are skipped, never fatal.
   */
  async readRecent(n: number): Promise<CrewEvent[]> {
    if (!Number.isFinite(n) || n <= 0) return [];
    const live = await readTailEvents(this.file, n);
    if (live.length >= n) return live.slice(-n);
    // Straddle a rotation so the feed does not go blank the moment the log rolls over.
    const older = await readTailEvents(rotatedPath(this.file), n - live.length);
    return [...older, ...live].slice(-n);
  }

  /** One append, with rotation and degradation. Never rejects. */
  private async append(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line, "utf8");
    try {
      if (this.liveBytes === null) this.liveBytes = await fileSize(this.file);
      if (this.liveBytes > 0 && this.liveBytes + bytes > this.rotateBytes) await this.rotate();
      // 0600: the log carries prompts, results and agent output — the same trust level as
      // state.json, which has always been 0600. Mode applies on creation only.
      await appendLineNoFollow(this.file, line);
      this.liveBytes += bytes;
      if (this.degradedReason) {
        console.error(`crew: ${this.file} is writable again (${this.dropped} event(s) were lost)`);
        this.degradedReason = null;
      }
    } catch (err) {
      this.liveBytes = null; // force a re-stat once the disk comes back
      this.dropped += 1;
      const reason = (err as Error).message;
      if (this.degradedReason !== reason) {
        this.degradedReason = reason;
        console.error(
          `crew: cannot append to ${this.file}: ${reason} — the daemon keeps running and keeps supervising, ` +
            `but the event log is now INCOMPLETE. Fix the path/disk; events are still streamed live.`,
        );
      }
    }
  }

  /**
   * Roll the live log aside, keeping exactly one generation. What was in `<file>.1` before is
   * gone — say so, because the log is the durable record and quietly discarding the oldest
   * part of it is the kind of loss this codebase refuses to allow to be silent.
   */
  private async rotate(): Promise<void> {
    await rename(this.file, rotatedPath(this.file));
    console.error(
      `crew: ${this.file} passed ${this.rotateBytes} bytes — rotated to ${rotatedPath(this.file)}. ` +
        `One generation is kept; anything older than the previous ${rotatedPath(this.file)} is now gone.`,
    );
    this.liveBytes = 0;
  }
}

function rotatedPath(file: string): string {
  return `${file}.1`;
}

/**
 * One append that REFUSES A SYMLINK at the log's own path.
 *
 * `appendFile(file, …)` opens with flag 'a' = O_APPEND|O_CREAT|O_WRONLY, which follows
 * symlinks. Crew's realistic adversary is an agent it spawned — same uid, a shell — and this
 * log carries prompts, agent output and results: an attacker who plants
 * `events.jsonl -> <somewhere the user can write>` gets the daemon to stream all of that
 * wherever it likes, and to keep doing so for the life of the crew. O_NOFOLLOW makes the open
 * fail with ELOOP instead, which the caller already handles the way it handles a full disk:
 * the daemon keeps supervising, `degraded` says the log is incomplete, and the event still
 * reaches live subscribers. Nothing to be gained by dying; nothing to be gained by obeying.
 *
 * O_NOFOLLOW covers the FINAL component only. A symlinked crew home is a different problem and
 * not one this call can solve — the root is created by ensureCrewTree at 0700.
 */
async function appendLineNoFollow(file: string, line: string): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(line, "utf8");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

/**
 * The last `n` events of one log file, reading backwards in chunks from EOF.
 *
 * Reads at most TAIL_MAX_BYTES, so a log with one pathological 4 GB "line" costs a bounded
 * read rather than the process. When the scan does not reach byte 0 the first line in the
 * buffer is a fragment — and, worse, could split a multi-byte UTF-8 character — so it is
 * dropped before decoding.
 */
async function readTailEvents(file: string, n: number): Promise<CrewEvent[]> {
  let handle: FileHandle;
  try {
    handle = await open(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return [];
    const chunks: Buffer[] = [];
    let pos = size;
    let newlines = 0;
    let read = 0;
    while (pos > 0 && newlines <= n && read < TAIL_MAX_BYTES) {
      const length = Math.min(TAIL_CHUNK_BYTES, pos);
      pos -= length;
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, pos);
      chunks.unshift(buffer);
      read += length;
      for (let i = 0; i < buffer.length; i++) if (buffer[i] === NEWLINE) newlines += 1;
    }
    let tail = Buffer.concat(chunks);
    if (pos > 0) {
      const firstNewline = tail.indexOf(NEWLINE);
      tail = firstNewline === -1 ? Buffer.alloc(0) : tail.subarray(firstNewline + 1);
    }
    return parseEventLines(tail.toString("utf8")).slice(-n);
  } finally {
    await handle.close().catch(() => {});
  }
}

function parseEventLines(text: string): CrewEvent[] {
  const events: CrewEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CrewEvent;
      if (parsed && typeof parsed.id === "string" && typeof parsed.type === "string") events.push(parsed);
    } catch {
      // torn or foreign line — skip
    }
  }
  return events;
}
