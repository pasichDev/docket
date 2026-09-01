# todo-mcp

[![npm](https://img.shields.io/npm/v/%40pasichdev%2Ftodo-mcp.svg)](https://www.npmjs.com/package/@pasichdev/todo-mcp)
[![CI](https://github.com/pasichDev/todo-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/pasichDev/todo-mcp/actions/workflows/ci.yml)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.pasichDev%2Ftodo--mcp-blue)](https://registry.modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A shared TODO/backlog list exposed as an [MCP](https://modelcontextprotocol.io)
server, so every AI client you use (Claude Code, Claude Desktop, Warp, Codex,
or any other MCP host) — and every concurrent session in each of them — reads
and writes the same list. Comes with a small web UI, agent claim/release
tracking (so you can see who's working on what right now), full change
history per item, and an encrypted local data file.

## Installation guide

Five minutes, no prior MCP experience needed. This sets up the server, the
web UI, and the optional Claude Code skill in one go.

**You need:** [Claude Code](https://claude.com/claude-code) already
installed, and Node.js 18+ (check with `node --version` in a terminal — if
that command isn't found, get Node from [nodejs.org](https://nodejs.org)).

**1. Register the server.** Open a terminal and run:

```sh
claude mcp add todo-mcp -- npx -y @pasichdev/todo-mcp
```

This just tells Claude Code how to start todo-mcp — nothing is downloaded
yet. `npx` fetches and runs it the first time it's actually used.

**2. Restart Claude Code** (close and reopen it, or start a new session) so
it picks up the new server.

**3. Try it.** In a chat, ask Claude something like *"add a todo: buy
milk"*. If it uses the tool and confirms, the server is working.

**4. Open the web UI.** Go to **http://localhost:8787** in your browser —
it started itself the moment step 3 ran, no separate install step. From
here you can add/edit/complete items with a mouse, switch light/dark theme,
and tap the phone icon (top right) for a QR code to open the same list on
your phone (same Wi-Fi network).

**5. (Optional) Install the claim-tracking skill.** This teaches Claude
Code to mark an item as "in progress" while it's actively working on it,
and to check first before starting something another session already
claimed. In Claude Code:

```
/plugin marketplace add pasichDev/todo-mcp
/plugin install todo-mcp-claim@todo-mcp
```

Nothing to configure afterward — it applies automatically.

Using a different MCP host (Claude Desktop, Warp, Codex)? See
[Install](#install) below for the config-file form. Something not working?
See [Manual smoke test](#manual-smoke-test) to isolate whether it's
`npx`/npm, the server itself, or your MCP client's config.

## Why

If you use more than one AI coding tool, or run several sessions in
parallel, plain in-chat todo lists don't survive a context switch. todo-mcp
is one shared list, backed by a single local file, that every client reads
and writes through the same MCP tools.

## Features

- **Two lists**: `todo` (near-term, actionable) and `backlog` (parked, out
  of context)
- **Rich fields**: title + separate description, category (e.g. a ticket
  id), priority, due date
- **Claim/release**: mark an item as actively being worked on so other
  agents/sessions don't duplicate the effort — shown live in the web UI with
  the claiming agent's name and a pulsing highlight
- **Full history**: every create/edit/claim/release/complete is logged with
  who and when, visible per item in both the web UI and via `todo_history`
- **Web UI**: `http://localhost:8787` by default — light/dark theme, search,
  sort, inline edit, undo-delete, QR code + LAN URL so you can open it from
  your phone on the same Wi-Fi
- **Encrypted at rest**: the data file is AES-256-GCM encrypted with a
  locally generated key (see [Data & encryption](#data--encryption))
- **Schema-versioned**: a stale process (old code still holding an MCP
  connection after an update) refuses to silently misread newer data instead
  of guessing

## Install

Reference for other MCP hosts, or building from source instead of `npx`.
For the default Claude Code path, see [Installation guide](#installation-guide) above.

### Other MCP hosts

For Claude Desktop or another MCP host, add the equivalent of the Claude
Code command to its config:

```json
{
  "mcpServers": {
    "todo-mcp": {
      "command": "npx",
      "args": ["-y", "@pasichdev/todo-mcp"]
    }
  }
}
```

### From source

```sh
git clone https://github.com/pasichDev/todo-mcp.git
cd todo-mcp
npm install
npm run build
claude mcp add todo-mcp -- node "$(pwd)/dist/index.js"
```

## Tools

| Tool | Description |
|---|---|
| `todo_add(title, description?, list?, category?, priority?, dueDate?)` | Add an item. `list` is `"todo"` (default) or `"backlog"`. |
| `todo_edit(id, ...)` | Edit any subset of fields by id. Pass `""` to clear description/category/priority/dueDate. |
| `todo_claim(id)` | Mark an item as actively being worked on by you. Advisory, not a lock — warns (and lets you take over) if already claimed. |
| `todo_release(id)` | Clear your claim without completing the item. |
| `todo_list(filter?, list?, category?, agent?, session?, inProgress?)` | List items, filterable by status, list, category, who added them, session, or claim state. |
| `todo_complete(id)` | Mark done (also clears any claim). |
| `todo_history(id)` | Full change log for one item — who did what, when. |
| `todo_version()` | Report the running process's data-format version and start time — use to sanity-check a possibly-stale MCP connection. |
| `todo_delete(id)` | Permanently remove an item. |

See [`skills/todo-mcp-claim/SKILL.md`](skills/todo-mcp-claim/SKILL.md) for
the full field/workflow reference written for an agent to follow.

## Claude Code skill

Covered in step 5 of the [Installation guide](#installation-guide) above.
The non-interactive form: `claude plugin marketplace add pasichDev/todo-mcp`
then `claude plugin install todo-mcp-claim@todo-mcp`. Source:
[`skills/todo-mcp-claim/SKILL.md`](skills/todo-mcp-claim/SKILL.md).

## Web UI

A read/write dashboard on `http://localhost:8787` (override with
`TODO_MCP_WEB_PORT`) — light/dark theme, search, sort, inline edit,
undo-delete, QR code + LAN URL so you can open it from your phone on the
same Wi-Fi. Starts itself automatically (see step 4 above); how that
actually works under the hood:

It runs as its own process, separate from the MCP server. Every time an MCP
client starts `todo-mcp`, it first checks whether something is already
answering on the web UI's port — if not, it spawns `web.js` detached in the
background and moves on. The child survives after the short-lived MCP
process exits, and every later MCP connection (from any client) finds it
already running and does nothing. No launchd/systemd unit, no manual
`npm run web`, no double-spawning across multiple concurrent sessions.

It's bound to `0.0.0.0`, so it's also reachable from other devices on your
LAN. It polls every 3s, so it stays live while any MCP client adds/edits/
completes items.

**Note:** the web UI serves over plain HTTP with no auth — anyone on the
same Wi-Fi network who knows or guesses the URL can read and edit your list.
Fine on a trusted home network; don't run it on a shared/public network.

**Optional — keep it running even with no MCP client connected**, or across
reboots (macOS example, adapt paths for your setup):

```xml
<!-- ~/Library/LaunchAgents/com.todo-mcp.web.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.todo-mcp.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string><string>node</string>
    <string>/ABSOLUTE/PATH/TO/todo-mcp/dist/web.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.todo-mcp.web.plist
```

## Data & encryption

Data lives in `~/.todo-mcp/`:

- `todos.json.enc` — the store, AES-256-GCM encrypted
- `key` — a locally generated 256-bit key, written once with `chmod 600`
  (owner-read-only)
- `server.log` — plain-text process log (no todo content in it)

**Threat model:** this protects the data file from accidental exposure — a
stray `git add -A`, a backup tool that doesn't preserve file permissions,
another account on a shared machine. It does **not** protect against
someone with read access to your own user account, since the key sits next
to the data it encrypts. If you upgrade from a version before encryption
was added, the old plaintext `todos.json` is migrated automatically on
first read and kept as `todos.json.bak` (never overwritten again — delete
it yourself once you've confirmed the new file works).

## Manual smoke test

```sh
npx @modelcontextprotocol/inspector node dist/index.js
```

Call `todo_add`, `todo_list`, `todo_claim`, `todo_complete`, `todo_delete`
from the inspector UI and confirm `~/.todo-mcp/todos.json.enc` updates on
disk (it won't be human-readable — that's the point).

## License

MIT — see [LICENSE](LICENSE).

<details>
<summary><strong>Releasing</strong> (maintainer reference)</summary>

Tags matching `v*` trigger [`.github/workflows/release.yml`](.github/workflows/release.yml),
which publishes the npm package and then the [MCP Registry](https://modelcontextprotocol.io/registry)
listing. One-time setup before the first tag:

1. `NPM_TOKEN` repo secret — an npm **Automation** token (bypasses 2FA) with
   publish rights on `@pasichdev/todo-mcp`.
2. `MCP_GITHUB_TOKEN` repo secret — a GitHub PAT (no special scopes), used
   only to prove ownership of the `io.github.pasichDev/...` server name.
3. `server.json` — already committed; regenerate with `mcp-publisher init`
   after `mcp-publisher login github` if the server metadata changes.

Then: `npm version <major|minor|patch>`, `git push --follow-tags`.

</details>

