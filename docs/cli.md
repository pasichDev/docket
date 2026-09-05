# CLI reference

`docket` is a full terminal utility beyond the MCP server — inspection,
backup, and (in Self-hosted Mode) server administration. Run `docket help`
any time for the canonical, always-current list.

## The list

```text
docket list [open|done|all]     List todos (default: open), scoped to the current project
                                   -w, --workspace <n>  scope to one project instead
                                   --all                every project, unscoped
docket workspaces               Projects, with open/total counts and last activity
docket sessions                 Agent sessions open right now: agent, project, idle time, pid
docket stats                    Terminal stats widget with active claims, broken down per project
docket export [options]         Export to stdout or a file
                                   --format, -f <fmt>   "json" (default) or "markdown"/"md"
                                   --out, -o <file>     write directly to file instead of stdout
docket import <file>            Import from a JSON or Markdown file
```

`docket list` with no flags scopes to the current directory's project, exactly
like the MCP default — the CLI and the agents have to agree about what "the
list" means, or the tool teaches two different mental models. See
[`workspaces.md`](workspaces.md) for how a project is resolved.

## Claude Code hook

```text
docket hook install [--global]     Add the SessionStart hook to .claude/settings.json
docket hook uninstall [--global]   Remove only the entries docket owns
docket hook doctor                 Config, resolved project, server reachability, measured latency
```

`install` merges into whatever is already in that file, prints a diff, and asks
before writing. It is idempotent — running it twice does not stack duplicate
entries — and `uninstall` touches only entries it wrote, recognised by the hook's own
argument string rather than by the executable — the command is written as
`docket hook …` when docket is on PATH and as an absolute interpreter +
launcher path when it isn't. The hook itself fails open: if the local web server isn't
running, or anything else goes wrong, it exits 0 and prints nothing.

## Setup

```text
docket setup [options]          Interactive local/self-hosted setup wizard
                                   --data-dir <path>    Local Mode: explicit shared data directory
                                   --remote <url>        Self-hosted Mode: pair with this server non-interactively
                                   --yes, -y             skip interactive prompts (also implied when stdin isn't a TTY)
```

`docket setup` (no flags) asks interactively whether to use Local or
Self-hosted Mode, creates/verifies the data directory or drives pairing
accordingly, configures every detected MCP host, and offers the skill
install. See the [README's Installation](../README.md#quick-start) for the
Local Mode walkthrough and [`self-hosting.md`](self-hosting.md) for
Self-hosted.

## Server / Deployment (Self-hosted Mode)

```text
docket serve [options]          Run an authoritative Docket Server
                                   --host <addr>         bind address (default: 127.0.0.1 — DOCKET_SERVER_HOST)
                                   --port <n>             port (default: 8788 — DOCKET_SERVER_PORT)
                                   --data-dir <path>      data directory (default: DOCKET_DATA_DIR resolution)

docket pair <serverUrl>         Pair THIS device with a Docket Server (asks for the pairing code)

docket devices <sub>            Manage devices paired with a `docket serve` running on THIS machine:
                                   pair                    generate a pairing code for a new device
                                   pending                  list requests waiting for approval
                                   approve <requestId>      approve one
                                   deny <requestId>          deny one
                                   list                      every paired device
                                   revoke <deviceId>         cut one off immediately
                                   restore <deviceId>        un-revoke it

docket status                   Show deployment mode and connection/store health
                                   Local:  store path, Web UI reachability, active P2P peer count
                                   Remote: server URL, connection status, latency, server version,
                                            this device's name, device authorization state
                                   Non-zero exit code whenever something needs attention.

docket backend use <url>        Switch this device to a self-hosted server — pairs first if needed;
                                   uploads local data ONLY if the server is currently empty, otherwise
                                   an interactive menu (upload / keep local untouched / cancel)
docket backend localize         Download the current remote server's workspace and switch back to local
```

Full concept, setup walkthrough, and security model: [`self-hosting.md`](self-hosting.md).

## Backup

```text
docket backup <file>            Encrypted full-device backup: identity, todos, paired P2P peers
                                   (password-protected; refuses in Self-hosted Mode — back up the server instead)
docket restore <file>           Restore a backup — REPLACES this device's identity/todos/peers
                                   (renames what's currently on disk aside as .pre-restore-*.bak, never deletes it)
```

## Web UI

```text
docket web                      Ensure the Web UI is running and print its URL
                                   (Self-hosted Mode: opens the server's own Web UI instead of a second local one)
```

## Updates

```text
docket check-update             Check npm for a newer version (read-only, installs nothing)
docket update                   Check, confirm, install, self-test the new version, roll back on failure
```

Only applies to a global npm install (`npm install -g @pasichdev/docket`).
See the [README's Updating section](../README.md#backup--updating).

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `DOCKET_DATA_DIR` | Where local (or, on a server, authoritative) state lives | `~/.docket` |
| `DOCKET_WEB_PORT` | Local Web UI port | `8787` |
| `DOCKET_WORKSPACE` | Override the project this session files items under | derived — see [`workspaces.md`](workspaces.md) |
| `DOCKET_HOOKS` | Set to `off` to disable the SessionStart hook without editing any config | unset (enabled) |
| `DOCKET_MODE` | `local` or `remote` | `local` |
| `DOCKET_SERVER_URL` | Server URL to use when `DOCKET_MODE=remote` | — |
| `DOCKET_ALLOW_INSECURE_REMOTE` | Allow a non-HTTPS remote server URL (trusted-LAN dev only) | unset (HTTPS required) |
| `DOCKET_SERVER_HOST` | Bind address for `docket serve` | `127.0.0.1` |
| `DOCKET_SERVER_PORT` | Port for `docket serve` | `8788` |

Priority for deployment mode is CLI flag > environment variable >
`~/.config/docket/config.json` > default (`local`) — an existing install
with no config file and no `DOCKET_MODE` set is unaffected by any of this.

## MCP tools

The MCP tool surface (`todo_add`, `todo_edit`, `todo_claim`, ...) is
documented in the [README's Tools section](../README.md#tools) — it's
identical in both deployment modes.
