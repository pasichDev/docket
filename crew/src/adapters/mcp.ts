/**
 * Giving a spawned runtime an MCP server — SCOPED, never by mutating the user's config.
 *
 * This lives in the adapter layer on purpose (spec §6): "how do I hand `claude`/`codex`/
 * `opencode` an MCP server" is runtime-specific knowledge, exactly like argv construction,
 * and nothing outside crew/src/adapters may know it.
 *
 * Every mechanism below was probed against the REAL binaries on this machine (2026-09-06).
 * The probe output is reproduced in crew/docs/MCP-REGISTRATION.md.
 *
 *   claude    `--mcp-config '<json>'` (+ `--strict-mcp-config`, `--allowedTools`)
 *             `claude --help`: "--mcp-config <configs...>  Load MCP servers from JSON files
 *             or strings (space-separated)" and "--strict-mcp-config  Only use MCP servers
 *             from --mcp-config, ignoring all other MCP configurations".
 *             → fully scoped to the one process. ~/.claude.json is never read or written.
 *
 *   codex     `-c mcp_servers.<name>.command=... -c mcp_servers.<name>.args=[...]`
 *             `codex exec --help` / `codex exec resume --help`: "-c, --config <key=value>
 *             Override a configuration value that would otherwise be loaded from
 *             `~/.codex/config.toml`. Use a dotted path (`foo.bar.baz`)".
 *             Present on BOTH `exec` and `exec resume` (unlike --sandbox/-C), so a resumed
 *             turn keeps its MCP server. ~/.codex/config.toml is never written; it is still
 *             READ (we deliberately do not pass --ignore-user-config, which would also throw
 *             away the user's model/provider settings) — so the agent sees the user's own
 *             servers plus ours.
 *
 *   opencode  `OPENCODE_CONFIG_CONTENT='<json>'` environment variable.
 *             Proven by strings(1) on the binary: "`OPENCODE_CONFIG_CONTENT='{"$schema":
 *             "https://opencode.ai/config.json"}'`" documented in its own --help text, and
 *             the config loader reads `process.env.OPENCODE_CONFIG_CONTENT` last, merging it
 *             over everything else. `opencode mcp add` (the alternative) is interactive and
 *             writes the user's global config — rejected for exactly that reason.
 *
 * Per-agent identity travels in the turn's environment (StartTurnInput.env, which is in the
 * frozen contract). VERIFIED THE HARD WAY: claude's MCP children inherit claude's
 * environment, but **codex's do not** — a first live run produced a worker that finished its
 * work and then reported "Crew reporting was unavailable because `DOCKET_CREW_URL` is
 * unset". So the injection is built PER TURN and every runtime is told the environment
 * explicitly rather than trusting inheritance.
 *
 * The bearer token is deliberately NOT put on codex's argv (where `ps` would show it to any
 * process of the same user): codex is handed a path to a 0600 token file instead, and the
 * MCP server reads the secret from there. See ENV_TOKEN_FILE in ../mcp/protocol.ts.
 */

export interface McpServerSpec {
  /** Tool namespace the runtime will expose, e.g. "crew" → `mcp__crew__crew_report`. */
  name: string;
  command: string;
  args: string[];
}

/** What an adapter needs to add to argv/env to expose `servers` to one turn. */
export interface McpInjection {
  args: string[];
  env: Record<string, string>;
}

export const EMPTY_INJECTION: McpInjection = { args: [], env: {} };

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

/**
 * `--mcp-config` takes a JSON *string* as well as a file path, so nothing has to be written
 * to disk. `--strict-mcp-config` then makes this the complete set: the agent gets exactly
 * the servers Crew handed it and none of the user's own, which is both an isolation win and
 * a startup-time win.
 *
 * `--allowedTools mcp__<name>` pre-approves the whole namespace. Without it a `-p` run
 * cannot answer a permission prompt and every crew_* call is denied — the agent would look
 * broken rather than un-permissioned. Nothing else is pre-approved: this is not a bypass
 * mode (spec §7).
 */
export function claudeMcpInjection(servers: McpServerSpec[], env: Record<string, string> = {}): McpInjection {
  if (servers.length === 0) return EMPTY_INJECTION;
  const mcpServers: Record<string, { type: "stdio"; command: string; args: string[]; env: Record<string, string> }> = {};
  for (const server of servers) {
    // Explicit even though claude's children inherit — the two runtimes then behave the
    // same way, and inheritance stops being load-bearing.
    mcpServers[server.name] = { type: "stdio", command: server.command, args: server.args, env };
  }
  return {
    args: [
      "--mcp-config",
      JSON.stringify({ mcpServers }),
      "--strict-mcp-config",
      "--allowedTools",
      servers.map((s) => `mcp__${s.name}`).join(","),
    ],
    env: {},
  };
}

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

/** `-c` values are parsed as TOML, so strings need real TOML quoting. */
function tomlString(value: string): string {
  return JSON.stringify(value); // TOML basic strings share JSON's escaping rules.
}

export function codexMcpInjection(servers: McpServerSpec[], env: Record<string, string> = {}): McpInjection {
  const args: string[] = [];
  for (const server of servers) {
    const key = server.name.replace(/[^A-Za-z0-9_-]/g, "_");
    args.push("-c", `mcp_servers.${key}.command=${tomlString(server.command)}`);
    args.push("-c", `mcp_servers.${key}.args=[${server.args.map(tomlString).join(",")}]`);
    // Codex does NOT pass its own environment to an MCP server — proven live. Each variable
    // goes in as its own dotted override, which the -c help text documents explicitly.
    for (const [name, value] of Object.entries(env)) {
      args.push("-c", `mcp_servers.${key}.env.${name}=${tomlString(value)}`);
    }
    // Codex drops an MCP server that is slow to hand over its tool list; ours talks to the
    // daemon over loopback on first use, so give it room rather than losing the server.
    args.push("-c", `mcp_servers.${key}.startup_timeout_sec=30`);
  }
  return { args, env: {} };
}

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

export function opencodeMcpInjection(servers: McpServerSpec[], env: Record<string, string> = {}): McpInjection {
  if (servers.length === 0) return EMPTY_INJECTION;
  const mcp: Record<string, { type: "local"; command: string[]; enabled: true; environment: Record<string, string> }> = {};
  for (const server of servers) {
    mcp[server.name] = { type: "local", command: [server.command, ...server.args], enabled: true, environment: env };
  }
  return {
    args: [],
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp }),
    },
  };
}
