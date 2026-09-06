/**
 * The wire between a spawned agent's MCP server process and the Crew daemon.
 *
 * The MCP server (crew/src/mcp/server.ts) is a THIN process: it owns the tool schemas and
 * nothing else. Every tool call becomes one loopback RPC to the daemon, which is the single
 * writer of state.json and the only thing that may start turns (spec §31). That split is
 * deliberate — several agents run at once, each with its own MCP server child, and none of
 * them may touch the state file directly.
 *
 * Auth: a per-daemon random bearer token handed to the agent through its turn environment.
 * It is NOT the Office UI session token — a runtime subprocess and a browser tab are
 * different trust levels (spec §43), and the agent token can only reach /api/agent/rpc.
 */

import type { CrewRole } from "../types.js";

export const AGENT_RPC_PATH = "/api/agent/rpc";

/** Environment the daemon puts into every managed turn; inherited by the MCP server child. */
export const ENV_BASE_URL = "DOCKET_CREW_URL";
export const ENV_TOKEN = "DOCKET_CREW_AGENT_TOKEN";
/**
 * Path to a 0600 file holding the same token. Preferred over ENV_TOKEN for runtimes whose
 * MCP-server environment has to be spelled out on the command line (codex): a path in argv
 * is harmless, a bearer token in argv is visible to every `ps` on the machine.
 */
export const ENV_TOKEN_FILE = "DOCKET_CREW_AGENT_TOKEN_FILE";
export const ENV_AGENT_ID = "DOCKET_CREW_AGENT_ID";
export const ENV_AGENT_NAME = "DOCKET_CREW_AGENT_NAME";
export const ENV_AGENT_ROLE = "DOCKET_CREW_AGENT_ROLE";

export interface AgentRpcRequest {
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentRpcResponse {
  ok: boolean;
  /** Human-readable body the agent sees as the tool result. */
  text: string;
  /** Structured payload, mirrored into the MCP result's structuredContent when present. */
  data?: unknown;
}

/**
 * Role → tool names (spec §19/§20). A worker never sees crew_spawn; a manager never sees
 * crew_report. Enforced twice: the MCP server only REGISTERS its role's tools, and the
 * daemon re-checks on every RPC (a prompt-injected agent must not be able to call a tool it
 * was not given).
 */
export const ROLE_TOOLS: Record<CrewRole, readonly string[]> = {
  manager: [
    "crew_agents",
    "crew_profiles",
    "crew_spawn",
    "crew_rename",
    "crew_assign",
    "crew_send",
    "crew_results",
    "crew_assignment",
    "crew_request_review",
    "crew_cancel",
    "crew_wait",
  ],
  worker: ["crew_inbox", "crew_assignment", "crew_report", "crew_message_manager", "crew_request_help"],
  reviewer: ["crew_assignment", "crew_report_review", "crew_message_manager"],
};

export function toolAllowedForRole(role: CrewRole, tool: string): boolean {
  return ROLE_TOOLS[role].includes(tool);
}
