/**
 * Adapter for Codex CLI (`codex`, verified 0.151.0 — see crew/docs/RUNTIME-CONTRACTS.md).
 *
 * Proven invocation:
 *   codex exec --json --sandbox workspace-write --skip-git-repo-check -C <cwd> [-m m] "<prompt>"
 *
 * Resume (probed 2026-09-06 via `codex exec resume --help`): the resume subcommand accepts
 * `--json`, `--model`, `--skip-git-repo-check` but NOT `--sandbox`/`-C`. The sandbox default is
 * therefore re-asserted through `-c sandbox_mode="workspace-write"` and the working directory
 * through the spawn cwd (which `codex exec` honours when no `-C` is given).
 *
 * Codex hangs reading stdin when it is left open ("Reading additional input from stdin...") —
 * runTurnProcess always spawns with stdin ignored.
 */

import type {
  AgentEvent,
  AgentRuntimeAdapter,
  ResumeTurnInput,
  RuntimeCapabilities,
  RuntimeDetection,
  StartTurnInput,
} from "../types.js";
import { RunRegistry, RuntimeProbeCache, argvSafePrompt, runTurnProcess } from "./common.js";
import { codexMcpInjection, type McpServerSpec } from "./mcp.js";

export function buildCodexStartArgs(
  input: Pick<StartTurnInput, "prompt" | "model" | "cwd">,
  /** Extra flags (MCP `-c` overrides). Inserted BEFORE the positional prompt, never after. */
  extraArgs: string[] = [],
): string[] {
  const args = ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", input.cwd];
  if (input.model) args.push("-m", input.model);
  args.push(...extraArgs);
  // `--` ends option parsing (PROBED against codex 0.151.0), and argvSafePrompt guards the
  // prompt itself — see ./common.ts. Two defences because they fail differently: the separator
  // is structural, the guard also covers codex's `-`-means-stdin trap.
  args.push("--", argvSafePrompt(input.prompt));
  return args;
}

export function buildCodexResumeArgs(
  input: Pick<ResumeTurnInput, "prompt" | "model" | "nativeSessionId">,
  extraArgs: string[] = [],
): string[] {
  const args = [
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    // `codex exec resume` has no --sandbox flag; keep the workspace-write default via config.
    "-c",
    'sandbox_mode="workspace-write"',
  ];
  if (input.model) args.push("-m", input.model);
  args.push(...extraArgs);
  args.push("--", input.nativeSessionId, argvSafePrompt(input.prompt));
  return args;
}

/**
 * Stateful per-turn mapper from codex `exec --json` events to AgentEvents. Exported for the
 * fixture-driven unit tests. Never throws; unknown event types are dropped.
 */
export function createCodexEventMapper(): (raw: Record<string, unknown>) => AgentEvent[] {
  let sessionSent = false;
  let lastAgentMessage = "";
  return (raw) => {
    const out: AgentEvent[] = [];
    switch (raw.type) {
      case "thread.started":
        if (!sessionSent && typeof raw.thread_id === "string" && raw.thread_id.length > 0) {
          sessionSent = true;
          out.push({ type: "session", nativeSessionId: raw.thread_id });
        }
        break;
      case "turn.started":
        out.push({ type: "status", status: "turn.started" });
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = raw.item as Record<string, unknown> | undefined;
        if (!item) break;
        if (item.type === "agent_message") {
          if (raw.type === "item.completed" && typeof item.text === "string" && item.text.length > 0) {
            lastAgentMessage = item.text;
            out.push({ type: "text", text: item.text });
          }
        } else if (typeof item.type === "string") {
          // file_change / command_execution / mcp_tool_call / web_search / ... → tool activity.
          // Emitted for started and completed alike; `item.status` disambiguates in `detail`.
          if (item.type !== "reasoning") {
            out.push({ type: "tool", name: item.type, detail: item });
          }
        }
        break;
      }
      case "turn.completed":
        out.push({ type: "result", text: lastAgentMessage });
        break;
      case "turn.failed": {
        const error = raw.error as Record<string, unknown> | undefined;
        const message = typeof error?.message === "string" ? error.message : JSON.stringify(raw);
        out.push({ type: "error", message: `codex turn failed: ${message}` });
        break;
      }
      case "error": {
        const message = typeof raw.message === "string" ? raw.message : JSON.stringify(raw);
        out.push({ type: "error", message: `codex error: ${message}` });
        break;
      }
      default:
        break;
    }
    return out;
  };
}

export class CodexAdapter implements AgentRuntimeAdapter {
  readonly id = "codex" as const;
  readonly #registry = new RunRegistry();
  /** Remembers a successful probe, forgets a failed one — see RuntimeProbeCache. */
  readonly #probe = new RuntimeProbeCache(this.id);
  #mcpServers: McpServerSpec[] = [];

  /** See adapters/mcp.ts — `-c mcp_servers.*` works on `exec` AND `exec resume`. */
  useMcpServers(servers: McpServerSpec[]): void {
    this.#mcpServers = servers;
  }

  detect(): Promise<RuntimeDetection> {
    return this.#probe.detect();
  }

  capabilities(): Promise<RuntimeCapabilities> {
    return this.#probe.capabilities();
  }

  async *startTurn(input: StartTurnInput): AsyncIterable<AgentEvent> {
    yield* this.#run(input, buildCodexStartArgs(input, this.#mcpArgs(input)));
  }

  async *resumeTurn(input: ResumeTurnInput): AsyncIterable<AgentEvent> {
    yield* this.#run(input, buildCodexResumeArgs(input, this.#mcpArgs(input)));
  }

  /** Built per turn: codex must be told the MCP server's environment explicitly. */
  #mcpArgs(input: StartTurnInput): string[] {
    return codexMcpInjection(this.#mcpServers, input.env ?? {}).args;
  }

  cancel(runId: string): Promise<void> {
    return this.#registry.cancel(runId);
  }

  async *#run(input: StartTurnInput, args: string[]): AsyncIterable<AgentEvent> {
    const detection = await this.detect();
    if (!detection.installed || !detection.executable) {
      yield { type: "error", message: detection.error ?? "codex not installed" };
      return;
    }
    yield* runTurnProcess(this.#registry, {
      runId: input.runId,
      exe: detection.executable,
      args,
      cwd: input.cwd,
      env: input.env,
      signal: input.signal,
      mapEvent: createCodexEventMapper(),
    });
  }
}
