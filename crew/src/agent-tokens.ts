import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./paths.js";

/**
 * PER-AGENT identity for the agent RPC channel (spec §43).
 *
 * WHAT WAS WRONG. There was ONE crew-wide bearer token. It authenticated the channel, and the
 * caller's identity was then taken from the REQUEST BODY (`agentId`) — from which the role,
 * and therefore the whole role boundary, was derived. Demonstrated end to end: a worker's own
 * id got `crew_spawn` correctly refused; the SAME token with the manager's id in the body
 * returned `{"ok":true,"Spawned…"}`. `crew_assign`, `crew_cancel`, `crew_rename`, `crew_send`
 * and `crew_request_review` were all reachable the same way. A credential that authenticates
 * "some agent" while the payload declares "which agent" is not an identity at all.
 *
 * WHAT THIS IS. One token per agent, minted for the duration of a turn and bound SERVER-SIDE
 * to that agent id. The RPC route resolves the caller from the credential and ignores
 * `body.agentId` as an identity source entirely (it is only cross-checked, so a mismatch is a
 * loud 403 rather than a silent success).
 *
 * The token still travels to the runtime as a FILE PATH rather than a value, for the reason
 * mcp/protocol.ts records: codex must have each MCP-server environment variable spelled out on
 * its own command line, and a bearer token in argv is readable by every `ps` on the machine.
 *
 * WHAT IT HONESTLY DOES NOT DO. Crew's realistic adversary is an agent Crew itself spawned:
 * same uid, a shell, file tools. Nothing here stops it from reading ANOTHER agent's token file
 * while that agent's turn is running — same uid, and the crew home's path is derivable from
 * its own `DOCKET_CREW_AGENT_TOKEN_FILE`. Two things genuinely change:
 *
 *   1. Impersonation is no longer FREE. It was a JSON field; it is now a race against a file
 *      that exists only while the victim is mid-turn (leases are revoked when the turn ends),
 *      and reading it is an act a shell-level auditor can see.
 *   2. A leaked or logged token now names exactly one agent, so its blast radius is that
 *      agent's role rather than the whole crew's.
 *
 * Closing it properly needs OS-level isolation (a separate uid, or a sandbox) that Crew does
 * not have. This raises the bar; it does not close the hole.
 */

export interface AgentTokenLease {
  /** The bearer value the MCP server will send. */
  token: string;
  /** 0600 file holding it — what `DOCKET_CREW_AGENT_TOKEN_FILE` points at for this turn. */
  file: string;
  /** Revoke the binding and remove the file. Idempotent, and never throws. */
  release(): Promise<void>;
}

/** `agent-tokens/` under the crew root, so ensureCrewTree's 0700 covers the parent. */
export function agentTokensDir(crewRoot: string): string {
  return join(crewRoot, "agent-tokens");
}

/** An agent id is Crew's own uuid slice, but derive the filename defensively regardless. */
function tokenFileName(agentId: string): string {
  return `${agentId.replace(/[^A-Za-z0-9._-]/g, "_")}.token`;
}

export class AgentTokenRegistry {
  private readonly byToken = new Map<string, string>();
  private readonly byAgent = new Map<string, string>();

  constructor(private readonly dir: string) {}

  /**
   * Mint this agent's token for one turn.
   *
   * An agent can only have one turn in flight (Orchestrator.inFlight), so minting revokes the
   * previous lease rather than accumulating: a turn that ended cannot keep calling in.
   */
  async lease(agentId: string): Promise<AgentTokenLease> {
    this.revoke(agentId);
    const token = randomBytes(32).toString("hex");
    const file = join(this.dir, tokenFileName(agentId));
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    /**
     * atomicWriteFile, NOT writeFile: `writeFile(path, …, {mode})` opens with 'w', which
     * FOLLOWS SYMLINKS. An agent that planted `agent-token -> ~/.ssh/authorized_keys` had the
     * daemon truncate that file and chmod it 0600 on the next start. atomicWriteFile creates a
     * fresh temp file with 'wx' and renames it over the name, which replaces a symlink rather
     * than writing through it.
     */
    await atomicWriteFile(file, token + "\n", 0o600);
    this.byToken.set(token, agentId);
    this.byAgent.set(agentId, token);
    return {
      token,
      file,
      release: async () => {
        // Only if it is still OURS: the next turn may already hold the agent's lease.
        if (this.byAgent.get(agentId) !== token) return;
        this.revoke(agentId);
        await rm(file, { force: true }).catch(() => {});
      },
    };
  }

  /** Which agent does this bearer token speak for? `undefined` = nobody, i.e. 401. */
  agentFor(token: string): string | undefined {
    return this.byToken.get(token);
  }

  private revoke(agentId: string): void {
    const previous = this.byAgent.get(agentId);
    if (previous !== undefined) this.byToken.delete(previous);
    this.byAgent.delete(agentId);
  }

  /** Daemon shutdown: no live bindings, and no 0600 secret-shaped files left on disk. */
  async revokeAll(): Promise<void> {
    this.byToken.clear();
    this.byAgent.clear();
    await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}
