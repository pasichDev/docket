/**
 * Daemon-side implementations of the crew_* MCP tools (spec §19/§20).
 *
 * The MCP server process owns the SCHEMAS; this file owns the BEHAVIOUR, because every one
 * of these operations mutates crew state or starts a turn, and both are the daemon's
 * exclusive job (single writer, spec §31). One RPC endpoint (/api/agent/rpc) funnels here.
 *
 * Two invariants are enforced on every call, not just at registration time:
 *   - the caller must be a MANAGED agent Crew actually launched — an observed Docket
 *     session can never drive the crew (spec §17);
 *   - the tool must belong to the caller's role — a prompt-injected worker must not be able
 *     to spawn agents just because it guessed the tool name.
 */

import { AgentNameError, describeMatches, resolveAgentRef } from "./naming.js";
import { findManager, NonIsolatedWorkspaceError, type Orchestrator } from "./orchestrator.js";
import { WorktreeDirtyError } from "./worktrees.js";
import { ROLE_TOOLS, toolAllowedForRole } from "./mcp/protocol.js";
import type { AgentRpcResponse } from "./mcp/protocol.js";
import type { Assignment, CrewAgent, CrewRole } from "./types.js";

export class AgentToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolError";
  }
}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) throw new AgentToolError(`crew: "${key}" is required`);
  return "";
}

function bool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof args[key] === "boolean" ? (args[key] as boolean) : fallback;
}

/**
 * Belt-and-braces against the class of bug defect 4 was: one roster ENTRY is one LINE.
 *
 * Names are already sanitised at the two doors they come in through (validateAgentName for a
 * managed agent, sanitizeMirroredName for an observed one), so nothing should reach here with
 * a newline in it. This is the structural guarantee anyway, at the point where the string is
 * concatenated into the manager's prompt: if a third door is ever added, its worst case is a
 * misleading line, never a forged extra one.
 */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function describeAgent(agent: CrewAgent): string {
  const bits = [
    `${oneLine(agent.name)} (id ${agent.id})`,
    agent.origin === "observed" ? "OBSERVED — cannot be assigned work" : `${agent.runtime}/${agent.role}`,
    agent.status,
  ];
  if (agent.currentAssignmentId) bits.push(`on ${agent.currentAssignmentId}`);
  return `- ${bits.join(" · ")}`;
}

/** The exact roster text `crew_agents` puts into the manager's context. Exported for tests. */
export function describeRoster(agents: CrewAgent[]): string {
  return agents.map(describeAgent).join("\n");
}

function describeAssignment(a: Assignment): string {
  const lines = [`${a.id} [${a.status}] ${a.title} (to ${a.assignedTo}, attempt ${a.attempts})`];
  if (a.result?.summary) lines.push(`  summary: ${a.result.summary}`);
  if (a.result?.branch) lines.push(`  branch: ${a.result.branch}`);
  if (a.result?.diffStat) lines.push(`  diff: ${a.result.diffStat.replace(/\n/g, "\n        ")}`);
  if (a.result?.tests) lines.push(`  tests: ${a.result.tests}`);
  return lines.join("\n");
}

export interface AgentToolContext {
  orchestrator: Orchestrator;
  /** Repo the crew works in — the base for isolated worktrees (spec §27). */
  workspaceRepoDir?: string;
}

/**
 * Dispatch one tool call for `agentId`. Throws AgentToolError for anything the agent did
 * wrong (surfaced as an MCP tool error it can read and retry); anything else is a bug and
 * propagates.
 */
