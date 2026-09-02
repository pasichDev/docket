import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDataDirectoryArg } from "./setup.js";

test("parseDataDirectoryArg: reads an explicit data directory", () => {
  assert.equal(parseDataDirectoryArg(["--data-dir", "/srv/todo-mcp"]), "/srv/todo-mcp");
});

test("parseDataDirectoryArg: returns undefined when omitted", () => {
  assert.equal(parseDataDirectoryArg([]), undefined);
});
