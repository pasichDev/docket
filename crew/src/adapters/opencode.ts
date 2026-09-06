/**
 * Adapter for OpenCode (`opencode`, verified 1.18.26 — see crew/docs/RUNTIME-CONTRACTS.md).
 *
 * Proven invocation:
 *   opencode run --format json -m "<provider>/<model>" --dir <cwd> [-s <sid>] "<prompt>"
 *
 * IMPORTANT stdout gotcha (observed, not theoretical): a Warp terminal plugin interleaves OSC
 * `]777;notify;warp://cli-agent;{...}` payloads directly into the JSON stream, sometimes glued
 * onto the front of a real JSON line with no newline. All parsing goes through the shared
 * defensive extractor in ./common.ts, and the warp payload object itself (no recognized `type`)
 * is dropped by the mapper.
 *
 * `--auto` (auto-approve permissions) is dangerous and is never passed (spec §7).
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
import { opencodeMcpInjection, type McpServerSpec } from "./mcp.js";

/** opencode takes `provider/model`; combine the split form when the profile provides both. */
export function resolveOpencodeModel(
  input: Pick<StartTurnInput, "model" | "provider">,
): string | undefined {
  if (!input.model) return undefined;
  if (input.provider && !input.model.includes("/")) return `${input.provider}/${input.model}`;
  return input.model;
}

export function buildOpencodeStartArgs(
  input: Pick<StartTurnInput, "prompt" | "model" | "provider" | "cwd">,
): string[] {
  const args = ["run", "--format", "json", "--dir", input.cwd];
  const model = resolveOpencodeModel(input);
  if (model) args.push("-m", model);
  // `--` plus the shared guard, exactly as in the codex adapter — see ./common.ts.
  args.push("--", argvSafePrompt(input.prompt));
  return args;
}

export function buildOpencodeResumeArgs(
  input: Pick<ResumeTurnInput, "prompt" | "model" | "provider" | "cwd" | "nativeSessionId">,
): string[] {
  const args = ["run", "--format", "json", "--dir", input.cwd, "-s", input.nativeSessionId];
  const model = resolveOpencodeModel(input);
  if (model) args.push("-m", model);
  args.push("--", argvSafePrompt(input.prompt));
  return args;
}

/**
 * Stateful per-turn mapper from opencode `--format json` events to AgentEvents. Exported for
 * the fixture-driven unit tests. Never throws; unknown event types are dropped.
 */
export function createOpencodeEventMapper(): (raw: Record<string, unknown>) => AgentEvent[] {
  let sessionSent = false;
  let lastText = "";
  return (raw) => {
    const out: AgentEvent[] = [];
    const sessionId = raw.sessionID;
    if (!sessionSent && typeof sessionId === "string" && sessionId.length > 0) {
      sessionSent = true;
      out.push({ type: "session", nativeSessionId: sessionId });
    }
    const part = raw.part as Record<string, unknown> | undefined;
    switch (raw.type) {
      case "step_start":
        out.push({ type: "status", status: "step_start" });
        break;
      case "text":
        if (typeof part?.text === "string" && part.text.length > 0) {
          lastText = part.text;
          out.push({ type: "text", text: part.text });
        }
        break;
      case "tool":
      case "tool_use": {
        const name =
          typeof part?.tool === "string" ? part.tool : typeof raw.tool === "string" ? raw.tool : "tool";
        out.push({ type: "tool", name, detail: part ?? raw });
        break;
      }
      case "step_finish": {
        // A turn may hold several steps (tool loops); only the reason:"stop" step ends it.
        const reason = part?.reason;
        if (reason === "stop" || reason === undefined) {
          out.push({ type: "result", text: lastText });
        } else {
          out.push({ type: "status", status: `step_finish:${String(reason)}` });
        }
        break;
      }
      case "error": {
        const message =
          typeof raw.message === "string"
            ? raw.message
            : typeof (raw.error as Record<string, unknown> | undefined)?.message === "string"
              ? String((raw.error as Record<string, unknown>).message)
              : JSON.stringify(raw);
        out.push({ type: "error", message: `opencode error: ${message}` });
        break;
      }
      default:
        // Warp notify payloads ({"v":1,"agent":"opencode",...}) and future event kinds: drop.
        break;
    }
    return out;
  };
}

export class OpencodeAdapter implements AgentRuntimeAdapter {
  readonly id = "opencode" as const;
  readonly #registry = new RunRegistry();
  /** Remembers a successful probe, forgets a failed one — see RuntimeProbeCache. */
  readonly #probe = new RuntimeProbeCache(this.id);
  #mcpServers: McpServerSpec[] = [];

  /** See adapters/mcp.ts — opencode takes MCP servers through OPENCODE_CONFIG_CONTENT. */
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
    yield* this.#run(input, buildOpencodeStartArgs(input));
  }

  async *resumeTurn(input: ResumeTurnInput): AsyncIterable<AgentEvent> {
    yield* this.#run(input, buildOpencodeResumeArgs(input));
  }

  cancel(runId: string): Promise<void> {
    return this.#registry.cancel(runId);
  }

  async *#run(input: StartTurnInput, args: string[]): AsyncIterable<AgentEvent> {
    const detection = await this.detect();
    if (!detection.installed || !detection.executable) {
      yield { type: "error", message: detection.error ?? "opencode not installed" };
      return;
    }
    yield* runTurnProcess(this.#registry, {
      runId: input.runId,
      exe: detection.executable,
      args,
      cwd: input.cwd,
      env: { ...opencodeMcpInjection(this.#mcpServers, input.env ?? {}).env, ...input.env },
      signal: input.signal,
      mapEvent: createOpencodeEventMapper(),
    });
  }
}
