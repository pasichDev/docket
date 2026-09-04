/**
 * `docket hook …` — dispatched from launcher.ts before index.js (and therefore the whole MCP
 * stack, the device identity and the encrypted store) is ever imported. That ordering is not
 * incidental: `docket hook claude session-start` runs before every Claude Code session and
 * has a 20 ms budget, which importing any of that would blow on its own.
 */
export async function runHookCommand(args: string[]): Promise<void> {
  try {
    await dispatch(args);
  } catch (err) {
    // These commands edit a file the user owns and can plausibly have hand-broken. A stack
    // trace is not a diagnosis; the messages thrown below already say what to do.
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

async function dispatch(args: string[]): Promise<void> {
  const [first, second] = args;

  if (first === "claude" && second === "session-start") {
    const { runSessionStartHook } = await import("./session-start.js");
    await runSessionStartHook();
    return;
  }

  if (first === "install") {
    const { runHookInstall } = await import("./install.js");
    await runHookInstall(args.slice(1));
    return;
  }
  if (first === "uninstall") {
    const { runHookUninstall } = await import("./install.js");
    await runHookUninstall(args.slice(1));
    return;
  }
  if (first === "doctor") {
    const { runHookDoctor } = await import("./install.js");
    await runHookDoctor();
    return;
  }

  console.log(`docket hook — Claude Code SessionStart integration

Usage:
  docket hook install [--global]     Add the SessionStart hook to .claude/settings.json
  docket hook uninstall [--global]   Remove only the entries docket owns
  docket hook doctor                 Check config, server and measured round-trip latency
  docket hook claude session-start   The hook itself (run by Claude Code, not by hand)

What it does: when a session starts, injects the items open in THIS project — compact, at
most 7, under 120 tokens — so you pick the thread back up instead of re-deriving it. Nothing
is injected when the project has nothing open.

It fails open: if the docket web server isn't running, or anything else goes wrong, the hook
exits silently and your session is unaffected. Set DOCKET_HOOKS=off to disable it entirely
without editing any config.`);
}
