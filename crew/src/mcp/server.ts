#!/usr/bin/env node
/**
 * The Crew MCP server (spec §19/§20) — the process a spawned agent actually connects to.
 *
 * It is started BY THE RUNTIME (claude/codex/opencode), not by Crew: the daemon hands each
 * runtime a scoped server spec (`node <this file>`, see adapters/mcp.ts) and the runtime
 * spawns it as its own child. The child inherits the turn's environment, which is how it
 * learns who it is (DOCKET_CREW_AGENT_ID/ROLE) and how to reach the daemon
 * (DOCKET_CREW_URL + DOCKET_CREW_AGENT_TOKEN).
 *
 * It holds no state. Every tool is one loopback RPC to the daemon, which is the single
 * writer (spec §31) and the only thing allowed to start turns. Registering only the calling
 * role's tools is the first half of the role boundary; the daemon re-checks the role on
 * every RPC, which is the half that actually enforces it.
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import type { CrewRole } from "../types.js";
import {
  AGENT_RPC_PATH,
  ENV_AGENT_ID,
  ENV_AGENT_NAME,
  ENV_AGENT_ROLE,
  ENV_BASE_URL,
  ENV_TOKEN,
  ENV_TOKEN_FILE,
  ROLE_TOOLS,
  type AgentRpcResponse,
} from "./protocol.js";

const VERSION = "0.1.0";

const baseUrl = process.env[ENV_BASE_URL] ?? "";
const token = readToken();

/** Token from the environment, or from the 0600 file whose path the environment names. */
function readToken(): string {
  const inline = process.env[ENV_TOKEN];
  if (inline) return inline;
  const file = process.env[ENV_TOKEN_FILE];
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

const agentId = process.env[ENV_AGENT_ID] ?? "";
const agentName = process.env[ENV_AGENT_NAME] ?? agentId;
const rawRole = process.env[ENV_AGENT_ROLE] ?? "worker";
const role: CrewRole = rawRole === "manager" || rawRole === "reviewer" ? rawRole : "worker";

/**
 * Misconfiguration must be LOUD at the tool call, not a silently absent tool list: an agent
 * that can see crew_report but gets "not configured" back knows to tell the human, whereas
 * an agent with no tools at all just improvises and the human never learns why.
 */
function configError(): string | null {
  if (!baseUrl) return `${ENV_BASE_URL} is not set — this MCP server was not started by Docket Crew.`;
  if (!token) return `neither ${ENV_TOKEN} nor a readable ${ENV_TOKEN_FILE} is set — cannot authenticate to the crew daemon.`;
  if (!agentId) return `${ENV_AGENT_ID} is not set — this process does not know which crew agent it serves.`;
  return null;
}

async function rpc(tool: string, args: Record<string, unknown>): Promise<AgentRpcResponse> {
  const problem = configError();
  if (problem) return { ok: false, text: `crew: ${problem}` };
  let res: Response;
  try {
    res = await fetch(new URL(AGENT_RPC_PATH, baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        // The daemon binds loopback and validates Host; send one it recognizes.
        Host: new URL(baseUrl).host,
      },
      body: JSON.stringify({ agentId, tool, args }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return { ok: false, text: `crew: cannot reach the crew daemon at ${baseUrl}: ${(err as Error).message}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, text: `crew: daemon returned a non-JSON response (HTTP ${res.status})` };
  }
  const parsed = body as Partial<AgentRpcResponse> & { error?: string };
  if (!res.ok) return { ok: false, text: parsed.error ?? parsed.text ?? `crew: daemon error HTTP ${res.status}` };
  return { ok: parsed.ok !== false, text: parsed.text ?? "", data: parsed.data };
}

const server = new McpServer({ name: "docket-crew", version: VERSION });

interface ToolDef {
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  readOnly?: boolean;
}

const agentRef = z
  .string()
  .describe("Agent id (preferred) or exact display name, as shown by crew_agents");

const TOOLS: Record<string, ToolDef> = {
  // ------------------------------------------------------------------ manager
  crew_agents: {
    title: "List crew agents",
    description:
      "Who is on the crew right now: id, runtime, role, status and current assignment. Agents marked OBSERVED are passive Docket sessions Crew did not launch — you can see them but you can never assign, message or stop them.",
    inputSchema: {},
    readOnly: true,
  },
  crew_profiles: {
    title: "List agent profiles",
    description: "The agent templates you may spawn (runtime + role + model), from the crew's config.yml.",
    inputSchema: {},
    readOnly: true,
  },
  crew_spawn: {
    title: "Spawn an agent",
    description:
      "Start a new managed agent from a profile. Spawn only what you need — the crew has a hard maxAgents limit and every agent costs tokens.",
    inputSchema: {
      profile: z.string().describe("Profile name from crew_profiles, e.g. \"coder-codex\""),
      name: z.string().optional().describe("Optional display name, e.g. \"Codex #2\""),
    },
  },
  crew_rename: {
    title: "Rename an agent",
    description:
      'Give one of your agents a meaningful name. Names are ADDRESSES: after this, you can say to:"backend" instead of pasting an id, the human can talk to it directly by that name, and the agent introduces itself under it. Name agents for the WORK ("backend", "tests", "docs"), not "Codex #2". A name must be unique among live agents — a taken name is refused, never silently suffixed, because two "backend"s would make every later message to "backend" a coin flip. Observed Docket sessions cannot be renamed: Crew did not launch them.',
    inputSchema: {
      to: agentRef,
      name: z.string().describe('The new display name, e.g. "backend" — short, unique, and about the work it owns'),
    },
  },
  crew_assign: {
    title: "Assign work to an agent",
    description:
      "Delegate ONE self-contained task to one agent. Write the instructions as if the worker has no other context: what to change, where, and how it will be verified. Returns immediately — do NOT poll for the result, you are woken automatically when the worker reports.",
    inputSchema: {
      to: agentRef,
      title: z.string().describe("Short one-line task title"),
      instructions: z
        .string()
        .describe("The complete brief: goal, constraints, files/areas involved, and how to verify it worked"),
      docketTodoId: z
        .string()
        .optional()
        .describe("Docket todo id or short id this assignment implements — the worker will claim and complete it"),
      isolate: z
        .boolean()
        .optional()
        .describe(
          "Run the worker in its own git worktree on a crew/ branch (default true for workers). Refused if the repository has uncommitted changes — in that case do NOT pass false: isolate:false runs in the human's own checkout and is refused for agents, whatever this argument says. Only the human can choose it.",
        ),
    },
  },
  crew_send: {
    title: "Message an agent",
    description:
      "Send a note to another agent. If it is idle it starts a turn now; if it is executing, the message is delivered at the start of its next turn (Crew never injects into a running process).",
    inputSchema: { to: agentRef, body: z.string().describe("The message") },
  },
  crew_results: {
    title: "Recent assignment results",
    description: "Every assignment that has started, with status, summary, branch and diffstat.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    readOnly: true,
  },
  crew_request_review: {
    title: "Request a review",
    description:
      "Hand a finished assignment to a reviewer agent. The reviewer challenges the work rather than redoing it, and reports back to you.",
    inputSchema: {
      assignmentId: z.string(),
      reviewer: agentRef,
      notes: z.string().optional().describe("What specifically you want checked"),
    },
  },
  crew_cancel: {
    title: "Cancel an assignment",
    description: "Stop an assignment and kill its run. Its worktree and branch are kept for inspection.",
    inputSchema: { assignmentId: z.string() },
  },
  crew_wait: {
    title: "Finish this turn and wait",
    description:
      "Declare that you have delegated everything you can and are waiting on the crew. Call this and then END YOUR TURN — Crew wakes you automatically when a worker reports, a reviewer answers, or the human writes to you. Never loop or sleep waiting for results.",
    inputSchema: {},
    readOnly: true,
  },

  // ------------------------------------------------------------------- worker
  crew_inbox: {
    title: "Read your inbox",
    description:
      "Messages addressed to you that were not already in this turn's prompt. Normally empty — Crew hands you your mail at the start of every turn.",
    inputSchema: {},
    readOnly: true,
  },
  crew_assignment: {
    title: "Your assignment",
    description:
      "The full brief for your current assignment (or one by id): instructions, Docket todo, and the isolated worktree you must work in.",
    inputSchema: { assignmentId: z.string().optional() },
    readOnly: true,
  },
  crew_report: {
    title: "Report your result",
    description:
      "Report the outcome of your assignment, then end your turn. This is how the manager finds out — it is woken automatically with what you write here. Report honestly: `failed` for work that did not work is far more useful than an optimistic `done`.",
    inputSchema: {
      status: z.enum(["done", "failed", "review", "help"]).describe("done | failed | review (ready for review) | help"),
      summary: z.string().describe("What you actually did or why it failed — concrete, no marketing"),
      tests: z.string().optional().describe("Test/verification command and its real result"),
      commit: z.string().optional().describe("Commit sha, if you committed to your worktree branch"),
      assignmentId: z.string().optional(),
    },
  },
  crew_message_manager: {
    title: "Message the manager",
    description: "Send the manager a note without ending your assignment.",
    inputSchema: { body: z.string() },
  },
  crew_request_help: {
    title: "Ask the manager for help",
    description:
      "Block on a decision only a human or the manager can make. Your assignment is parked in `waiting`; end your turn and you will be woken with the answer.",
    inputSchema: { body: z.string().describe("Exactly what you are blocked on and what you need decided") },
  },

  // ----------------------------------------------------------------- reviewer
  crew_report_review: {
    title: "Report your review verdict",
    description:
      "Approve or reject the work you reviewed. Challenge the change — read the diff, look for what it breaks, verify the claim. Do not re-implement it.",
    inputSchema: {
      approved: z.boolean(),
      notes: z.string().describe("What you checked and what you found — specific findings, not a summary of the diff"),
      assignmentId: z.string().optional(),
    },
  },
};

for (const tool of ROLE_TOOLS[role]) {
  const def = TOOLS[tool];
  if (!def) continue;
  server.registerTool(
    tool,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: { readOnlyHint: def.readOnly ?? false, destructiveHint: false },
    },
    async (args: Record<string, unknown>) => {
      const result = await rpc(tool, args ?? {});
      return {
        content: [{ type: "text" as const, text: result.text || (result.ok ? "ok" : "crew: unknown error") }],
        isError: !result.ok,
      };
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr, never stdout: stdout IS the MCP transport.
process.stderr.write(`docket-crew mcp: serving ${role} tools for ${agentName} (${agentId || "unidentified"})\n`);
