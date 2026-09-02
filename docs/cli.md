# CLI reference

`docket` is a full terminal utility beyond the MCP server — inspection,
backup, and (in Self-hosted Mode) server administration. Run `docket help`
any time for the canonical, always-current list.

## Workspace

```text
docket list [open|done|all]     List todos (default: open)
docket stats                    Terminal stats widget with active claims
docket export [options]         Export to stdout or a file
                                   --format, -f <fmt>   "json" (default) or "markdown"/"md"
                                   --out, -o <file>     write directly to file instead of stdout
docket import <file>            Import from a JSON or Markdown file
```

## Setup

```text
docket setup [options]          Interactive local/self-hosted setup wizard
                                   --data-dir <path>    Local Mode: explicit shared data directory
                                   --remote <url>        Self-hosted Mode: pair with this server non-interactively
                                   --yes, -y             skip interactive prompts (also implied when stdin isn't a TTY)
```

`docket setup` (no flags) asks interactively whether to use Local or
Self-hosted Mode, creates/verifies the data directory or drives pairing
accordingly, configures every detected MCP host, and offers the claim-skill
install. See the [README's Installation](../README.md#installation) for the
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
See the [README's Updating section](../README.md#updating).

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `DOCKET_DATA_DIR` | Where local (or, on a server, authoritative) state lives | `~/.docket` |
| `DOCKET_WEB_PORT` | Local Web UI port | `8787` |
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