export async function callAgentTool(
  ctx: AgentToolContext,
  agentId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<AgentRpcResponse> {
  const { orchestrator } = ctx;
  const state = await orchestrator.state();
  const self = state.agents[agentId];
  if (!self) throw new AgentToolError(`crew: unknown agent ${agentId}`);
  if (self.origin !== "managed") {
    throw new AgentToolError(`crew: ${self.name} is an observed session and cannot drive the crew (spec §17)`);
  }
  const role: CrewRole = self.role ?? "worker";
  if (!toolAllowedForRole(role, tool)) {
    throw new AgentToolError(`crew: ${tool} is not available to a ${role} — you have: ${roleToolList(role)}`);
  }

  switch (tool) {
    // ---------------------------------------------------------------- manager
    case "crew_agents": {
      const agents = Object.values(state.agents);
      return ok(
        agents.length ? describeRoster(agents) : "No agents yet. Use crew_spawn to start one.",
        { agents },
      );
    }

    case "crew_profiles": {
      const profiles = Object.values(orchestrator.config.profiles);
      return ok(
        profiles
          .map((p) => `- ${p.name}: ${p.runtime} / ${p.role}${p.model ? ` (${p.model})` : ""}`)
          .join("\n"),
        { profiles, manager: orchestrator.config.manager.profile },
      );
    }

    case "crew_spawn": {
      const profile = str(args, "profile");
      let agent: CrewAgent;
      try {
        agent = await orchestrator.spawnAgent(profile, { name: str(args, "name", false) || undefined });
      } catch (err) {
        if (err instanceof AgentNameError) throw new AgentToolError(err.message);
        throw err;
      }
      return ok(
        `Spawned ${agent.name} (id ${agent.id}, ${agent.runtime}/${agent.role}). It is idle until you crew_assign it work.\n` +
          `Give it a name that says what it owns (crew_rename) — you and the human address agents by name.`,
        { agent },
      );
    }

    case "crew_rename": {
      const target = resolveAgent(state.agents, str(args, "to"));
      const previousName = target.name;
      let renamed: CrewAgent;
      try {
        renamed = await orchestrator.renameAgent(target.id, str(args, "name"));
      } catch (err) {
        // A rejected name is the manager's mistake to correct, not a daemon fault: hand it
        // back as a readable tool error (with the reason) so it can pick another and move on.
        if (err instanceof AgentNameError) throw new AgentToolError(err.message);
        throw err;
      }
      return ok(
        `Renamed ${previousName} → ${renamed.name} (id ${renamed.id}). ` +
          `You can now address it as "${renamed.name}" in crew_assign/crew_send, and so can the human.`,
        { agent: renamed, previousName },
      );
    }

    case "crew_assign": {
      const target = resolveAgent(state.agents, str(args, "to"));
      const isolate = bool(args, "isolate", target.role === "worker");
      if (isolate && !ctx.workspaceRepoDir) {
        throw new AgentToolError(
          "crew: isolate=true was requested but the crew has no git repository workspace — pass isolate:false or start the daemon inside a repo.",
        );
      }
      /**
       * `requestedBy: "agent"` is HARD-CODED here on purpose. This is the whole enforcement
       * point for defect 2: whatever an agent puts in `args`, a crew_assign can never claim
       * to be the human, so it can never select a non-isolated run in the human's own
       * checkout. The refusal (and the dirty-repo refusal it may follow) is re-thrown as an
       * AgentToolError so the manager reads a plain, actionable message instead of a 500.
       */
      let assignment: Assignment;
      try {
        assignment = await orchestrator.assign({
          to: target.id,
          title: str(args, "title"),
          instructions: str(args, "instructions"),
          assignedBy: agentId,
          requestedBy: "agent",
          docketTodoId: str(args, "docketTodoId", false) || undefined,
          isolate: isolate && ctx.workspaceRepoDir ? { repoDir: ctx.workspaceRepoDir } : undefined,
        });
      } catch (err) {
        if (err instanceof NonIsolatedWorkspaceError || err instanceof WorktreeDirtyError) {
          throw new AgentToolError((err as Error).message);
        }
        throw err;
      }
      // assign() dispatches on its own, in the background — the manager's tool call must
      // not block for the worker's whole turn.
      return ok(
        `Assignment ${assignment.id} created for ${target.name} and dispatched.\n` +
          `You do NOT need to poll: when it reports done/failed/review/help you will be woken automatically with the result. ` +
          `End your turn now (crew_wait) unless you have other work to delegate.`,
        { assignment },
      );
    }

    case "crew_send": {
      const target = resolveAgent(state.agents, str(args, "to"));
      const outcome = await orchestrator.mailbox.send({
        from: agentId,
        to: target.id,
        workspace: state.workspace,
        kind: "message",
        body: str(args, "body"),
      });
      return ok(
        `Message sent to ${target.name} (${outcome.delivery === "woken" ? "it was idle — a turn has been started" : "queued; it will see this at the start of its next turn"}).`,
        { message: outcome.message, delivery: outcome.delivery },
      );
    }

    case "crew_results": {
      const all = await orchestrator.assignments.list();
      const finished = all.filter((a) => a.status !== "queued");
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(50, args.limit)) : 20;
      const recent = finished.slice(-limit);
      return ok(recent.length ? recent.map(describeAssignment).join("\n\n") : "No results yet.", {
        assignments: recent,
      });
    }

    case "crew_assignment": {
      const id = str(args, "assignmentId", false) || self.currentAssignmentId;
      if (!id) throw new AgentToolError("crew: no assignmentId given and you have no current assignment");
      const assignment = await orchestrator.assignments.get(id);
      if (!assignment) throw new AgentToolError(`crew: no assignment ${id}`);
      const worktree = orchestrator.worktreeFor(assignment.id);
      return ok(
        describeAssignment(assignment) +
          `\n\nInstructions:\n${assignment.instructions}` +
          (worktree ? `\n\nIsolated worktree: ${worktree.path} (branch ${worktree.branch}) — work THERE, not in the main checkout.` : ""),
        { assignment, worktree },
      );
    }

    case "crew_request_review": {
      const assignmentId = str(args, "assignmentId");
      const reviewer = resolveAgent(state.agents, str(args, "reviewer"));
      if (reviewer.role !== "reviewer") {
        throw new AgentToolError(`crew: ${reviewer.name} has role ${reviewer.role}, not reviewer`);
      }
      const assignment = await orchestrator.requestReview(assignmentId, reviewer.id, str(args, "notes", false));
      return ok(`Review of ${assignment.id} requested from ${reviewer.name}.`, { assignment });
    }

    case "crew_cancel": {
      const assignment = await orchestrator.cancelAssignment(str(args, "assignmentId"));
      return ok(`Cancelled ${assignment.id} (${assignment.title}).`, { assignment });
    }

    case "crew_wait":
      return ok(
        "Acknowledged. End your turn now — Crew will wake you automatically as soon as a worker reports, " +
          "a reviewer answers, or the human sends you something. Do not busy-poll.",
      );

    // ----------------------------------------------------------------- worker
    case "crew_inbox": {
      const unread = await orchestrator.mailbox.unread(agentId);
      return ok(
        unread.length
          ? unread.map((m) => `[${m.kind}] from ${m.from} at ${m.createdAt}:\n${m.body}`).join("\n\n")
          : "Inbox empty. Everything addressed to you was already delivered in this turn's prompt.",
        { messages: unread },
      );
    }

    case "crew_report": {
      const status = str(args, "status");
      if (!["done", "failed", "review", "help"].includes(status)) {
        throw new AgentToolError(`crew: status must be done|failed|review|help, got "${status}"`);
      }
      const assignmentId = str(args, "assignmentId", false) || self.currentAssignmentId;
      if (!assignmentId) throw new AgentToolError("crew: you have no current assignment to report on");
      const assignment = await orchestrator.report({
        agentId,
        assignmentId,
        status: status as "done" | "failed" | "review" | "help",
        summary: str(args, "summary"),
        tests: str(args, "tests", false) || undefined,
        commit: str(args, "commit", false) || undefined,
      });
      return ok(
        `Reported ${assignment.id} as ${assignment.status}. The manager has been notified — end your turn now.`,
        { assignment },
      );
    }

    case "crew_message_manager":
    case "crew_request_help": {
      // The shared predicate: it deliberately includes a manager whose last turn FAILED (see
      // findManager). An inline copy here once excluded it, which lost the worker's message.
      const manager = findManager(state);
      if (!manager) throw new AgentToolError("crew: no manager agent is running");
      const kind = tool === "crew_request_help" ? "help-request" : "message";
      const outcome = await orchestrator.mailbox.send({
        from: agentId,
        to: manager.id,
        workspace: state.workspace,
        kind,
        body: str(args, "body"),
      });
      if (tool === "crew_request_help" && self.currentAssignmentId) {
        await orchestrator.markWaiting(self.currentAssignmentId).catch(() => {});
      }
      return ok(
        `Sent to ${manager.name} (${outcome.delivery}). ${
          tool === "crew_request_help"
            ? "Your assignment is parked in `waiting` — end your turn; you will be woken with the answer."
            : ""
        }`,
        { message: outcome.message, delivery: outcome.delivery },
      );
    }

    // --------------------------------------------------------------- reviewer
    case "crew_report_review": {
      const assignmentId = str(args, "assignmentId", false) || self.currentAssignmentId;
      if (!assignmentId) throw new AgentToolError("crew: no assignmentId given and you have no current assignment");
      const approved = bool(args, "approved", false);
      const assignment = await orchestrator.completeReview(agentId, assignmentId, approved, str(args, "notes"));
      return ok(`Review recorded: ${assignment.id} ${approved ? "APPROVED" : "REJECTED"}. The manager has been notified.`, {
        assignment,
      });
    }

    default:
      throw new AgentToolError(`crew: unknown tool ${tool}`);
  }
}

