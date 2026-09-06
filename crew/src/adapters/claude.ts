/**
 * Adapter for Claude Code (`claude`, verified 2.1.259 — see crew/docs/RUNTIME-CONTRACTS.md).
 *
 * Proven invocation:
 *   claude -p "<prompt>" --output-format stream-json --verbose [--model m] [--resume <sid>]
 *
 * Every stream-json event carries `session_id`; the final `result` event carries the answer
 * text plus `is_error`. SessionStart hooks on this machine emit many `system` events before any
 * model output — those are noise and must be tolerated.
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
import { claudeMcpInjection, type McpServerSpec } from "./mcp.js";

/** See argvSafePrompt in ./common.ts: `-p` takes an optional commander value, so a prompt
 * beginning with `-` is parsed as another flag and the turn dies at the parser. */
export function buildClaudeStartArgs(input: Pick<StartTurnInput, "prompt" | "model">): string[] {
  const args = ["-p", argvSafePrompt(input.prompt), "--output-format", "stream-json", "--verbose"];
  if (input.model) args.push("--model", input.model);
  return args;
}

export function buildClaudeResumeArgs(
  input: Pick<ResumeTurnInput, "prompt" | "model" | "nativeSessionId">,
): string[] {
  return [...buildClaudeStartArgs(input), "--resume", input.nativeSessionId];
}

/**
 * Stateful per-turn mapper from raw stream-json objects to AgentEvents. Exported for the
 * fixture-driven unit tests. Never throws; unknown event types are dropped.
 */
export function createClaudeEventMapper(): (raw: Record<string, unknown>) => AgentEvent[] {
  let sessionSent = false;
  return (raw) => {
    const out: AgentEvent[] = [];
    const sessionId = raw.session_id;
    if (!sessionSent && typeof sessionId === "string" && sessionId.length > 0) {
      sessionSent = true;
      out.push({ type: "session", nativeSessionId: sessionId });
    }
    switch (raw.type) {
      case "assistant": {
        // Full assistant message: content blocks carry text and tool_use.
        const message = raw.message as Record<string, unknown> | undefined;
        const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
        for (const entry of content) {
          const block = entry as Record<string, unknown>;
          if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            out.push({ type: "text", text: block.text });
          } else if (block.type === "tool_use") {
            out.push({
              type: "tool",
              name: typeof block.name === "string" ? block.name : "tool",
              detail: block.input,
            });
          }
        }
        break;
      }
      case "text":
        // Incremental text event (seen alongside `assistant` in verbose streams).
        if (typeof raw.text === "string" && raw.text.length > 0) {
          out.push({ type: "text", text: raw.text });
        }
        break;
      case "result": {
        const text = typeof raw.result === "string" ? raw.result : JSON.stringify(raw.result ?? "");
        if (raw.is_error === true) {
          out.push({ type: "error", message: text.length > 0 ? text : "claude reported is_error" });
        } else {
          out.push({ type: "result", text });
        }
        break;
      }
      case "system":
        // subtype:"init" marks readiness; hook_started etc. are local-hook noise (contract doc).
        if (raw.subtype === "init") out.push({ type: "status", status: "init" });
        break;
      default:
        // message / rate_limit_event / anything future: drop, never crash.
        break;
    }
    return out;
  };
}

export class ClaudeAdapter implements AgentRuntimeAdapter {
  readonly id = "claude" as const;
  readonly #registry = new RunRegistry();
  /** Remembers a successful probe, forgets a failed one — see RuntimeProbeCache. */
  readonly #probe = new RuntimeProbeCache(this.id);
  #mcpServers: McpServerSpec[] = [];

  /**
   * Hand every turn of this runtime a set of MCP servers, scoped to the spawned process
   * (see adapters/mcp.ts). Not part of the frozen AgentRuntimeAdapter interface — callers
   * reach it through the registry instance, and an adapter without it simply gets no
   * servers rather than failing.
   */
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
    yield* this.#run(input, buildClaudeStartArgs(input));
  }

  async *resumeTurn(input: ResumeTurnInput): AsyncIterable<AgentEvent> {
    yield* this.#run(input, buildClaudeResumeArgs(input));
  }

  cancel(runId: string): Promise<void> {
    return this.#registry.cancel(runId);
  }

  async *#run(input: StartTurnInput, args: string[]): AsyncIterable<AgentEvent> {
    const detection = await this.detect();
    if (!detection.installed || !detection.executable) {
      yield { type: "error", message: detection.error ?? "claude not installed" };
      return;
    }
    // Per turn, not once at startup: the injection carries this turn's agent identity.
    const mcp = claudeMcpInjection(this.#mcpServers, input.env ?? {});
    yield* runTurnProcess(this.#registry, {
      runId: input.runId,
      exe: detection.executable,
      args: [...args, ...mcp.args],
      cwd: input.cwd,
      env: { ...mcp.env, ...input.env },
      signal: input.signal,
      mapEvent: createClaudeEventMapper(),
    });
  }
}
