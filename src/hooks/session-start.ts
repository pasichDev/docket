import { resolveWorkspace } from "../workspace.js";

/**
 * How long the hook will wait for the local server before giving up and staying quiet.
 *
 * This runs before every Claude Code session. The normal case — a directory walk to resolve
 * the project plus one loopback request to an already-running process — measures in the low
 * tens of milliseconds (`docket hook doctor` reports the real number on your machine). The
 * ceiling exists for the abnormal case: a server mid-restart, a machine under load, where a
 * hook that hangs is far worse than a hook that says nothing.
 */
const HOOK_TIMEOUT_MS = 150;

const DEFAULT_PORT = 8787;

/** Whatever Claude Code puts on the hook's stdin. Only `cwd` is load-bearing; the rest is ignored on purpose. */
interface ClaudeHookEvent {
  cwd?: string;
  session_id?: string;
  hook_event_name?: string;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""; // invoked by hand from a terminal, not by a host
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `docket hook claude session-start`.
 *
 * A thin HTTP client, deliberately: it must never load the MCP stack, resolve the data
 * directory, or decrypt the store. Those cost tens of milliseconds and real I/O on a path
 * that runs before every session, and a hook that makes sessions feel slower gets deleted
 * within a day — at which point it protects nobody.
 *
 * Fails open, always. Server not running, timed out, malformed response, `DOCKET_HOOKS=off`
 * — every one of them exits 0 having printed nothing. A tool that degrades your session
 * when the tool itself is broken is worse than no tool.
 */
export async function runSessionStartHook(): Promise<void> {
  if (process.env.DOCKET_HOOKS === "off") return;
  try {
    const raw = await readStdin();
    const event = (raw ? JSON.parse(raw) : {}) as ClaudeHookEvent;
    const cwd = typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd();

    // Resolved in-process: it is a short filesystem walk plus two small reads, with no
    // subprocess and no `git` on the PATH required. Asking the server to resolve it instead
    // would mean sending it a path and trusting it to have the same view of the disk.
    const { workspace } = await resolveWorkspace(cwd);

    const port = Number(process.env.DOCKET_WEB_PORT ?? DEFAULT_PORT);
    const url = `http://127.0.0.1:${port}/api/hook/session-start${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(HOOK_TIMEOUT_MS) });
    if (!res.ok) return;
    const body = (await res.json()) as { text?: unknown };
    if (typeof body.text === "string" && body.text.trim()) process.stdout.write(`${body.text}\n`);
  } catch {
    // Every failure mode lands here and is silent by design — see the fail-open note above.
  }
}
