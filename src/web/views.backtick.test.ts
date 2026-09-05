import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Two files are still template literals: the stylesheet and the page markup. Inside one of
 * those, a single unescaped backtick ends the string and everything after it is parsed as
 * TypeScript — which the compiler does report, but as a cascade of errors pointing at
 * whatever text happened to follow, never at the backtick. That cost four separate debugging
 * detours in one sitting, every time in a COMMENT, where a backtick is the natural way to
 * quote an identifier.
 *
 * The client's own code used to need this too, and no longer does: it is real TypeScript now
 * (client/app), so an unbalanced backtick there is an ordinary syntax error with an ordinary
 * position. What remains here is text no compiler can check in any arrangement.
 */
const WEB_DIR = fileURLToPath(new URL(".", import.meta.url).href.replace("/dist/", "/src/"));

const STRING_MODULES = ["client/styles.ts", "client/markup.ts", "views.ts"];

/** Backticks that actually open or close a literal — an escaped one is just a character. */
function unescapedBacktickCount(line: string): number {
  return (line.match(/(^|[^\\])`/g) ?? []).length;
}

const COMMENT_START = /^\s*(\/\/|\*|\/\*)/;

test("no unescaped backtick sits in a comment inside one of the page's string modules", async () => {
  const offenders: string[] = [];

  for (const relative of STRING_MODULES) {
    const source = await readFile(`${WEB_DIR}${relative}`, "utf8");
    let inside = false;
    source.split("\n").forEach((line, index) => {
      const wasInside = inside;
      if (wasInside && COMMENT_START.test(line) && unescapedBacktickCount(line) > 0) {
        offenders.push(`web/${relative}:${index + 1}: ${line.trim()}`);
      }
      if (unescapedBacktickCount(line) % 2 === 1) inside = !inside;
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `a backtick in a comment closes the template literal it sits in — escape it or reword:\n${offenders.join("\n")}`,
  );
});
