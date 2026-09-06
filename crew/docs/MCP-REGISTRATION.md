# Giving a spawned runtime the Crew MCP server

**Everything below was probed against the real binaries on this machine (2026-09-06) and then
proven end to end by a live Claude→Codex→Claude run.** Nothing here is read from docs or
assumed. Companion to `RUNTIME-CONTRACTS.md` (which is frozen); the implementation is
`crew/src/adapters/mcp.ts`.

The hard requirement: **the user's own configuration must not be permanently altered.**
`~/.claude.json`, `~/.codex/config.toml` and `~/.config/opencode/opencode.json` are never
written. Every mechanism below is scoped to a single spawned process.

---

## claude — `--mcp-config` (+ `--strict-mcp-config`, `--allowedTools`)

**Probe:**

```
$ claude --help | grep -A2 'mcp-config\|strict-mcp-config\|allowedTools'
  --mcp-config <configs...>             Load MCP servers from JSON files or
                                        strings (space-separated)
  --strict-mcp-config                   Only use MCP servers from --mcp-config,
                                        ignoring all other MCP configurations
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)
      Edit")
```

`--mcp-config` accepts a JSON **string**, so nothing is written to disk at all.
`--strict-mcp-config` makes Crew's set the complete set — the agent does not inherit the
user's other servers (isolation *and* a startup-time win). `--allowedTools mcp__crew`
pre-approves that namespace; without it a `-p` run cannot answer a permission prompt and
every `crew_*` call is silently denied. Nothing else is pre-approved — this is not a bypass
mode (spec §7).

**Generated argv:**

```
--mcp-config '{"mcpServers":{"crew":{"type":"stdio","command":"…/node","args":["…/dist/mcp/server.js"],"env":{…}}}}'
--strict-mcp-config
--allowedTools mcp__crew,mcp__docket
```

**Proof it connects** — from a real `claude -p … --output-format stream-json` run, the
`system/init` event:

```json
"mcp_servers":[{"name":"crew","status":"connected"}],
"tools":[…,"mcp__crew__crew_assignment","mcp__crew__crew_inbox",
         "mcp__crew__crew_message_manager","mcp__crew__crew_report",
         "mcp__crew__crew_request_help"]
```

(That run had no `DOCKET_CREW_AGENT_ROLE`, so the server defaulted to `worker` and offered
exactly the worker tool set — the role gating is visible in the tool list itself.)

---

## codex — `-c mcp_servers.<name>.…`

**Probe** (identical text under `codex exec --help` **and** `codex exec resume --help`):

```
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from
          `~/.codex/config.toml`. Use a dotted path (`foo.bar.baz`) to override nested
          values. The `value` portion is parsed as TOML.
```

`-c` is available on `exec` *and* on `exec resume` — unlike `--sandbox` and `-C/--cd`, which
resume does not accept. A resumed turn therefore keeps its MCP server.

`~/.codex/config.toml` is still **read** (we deliberately do not pass `--ignore-user-config`,
which would also discard the user's model and provider settings). It is never written.

**Generated argv** (inserted before the positional prompt):

```
-c mcp_servers.crew.command="/usr/local/bin/node"
-c mcp_servers.crew.args=["…/dist/mcp/server.js"]
-c mcp_servers.crew.env.DOCKET_CREW_URL="http://127.0.0.1:8790"
-c mcp_servers.crew.env.DOCKET_CREW_AGENT_TOKEN_FILE="…/.docket/crew/agent-token"
-c mcp_servers.crew.env.DOCKET_CREW_AGENT_ID="c13d525e"
-c mcp_servers.crew.env.DOCKET_CREW_AGENT_NAME="Codex #1"
-c mcp_servers.crew.env.DOCKET_CREW_AGENT_ROLE="worker"
-c mcp_servers.crew.startup_timeout_sec=30
```

**Gotcha, found the hard way:** *codex does not pass its own environment to an MCP server.*
The first live run produced a worker that did all the work and then said:

> "Crew reporting was unavailable because `DOCKET_CREW_URL` is unset."

Environment inheritance works for claude and is a trap for codex, so the environment is now
spelled out explicitly for **every** runtime and inheritance is not relied on anywhere.

**Why a token FILE and not the token:** codex needs each variable on the command line, and a
bearer token in argv is readable by every process of the same user via `ps`. Crew writes the
token to `<crew home>/agent-token` with mode 0600 and passes the *path*; the MCP server reads
`DOCKET_CREW_AGENT_TOKEN` if set, otherwise the file.

**Proof it works** — from a real codex worker run's normalized event stream:
`mcp_tool_call ×4` (a `crew_assignment` read and a `crew_report`), interleaved with
`file_change` and `command_execution`, and the assignment landed in state as
`[done]` with the worker's own `summary`, `tests` and `commit` fields.

---

## opencode — `OPENCODE_CONFIG_CONTENT`

**Probe** — `opencode mcp add` is *interactive* and writes the user's global config, so it is
rejected. The scoped alternative is documented in the binary's own help text (found with
`strings $(command -v opencode) | grep OPENCODE_CONFIG`):

```
- `OPENCODE_CONFIG=/path/to/file.json`: load an additional explicit config.
- `OPENCODE_CONFIG_CONTENT='{"$schema":"https://opencode.ai/config.json"}'`
```

and the config loader reads `process.env.OPENCODE_CONFIG_CONTENT` **last**, merging it over
everything else:

```js
if (process.env.OPENCODE_CONFIG_CONTENT) { … yield* g("OPENCODE_CONFIG_CONTENT", A, "local") … }
```

**Generated environment:**

```json
{"$schema":"https://opencode.ai/config.json",
 "mcp":{"crew":{"type":"local","command":["…/node","…/dist/mcp/server.js"],
                "enabled":true,"environment":{ …DOCKET_CREW_*… }}}}
```

**Status: implemented, NOT live-verified.** The vertical slice used claude + codex. The
mechanism is the documented one and the config shape matches opencode's schema, but nobody
has watched an opencode agent call a `crew_*` tool yet. Treat it as unproven until someone
runs `coder-openrouter` as a worker. Its permission model (`OPENCODE_PERMISSION`, and
`--auto`, which Crew never passes) may also need attention for MCP tool calls.

---

## Requested change to the frozen contract

`crew/src/types.ts` is frozen, so this was worked around rather than fixed properly:

- **`StartTurnInput` has no way to carry extra argv.** MCP registration is per-runtime argv
  and per-turn environment, so the adapters grew an out-of-interface `useMcpServers(specs)`
  method, reached through the registry by duck typing
  (`adapters/index.ts → useMcpServersEverywhere`). It works and it keeps the knowledge inside
  the adapter layer where spec §6 wants it, but a future revision of `AgentRuntimeAdapter`
  should include something like `useMcpServers?(servers: McpServerSpec[]): void` so the
  capability is part of the contract instead of a convention.