function ok(text: string, data?: unknown): AgentRpcResponse {
  return data === undefined ? { ok: true, text } : { ok: true, text, data };
}

/**
 * Read from ROLE_TOOLS rather than restated as prose. The second copy could only ever drift,
 * and its symptom would be an agent being told, in its own error message, that it has a tool
 * the role gate then refuses it.
 */
function roleToolList(role: CrewRole): string {
  return ROLE_TOOLS[role].join(", ");
}

/**
 * Accept an agent id or its display name — an LLM will use whichever it saw last, and after
 * crew_rename the name is the one it chose itself. One shared resolver (naming.ts) so the
 * manager's `to:"backend"` and the human's `@backend` cannot mean different agents.
 */
function resolveAgent(agents: Record<string, CrewAgent>, needle: string): CrewAgent {
  const found = resolveAgentRef(agents, needle);
  if (found.ok) return assertAssignable(found.agent);
  if (found.problem === "ambiguous") {
    throw new AgentToolError(`crew: "${needle}" matches ${found.matches.length} agents (${describeMatches(found.matches)}) — use the id`);
  }
  throw new AgentToolError(`crew: no agent "${needle}". Call crew_agents to see the roster.`);
}

function assertAssignable(agent: CrewAgent): CrewAgent {
  if (agent.origin === "observed") {
    throw new AgentToolError(
      `crew: ${agent.name} is an OBSERVED Docket session — Crew did not launch it and cannot prompt, assign or stop it (spec §17).`,
    );
  }
  if (agent.status === "stopped") throw new AgentToolError(`crew: ${agent.name} is stopped`);
  return agent;
}
