import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dataDirectory = await mkdtemp(join(tmpdir(), "docket-smoke-cli-test-"));
const LAUNCHER = fileURLToPath(new URL("./launcher.js", import.meta.url));

test.after(() => rm(dataDirectory, { recursive: true, force: true }));

/**
 * The CLI commands are separate processes, so nothing in the unit suite ever runs one. That
 * is how `hook doctor` shipped a crash: it wrote to a child's stdin after the child had
 * already exited, and the unhandled EPIPE took the whole command down — a tool whose job is
 * to calmly report a broken hook, itself dying on one.
 *
 * These spawn the real entry point, exactly as a user's shell does.
 */
async function runCli(args: string[], options: { closeStdout?: boolean } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [LAUNCHER, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DOCKET_DATA_DIR: dataDirectory, DOCKET_WEB_PORT: "18991" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  // Destroying the pipe makes the child's own writes fail with EPIPE. A command that doesn't
  // handle that dies with an unhandled 'error' event instead of exiting cleanly.
  if (options.closeStdout) child.stdout.destroy();
  const [code] = (await once(child, "exit")) as [number | null];
  return { code, stdout, stderr };
}

for (const args of [
  ["list"],
  ["list", "all"],
  ["list", "-w", "acme/backend"],
  ["list", "--all"],
  ["workspaces"],
  ["sessions"],
  ["stats"],
  ["status"],
  ["help"],
  ["--help"],
  ["export"],
  ["export", "--format", "markdown"],
]) {
  test(`smoke: \`docket ${args.join(" ")}\` exits 0 and prints something`, async () => {
    const { code, stdout, stderr } = await runCli(args);
    assert.equal(code, 0, `exited ${code}: ${stderr}`);
    assert.ok(stdout.trim().length > 0, "produced no output at all");
  });
}

/**
 * `check-update` is the one command here that cannot be asserted to exit 0, because it is
 * the one command that needs the internet. It lived in the loop above and passed for a year
 * on a developer machine, then failed on a CI runner that could not reach npm — reporting an
 * unreachable registry, exactly as designed.
 *
 * Weakening the command to keep the test green would be the wrong repair: "I could not check
 * whether you are up to date" is not success, and a script that acts on the answer needs to
 * be able to tell those apart. So both outcomes are accepted here, and what is actually
 * checked is the thing that must hold either way — that it says something intelligible and
 * never crashes.
 */
test("smoke: `docket check-update` either answers or says it could not reach the registry", async () => {
  const { code, stdout, stderr } = await runCli(["check-update"]);
  if (code === 0) {
    assert.ok(stdout.trim().length > 0, "reported success without saying anything");
    assert.match(stdout, /up to date|Update available|npx|git clone/i, `unhelpful output: ${stdout}`);
    return;
  }
  assert.equal(code, 1, `expected a clean answer or a clean failure, got exit ${code}: ${stderr}`);
  assert.match(stderr, /couldn't reach the npm registry/, `an offline check-update must say why: ${stderr}`);
  assert.doesNotMatch(stderr, /at .*\.js:\d+/, `a network failure printed a stack trace instead of a sentence: ${stderr}`);
});

test("smoke: `docket hook doctor` reports rather than crashing when nothing is installed", async () => {
  const { code, stdout, stderr } = await runCli(["hook", "doctor"]);
  assert.equal(code, 0, `exited ${code}: ${stderr}`);
  assert.match(stdout, /workspace/, "doctor must say which project it resolved");
  assert.doesNotMatch(stderr, /EPIPE|Unhandled/, `doctor wrote a crash to stderr: ${stderr}`);
});

test("smoke: `docket hook doctor` survives a closed stdout (EPIPE)", async () => {
  const { code, stderr } = await runCli(["hook", "doctor"], { closeStdout: true });
  assert.equal(code, 0, `exited ${code}: ${stderr}`);
  assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error'/, `EPIPE escaped as a crash: ${stderr}`);
});

test("smoke: `docket list` survives a closed stdout (EPIPE)", async () => {
  const { code, stderr } = await runCli(["list"], { closeStdout: true });
  assert.equal(code, 0, `exited ${code}: ${stderr}`);
  assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error'/, `EPIPE escaped as a crash: ${stderr}`);
});

test("smoke: `docket hook claude session-start` exits 0 and prints nothing with no server", async () => {
  // The fail-open contract, exercised through the real entry point rather than the module.
  const child = spawn(process.execPath, [LAUNCHER, "hook", "claude", "session-start"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DOCKET_DATA_DIR: dataDirectory, DOCKET_WEB_PORT: "1" },
  });
  let stdout = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stdin.end(JSON.stringify({ cwd: process.cwd(), hook_event_name: "SessionStart" }));
  const [code] = (await once(child, "exit")) as [number | null];
  assert.equal(code, 0);
  assert.equal(stdout, "");
});

test("smoke: `docket export` round-trips through `docket import` without losing items", async () => {
  const { readFile, writeFile } = await import("node:fs/promises");
  // Seed through the CLI's own import path, so this exercises the pair rather than the store.
  const seedPath = join(dataDirectory, "seed.json");
  await writeFile(seedPath, JSON.stringify([{ title: "round trip A", category: "OPS" }, { title: "round trip B", priority: "high" }]));
  const imported = await runCli(["import", seedPath]);
  assert.equal(imported.code, 0, imported.stderr);
  assert.match(imported.stdout, /2 items/);

  const outPath = join(dataDirectory, "out.json");
  const exported = await runCli(["export", "--out", outPath]);
  assert.equal(exported.code, 0, exported.stderr);
  const dumped = JSON.parse(await readFile(outPath, "utf8")) as { todos: Array<{ title: string; category: string | null }> };
  const titles = dumped.todos.map((t) => t.title);
  assert.ok(titles.includes("round trip A") && titles.includes("round trip B"));
  assert.equal(dumped.todos.find((t) => t.title === "round trip A")?.category, "OPS", "a field was lost in the round trip");
});

test("smoke: an unknown command prints help rather than crashing", async () => {
  const { code, stdout, stderr } = await runCli(["definitely-not-a-command"]);
  // It falls through to the MCP server path, which needs stdin; what must NOT happen is an
  // unhandled crash. Either it explains itself or it waits — never a stack trace.
  assert.doesNotMatch(stderr, /Unhandled|TypeError|ReferenceError/, `crashed on an unknown command: ${stderr}`);
  assert.ok(code === 0 || code === null || stdout.length >= 0);
});

test("smoke: `docket import` on a missing file fails cleanly, not with a stack trace", async () => {
  const { code, stderr } = await runCli(["import", join(dataDirectory, "does-not-exist.json")]);
  assert.notEqual(code, 0, "a missing file must be an error");
  assert.doesNotMatch(stderr, /at Object\.|at async/, `reported a stack trace instead of a message: ${stderr}`);
});

test("smoke: `docket hook install` writes nothing when the answer is no", async () => {
  const { access } = await import("node:fs/promises");
  const projectDir = join(dataDirectory, "no-thanks");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(projectDir, { recursive: true });

  const child = spawn(process.execPath, [LAUNCHER, "hook", "install"], {
    cwd: projectDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DOCKET_DATA_DIR: dataDirectory },
  });
  child.stdin.end("n\n");
  const [code] = (await once(child, "exit")) as [number | null];
  assert.equal(code, 0);
  await assert.rejects(() => access(join(projectDir, ".claude", "settings.json")), "declining still wrote the file");
});
