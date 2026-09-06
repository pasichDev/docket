/**
 * Helpers shared by the adapter unit tests. Test-only — nothing under crew/src outside the
 * tests may import this.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "../types.js";
import { JsonlExtractor } from "./common.js";

/**
 * Locates crew/src/adapters/fixtures both when tests run from the source tree and when they
 * run compiled from a dist directory (fixtures are not copied by tsc): try alongside this
 * module first, then walk upward looking for src/adapters/fixtures.
 */
export function fixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const local = join(here, "fixtures");
  if (existsSync(local)) return local;
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "src", "adapters", "fixtures");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("fixtures directory not found");
}

export function readFixture(name: string): string {
  return readFileSync(join(fixturesDir(), name), "utf8");
}

/**
 * Runs recorded runtime output through the real chunked extractor and a per-turn mapper,
 * exactly the way runTurnProcess does — including flush of a trailing partial line.
 * `chunkSize` deliberately misaligns chunk boundaries with JSON object boundaries.
 */
export function replayThroughMapper(
  rawStream: string,
  mapper: (raw: Record<string, unknown>) => AgentEvent[],
  chunkSize = 7,
): AgentEvent[] {
  const extractor = new JsonlExtractor();
  const events: AgentEvent[] = [];
  const buffer = Buffer.from(rawStream, "utf8");
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    for (const raw of extractor.feed(buffer.subarray(offset, offset + chunkSize))) {
      events.push(...mapper(raw));
    }
  }
  for (const raw of extractor.flush()) events.push(...mapper(raw));
  return events;
}
