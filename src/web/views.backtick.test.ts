import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The dashboard is assembled from template literals (client/styles.ts, client/markup.ts,
 * client/script/*.ts). Inside one of those, a single unescaped backtick ends the string and
 * everything after it is parsed as TypeScript — which the compiler does report, but as a
 * cascade of errors pointing at whatever text happened to follow, never at the backtick.
 *
 * That cost four separate debugging detours in one sitting, every time in a COMMENT, where a
 * backtick is the natural way to quote an identifier. This test points at the exact line.
 *
 * It tracks whether each line sits INSIDE a template literal, so ordinary module-level
 * JSDoc — which may quote identifiers freely — is not flagged.
 */
const WEB_DIR = fileURLToPath(new URL(".", import.meta.url).href.replace("/dist/", "/src/"));

async function tsFilesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await tsFilesUnder(path)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

/** Backticks that actually open or close a literal — an escaped one is just a character. */
function unescapedBacktickCount(line: string): number {
  return (line.match(/(^|[^\\])`/g) ?? []).length;
}

const COMMENT_START = /^\s*(\/\/|\*|\/\*)/;

test("no unescaped backtick sits in a comment inside a template literal", async () => {
  const files = await tsFilesUnder(WEB_DIR);
  assert.ok(files.length > 5, `expected to find the client files under ${WEB_DIR}, found ${files.length}`);

  const offenders: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    let inside = false;
    source.split("\n").forEach((line, index) => {
      const opensHere = inside;
      if (opensHere && COMMENT_START.test(line) && unescapedBacktickCount(line) > 0) {
        offenders.push(`${file.replace(WEB_DIR, "web/")}:${index + 1}: ${line.trim()}`);
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
