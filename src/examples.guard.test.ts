import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Examples in this repo are made up, and these two tests keep them that way.
 *
 * The skills, the tool descriptions and the docs are written while working on real projects,
 * and the natural example is the one on screen: a real ticket id, a real repo, a colleague's
 * name. Every one of those ships to every user of the plugin. Review catches some of it;
 * these catch the rest.
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TEXT = /\.(ts|mjs|js|md|json|html|yml|yaml|sh|txt)$/;
const SKIP = new Set(["package-lock.json"]);

function trackedTextFiles(): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((f) => f && TEXT.test(f) && !SKIP.has(f) && !f.startsWith("dist/"));
}

function read(file: string): string {
  // latin1, not utf8: one test file deliberately contains a NUL byte, and a decode error
  // would be a worse failure than a slightly mangled line in an assertion message.
  return readFileSync(join(ROOT, file), "latin1");
}

/** Ticket-shaped tokens that are not tickets: algorithm names, standards, sizes. */
const NOT_TICKETS = new Set(["AES", "SHA", "UTF", "ES", "RFC", "ISO", "HMAC", "X", "IPV", "CVE", "GCM", "TLS"]);
/** The reserved example prefixes. Anything else ticket-shaped is somebody's real tracker. */
const EXAMPLE_PREFIXES = new Set(["ACME", "PROJ"]);

test("every ticket-shaped example uses a reserved prefix (ACME-, PROJ-), never a real tracker's", () => {
  const offenders: string[] = [];
  for (const file of trackedTextFiles()) {
    const lines = read(file).split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\b([A-Z][A-Z0-9]{1,9})-\d{2,}\b/g)) {
        if (EXAMPLE_PREFIXES.has(m[1]) || NOT_TICKETS.has(m[1])) continue;
        offenders.push(`${file}:${i + 1}: ${m[0]}`);
      }
    });
  }
  assert.deepEqual(offenders, [], "use ACME-123 or PROJ-123 in examples — a real ticket id ships to every user");
});

/**
 * The personal half, which cannot live in the repo: a list of what must never appear in it
 * is itself a leak. Each contributor keeps theirs outside the checkout — one word or phrase
 * per line, `#` for comments, matched case-insensitively — and `npm test` refuses to pass
 * while any of them is in a tracked file. Without the file (CI, a fresh clone) it is skipped.
 */
const PRIVATE_WORDS = process.env.DOCKET_PRIVATE_WORDS ?? join(homedir(), ".config", "docket", "private-words.txt");

test("no word from the contributor's private list appears in a tracked file", { skip: !existsSync(PRIVATE_WORDS) && `no ${PRIVATE_WORDS}` }, () => {
  const words = readFileSync(PRIVATE_WORDS, "utf8")
    .split("\n")
    .map((w) => w.trim())
    .filter((w) => w && !w.startsWith("#"))
    .map((w) => w.toLowerCase());
  const offenders: string[] = [];
  for (const file of trackedTextFiles()) {
    const lines = read(file).toLowerCase().split("\n");
    lines.forEach((line, i) => {
      for (const word of words) if (line.includes(word)) offenders.push(`${file}:${i + 1}: "${word}"`);
    });
  }
  assert.deepEqual(offenders, [], `private words from ${PRIVATE_WORDS} found in tracked files`);
});
