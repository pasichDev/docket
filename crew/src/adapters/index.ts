/**
 * Adapter registry — the only place the rest of Crew learns which runtimes exist (spec §6).
 * Everything runtime-specific stays behind the AgentRuntimeAdapter interface.
 */

import type { AgentRuntimeAdapter, RuntimeId } from "../types.js";
import type { McpServerSpec } from "./mcp.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { OpencodeAdapter } from "./opencode.js";

export { ClaudeAdapter } from "./claude.js";
export { CodexAdapter } from "./codex.js";
export { OpencodeAdapter } from "./opencode.js";
export {
  claudeMcpInjection,
  codexMcpInjection,
  opencodeMcpInjection,
  type McpInjection,
  type McpServerSpec,
} from "./mcp.js";

/** One shared instance per runtime so detect()/capabilities() probes are cached per process. */
export const adapters: Record<RuntimeId, AgentRuntimeAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  opencode: new OpencodeAdapter(),
};

export function getAdapter(id: RuntimeId): AgentRuntimeAdapter {
  return adapters[id];
}

/**
 * Hand every runtime the same scoped MCP server set (adapters/mcp.ts). Called once by the
 * daemon at startup, before any turn runs; per-agent identity travels in the turn's env, so
 * one static registration serves the whole crew.
 *
 * Duck-typed rather than added to the frozen AgentRuntimeAdapter contract: an adapter that
 * has no way to be given an MCP server is skipped and REPORTED, never silently pretended to
 * have one.
 */
export function useMcpServersEverywhere(servers: McpServerSpec[]): { configured: RuntimeId[]; unsupported: RuntimeId[] } {
  const configured: RuntimeId[] = [];
  const unsupported: RuntimeId[] = [];
  for (const [id, adapter] of Object.entries(adapters) as [RuntimeId, AgentRuntimeAdapter][]) {
    const withMcp = adapter as AgentRuntimeAdapter & { useMcpServers?: (s: McpServerSpec[]) => void };
    if (typeof withMcp.useMcpServers === "function") {
      withMcp.useMcpServers(servers);
      configured.push(id);
    } else {
      unsupported.push(id);
    }
  }
  return { configured, unsupported };
}
