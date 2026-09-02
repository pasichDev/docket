# todo-mcp

[![npm](https://img.shields.io/npm/v/%40pasichdev%2Ftodo-mcp.svg)](https://www.npmjs.com/package/@pasichdev/todo-mcp)
[![CI](https://github.com/pasichDev/todo-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/pasichDev/todo-mcp/actions/workflows/ci.yml)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.pasichDev%2Ftodo--mcp-blue)](https://registry.modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**One todo list, shared by every AI tool you use.** Claude Code, Claude
Desktop, Cursor, Windsurf, Warp, Codex — add an item in one, see it in all of them, plus a
real-time web dashboard and your phone. Nothing gets lost switching tools or starting
a new session.

```
Claude Code · Claude Desktop · Cursor · Windsurf · Warp · Codex
                        |
                       MCP
                        |
                        v
                    todo-mcp  ---->  Encrypted list (your machine)
                        |                     ^
                        v                     |
              Web dashboard :8787  -----------'
              (SSE, live updates)
                        ^
                        |  browser, Viewer Gate approved
                        |
                   Your phone
```

Every client talks to the same server, which is the only thing that ever
touches the data file — so there's one source of truth, not four out-of-sync
copies. Everything lives locally: no account, no cloud, nothing to sign up
for.

**What it adds beyond "just a list":**

- **See who's doing what.** Claim an item before starting on it — other
  sessions see it's taken (with a live pulsing highlight) instead of
  duplicating the work.
- **Full history**, not just a checkbox — every edit/claim/complete is
  logged with who and when.
- **Todo vs. backlog** — keep near-term work separate from things you want
  to park without losing them.
- **Private by default** — the data file is encrypted on disk; nobody
  reading your filesystem casually sees your task list in plain text.
- **Jump back to the source** — attach a link (a GitHub issue/PR, a Notion
  page, an Obsidian note, anything with a URL) so a card takes you straight
  back to where it came from.
- **Real-time Web UI (SSE)** — zero-delay live updates via Server-Sent Events
  whenever an AI agent or peer modifies a task.
- **Secure LAN Viewer Gate** — access your list from your phone with an explicit
  approval handshake on your computer.
- **CLI & Backup Tools** — terminal stats widget, fast command-line lists, and
  export/import in JSON and Markdown, from the terminal or from an **Export &
  Import** panel in the web UI itself.
- **Optional multi-device sync** — pair your laptop and desktop and the same
  list follows you, with an explicit approve/deny handshake on both ends
  (see [Devices & sync](#devices--sync)).
- **Self-updating** — `todo-mcp check-update` / `todo-mcp update` check npm
  for a newer version, ask for confirmation, and verify the new version
  actually starts before keeping it (see [Updating](#updating)).

## Installation guide

Five minutes, no prior MCP experience needed. This sets up the server, the
web UI, and the optional Claude Code skill in one go.

**You need:** [Claude Code](https://claude.com/claude-code) (or another MCP host) already
installed, and Node.js 18+ (check with `node --version` in a terminal — if
that command isn't found, get Node from [nodejs.org](https://nodejs.org)).

**1. Run the interactive setup wizard.** It creates and verifies one shared
durable data directory, configures detected MCP hosts, optionally installs the
claim skill for Claude Code and Codex, and can add a `todo_stats` helper to your shell startup:

```sh
npx -y @pasichdev/todo-mcp setup
```

The wizard writes host configuration automatically when Codex, Claude Code,
Cursor, or Windsurf is detected. For automation or a non-interactive terminal,
pass the directory explicitly:

```sh
npx -y @pasichdev/todo-mcp setup --data-dir "$HOME/.local/state/todo-mcp"
```

The printed `TODO_MCP_DATA_DIR` is the value used in those host entries. The
wizard merges existing JSON configuration and does not replace unrelated
servers.

**2. Register the server.** Open a terminal and run:

```sh
claude mcp add todo-mcp -- npx -y @pasichdev/todo-mcp
```

This just tells Claude Code how to start todo-mcp — nothing is downloaded
yet. `npx` fetches and runs it the first time it's actually used.

**3. Restart Claude Code** (close and reopen it, or start a new session) so
it picks up the new server.

**4. Try it.** In a chat, ask Claude something like *"add a todo: buy
milk"*. If it uses the tool and confirms, the server is working.

**5. Open the web UI.** Go to **http://localhost:8787** in your browser —
it started itself the moment step 3 ran, no separate install step. From
here you can add/edit/complete items with a mouse, switch light/dark theme,
and search/sort/filter the list.

**6. (Optional) Install the claim-tracking skill.** This teaches Claude
Code to mark an item as "in progress" while it's actively working on it,
and to check first before starting something another session already
claimed. In Claude Code:

```
/plugin marketplace add pasichDev/todo-mcp
/plugin install todo-mcp-claim@todo-mcp
```

Nothing to configure afterward — it applies automatically.

Using a different MCP host (Claude Desktop, Cursor, Windsurf, Zed, Warp, Codex)? See
[Install](#install) below for the config-file form.

## CLI Commands & Backup

`todo-mcp` is also a full terminal utility with subcommands for inspection, backup, and quick access:

```sh
# Terminal stats widget (great for tmux / prompt scripts)
npx @pasichdev/todo-mcp stats

# Quick task list in your terminal
npx @pasichdev/todo-mcp list
npx @pasichdev/todo-mcp list all

# Export tasks to Markdown or JSON
npx @pasichdev/todo-mcp export --format markdown > tasks.md
npx @pasichdev/todo-mcp export --format json --out backup.json

# Import tasks from Markdown or JSON
npx @pasichdev/todo-mcp import tasks.md
npx @pasichdev/todo-mcp import backup.json

# Encrypted full-device backup/restore — identity, todos, and paired peers, not just the
# task list (see "Data & encryption" below for what's in it and the recovery flow)
npx @pasichdev/todo-mcp backup ./todo-mcp.backup
npx @pasichdev/todo-mcp restore ./todo-mcp.backup

# Open or verify Web UI dashboard
npx @pasichdev/todo-mcp web

# Check for / install a newer version (global installs only — see Updating)
npx @pasichdev/todo-mcp check-update
npx @pasichdev/todo-mcp update
```

## Full feature reference

- **Two lists**: `todo` (near-term, actionable) and `backlog` (parked, out
  of context)
- **Rich fields**: title + separate description, category (e.g. a ticket
  id), priority, due date, source URL
- **Claim/release**: mark an item as actively being worked on so other
  agents/sessions don't duplicate the effort — shown live in the web UI with
  the claiming agent's name and a pulsing highlight
- **Full history**: every create/edit/claim/release/complete is logged with
  who and when, visible per item in both the web UI and via `todo_history`
- **Real-Time Web UI**: `http://localhost:8787` by default with SSE (Server-Sent Events) — light/dark theme, search,
  sort, inline edit, undo-delete, and responsive mobile UI
- **Secure LAN Viewer Gate**: view from your phone on the same Wi-Fi with host approval and rate-limited tokens
- **Encrypted at rest**: the data file is AES-256-GCM encrypted with a
  locally generated key (see [Data & encryption](#data--encryption))
- **Safe upgrades & Graceful Shutdown**: clean signal handling (`SIGINT`/`SIGTERM`) and version safety checks

## Install

Reference for other MCP hosts, or building from source instead of `npx`.

### Other MCP hosts

#### Claude Desktop
Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):
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

#### Cursor
Add to `.cursor/mcp.json` or Global MCP settings:
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

#### Windsurf
Add to `~/.codeium/windsurf/mcp_config.json`:
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

#### Zed
Add to `~/.config/zed/settings.json`:
```json
{
  "context_servers": {
    "todo-mcp": {
      "command": {
        "env": {},
        "path": "npx",
        "args": ["-y", "@pasichdev/todo-mcp"]
      }
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
| `todo_add(title, description?, list?, category?, priority?, dueDate?, sourceUrl?)` | Add an item. `list` is `"todo"` (default) or `"backlog"`. |
| `todo_edit(id, ...)` | Edit any subset of fields by id. Pass `""` to clear description/category/priority/dueDate/sourceUrl. |
| `todo_claim(id)` | Mark an item as actively being worked on by you. Advisory, not a lock — warns (and lets you take over) if already claimed. Auto-expires after 15 minutes if never renewed or released. |
| `todo_release(id)` | Clear your claim without completing the item. |
| `todo_list(filter?, list?, category?, agent?, session?, inProgress?, limit?, offset?)` | List items with optional filtering by status, list, category, agent, session, claim state, and token-saving pagination (`limit`/`offset`). |
| `todo_complete(id)` | Mark done (also clears any claim). |
| `todo_history(id)` | Full change log for one item — who did what, when. |
| `todo_version()` | Report the running process's data-format version and start time. |
| `todo_delete(id)` | Permanently remove an item. |
| `todo_check_update()` | Check npm for a newer todo-mcp version. Read-only — never installs anything; tells you to run `todo-mcp update` yourself. |

See [`skills/todo-mcp-claim/SKILL.md`](skills/todo-mcp-claim/SKILL.md) for
the full field/workflow reference written for an agent to follow.

## Claude Code skill

Covered in step 5 of the [Installation guide](#installation-guide) above.
The non-interactive form: `claude plugin marketplace add pasichDev/todo-mcp`
then `claude plugin install todo-mcp-claim@todo-mcp`. Source:
[`skills/todo-mcp-claim/SKILL.md`](skills/todo-mcp-claim/SKILL.md).

## Using todo-mcp with other agents

The MCP tools themselves work the same in every host — no extra setup needed
beyond [Install](#install) above. The claim-workflow *guidance* (when to
`todo_claim`/`todo_release`, which fields to set) ships as an installable
plugin for Claude Code only; every other agent reads its instructions from a
plain file in your own project, so copy the body of
[`skills/todo-mcp-claim/SKILL.md`](skills/todo-mcp-claim/SKILL.md) — everything
below the `---` frontmatter — into whichever your agent already looks for:

| Agent | File |
|---|---|
| Codex CLI, and any agent following the emerging convention | `AGENTS.md` |
| Cursor | `.cursor/rules/todo-mcp.mdc` (or `.cursorrules`) |
| Windsurf | `.windsurfrules` |
| Claude Desktop / Claude web | `CLAUDE.md` |
| Warp | Warp's own custom-instructions setting |

The content itself doesn't mention any specific host, so it's the same paste
everywhere — only the destination filename changes.

## Web UI & Security

A real-time read/write dashboard on `http://localhost:8787` (override with
`TODO_MCP_WEB_PORT`) — light/dark theme, search, sort, inline edit,
undo-delete.

### Auto-start & Process Lifecycle
Every time an MCP client connects, it checks whether something is already
listening on the web UI's port — if not, it spawns `web.js` detached in the
background. The child process survives after the short-lived MCP connection
exits, ensuring zero overhead and instant UI availability.

### Real-Time Updates (SSE)
The web UI connects to the server via Server-Sent Events (`/api/events`). When
an AI agent or peer device creates, edits, claims, or completes a task, the dashboard
updates instantly without manual page refreshes or heavy polling.

### LAN Viewer Gate & Security
The web server binds to `0.0.0.0` so you can open your dashboard from your phone or tablet on the same Wi-Fi.

**Viewer Gate:**
- Requests originating from the local machine (`127.0.0.1` / `::1`) are authenticated automatically via a per-run secure UI session token.
- Any other browser or phone on the LAN is presented with a **Viewer Gate** screen.
- The host device's dashboard receives an incoming access notification. Only when a human clicks **Approve** on the host machine is a scoped viewer token issued to the requesting browser.
- All endpoints are fortified with standard security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`) and IP rate limiting.

## Devices & sync

Pair a second computer (say, a desktop) and both keep the same list —
useful if you work from more than one machine. This is off by default and
stays off until you deliberately turn it on: nothing scans your network,
nothing connects to anything, until you open the Devices panel (the icon
in the header) and start a pairing.

**Pairing, step by step:**

1. On device A, open **Devices → Show my code**. It shows a QR code and a
   6-character code (e.g. `WY6BWK`), valid once, for 5 minutes.
2. On device B, open **Devices → I have a code**, type A's host address and
   the 6-character code (or paste the full line shown under A's QR into
   either field — both work).
3. Device A shows a pending request — *"Pairing request from \<B\>"* — with
   **Approve** / **Deny** buttons. Nothing is shared until a human clicks
   Approve on A. There is no automatic or silent pairing path.
4. Once approved, both devices independently poll each other every 15s and
   merge changes. Unpair either side at any time from the Devices panel to
   revoke it.

**Host and guest.** Every device starts out a **host** — it can invite and
approve others. The moment a device joins someone else's group via "I have a
code", it becomes a **guest**: it stays fully in sync, but the Devices panel
hides its own "Pair new device" controls, and the server rejects
invite/approve calls even if something tried to call the API directly.
Only the device that originated a group can grow it — a guest can't quietly
become a new entry point into the network. Unpairing from every peer
restores host status.

**How the trust works:** each device generates its own X25519 identity key
pair on first run (`device.json` in todo-mcp's resolved data directory) and never transmits its
private half. Pairing exchanges only the two devices' *public* keys; each
side then independently derives the same shared secret via ECDH + HKDF —
the secret itself never crosses the network in either direction, so
capturing the pairing traffic doesn't give an eavesdropper anything usable.
That secret authenticates every sync request (HMAC-SHA256 over the request,
with a signed timestamp to block replay) and encrypts every sync response
(AES-256-GCM) — sync payloads are not plaintext on the wire. The one-time
pairing token is rate-limited per source IP to make brute-forcing it impractical.

**How the merge works:** two machines can each go offline and both keep
editing. When they reconnect, changes merge **field by field** — if device
A changed the priority and device B changed the description while apart,
both changes survive; neither clobbers the other. Deletes propagate as
tombstones (so a deleted item doesn't get silently resurrected by the other
side's older copy) but an edit made *after* a delete wins and brings the
item back. A claim (`todo_claim`) syncs like any other
field, but its 15-minute lease means a stale claim fades on its own instead
of surviving forever in the replicated history.

## Updating

```sh
todo-mcp check-update   # read-only — reports current vs. latest, installs nothing
todo-mcp update         # checks, asks for confirmation, then installs
```

`update` only applies to a **global npm install** (`npm install -g @pasichdev/todo-mcp`).
Running via `npx` always fetches the latest published version on its own, so there's
nothing to update; a `git clone` checkout is updated with `git pull && npm run build`.
`update` never installs anything without asking first, and after installing it boots the
new version on a throwaway port with throwaway data to confirm it actually starts —
if that check fails, it automatically reinstalls the previous version instead of leaving
you on a broken one.

**Provenance:** every release is published with `npm publish --provenance` — a
[Sigstore-backed attestation](https://docs.npmjs.com/generating-provenance-statements)
that cryptographically ties the published package to the exact GitHub Actions run and
commit that built it, verifiable via `npm audit signatures`. This is deliberate instead
of a custom signing scheme: it reuses npm's own trusted infrastructure rather than
todo-mcp managing its own signing keys.

## Data & encryption

Data lives in the retained legacy location `~/.todo-mcp/` by default. Set
`TODO_MCP_DATA_DIR` to explicitly select a shared location. If creation of a
missing default-home directory is blocked, an explicitly configured
`$XDG_STATE_HOME` is used. If existing legacy data is inaccessible or read-only,
startup refuses rather than silently splitting the store; set
`TODO_MCP_DATA_DIR` to an approved writable durable location. If neither durable
location is writable, startup names `TODO_MCP_DATA_DIR` as the required fix rather
than creating a second list in a disposable cache. To share
one list across multiple isolated MCP hosts, set the same
`TODO_MCP_DATA_DIR` in each host's configuration.

- `todos.json.enc` — the store, AES-256-GCM encrypted
- `key` — a locally generated 256-bit key, written once with `chmod 600`
  (owner-read-only)
- `device.json` — this machine's id, display name, and X25519 identity key
  pair — private half never leaves this file
- `peers.json.enc` — paired devices and their derived sync secrets,
  encrypted the same way as the todo store
- `server.log` — plain-text process log (no todo content in it)

If you upgrade from a version before encryption was added, the old plaintext
`todos.json` is migrated automatically on first read and kept as `todos.json.bak`.

**Encrypted backup/restore:** `todo-mcp backup <file>` bundles this whole data
directory — identity, at-rest key, todos, and paired peers — into one
password-protected file (AES-256-GCM, key derived with scrypt), so a lost or
wiped machine can be brought back on the same or different hardware and still
be recognized by every device it was paired with, instead of showing up as a
new, unpaired one. `todo-mcp restore <file>` decrypts and writes it back,
renaming whatever's currently on disk aside as `.pre-restore-*.bak` first
rather than overwriting it outright. Store the backup file and its password
separately — either one alone is useless, but losing **both** makes the
backup itself unrecoverable, same as losing the file with no backup at all.

## Threat model

What todo-mcp protects against, what it deliberately doesn't, and why:

- **Disk / at-rest exposure** — see "Data & encryption" above: local-machine
  AES-256-GCM protects against accidental exposure (a stray `git add -A`, a
  backup tool that drops permissions, another account on a shared machine),
  not against someone with read access to your own user account — the key
  sits next to the data it protects.
- **LAN sniffing of device-to-device sync** — encrypted end-to-end regardless
  of transport: the shared secret is derived independently on each side via
  X25519 ECDH + HKDF and never crosses the network, every sync request is
  HMAC-signed with replay protection, and every sync response is AES-256-GCM
  encrypted. A passive LAN listener gets nothing usable from sync traffic.
- **LAN sniffing of viewer (browser) traffic** — **not** encrypted; the web
  UI is plain HTTP. Real transport encryption here would mean either a
  self-signed TLS cert (constant browser warnings on every device that opens
  the dashboard) or an app-layer scheme keyed off the viewer's own bearer
  token — which protects nothing, since that same token already travels in
  the clear and a LAN eavesdropper who can read the traffic can read the
  token. Given that, the practical mitigation is what's already in place:
  access requires a human to click **Approve** on the host device first (see
  "LAN Viewer Gate" above), so the exposure is "an already-approved LAN can
  read dashboard traffic," not "anyone on the LAN gets in."
- **A malicious or compromised peer** — sync payloads from a peer are
  validated and clamped field-by-field before touching the store (rejects
  malformed items, strips `javascript:`/`data:` URLs, drops unrecognized
  history actions and `fieldTimestamps` keys) rather than trusted wholesale,
  and a sync request body is capped at 10MB. A peer can be **revoked**
  (Devices panel) to immediately stop syncing with it without losing the
  pairing itself, or fully **unpaired** to drop it entirely.
- **A stolen/leaked viewer bearer token** — grants read/write dashboard
  access until the host explicitly revokes that viewer (Devices panel); it
  is not scoped further (no read-only mode, no per-token expiry today).
  Treat a viewer link/token the way you'd treat a shared password.
- **A compromised device** — todo-mcp does not detect or contain this; a
  device that's been compromised can read/write everything that device could
  already read/write (its own todos, and anything its paired peers sync to
  it). Revoking or unpairing it from the Devices panel of an *uncompromised*
  peer stops further sync from it.
- **Cross-site/CSRF requests against the web UI** — the session/viewer
  cookies are `SameSite=Strict` (the primary defense: a real cross-site
  request never carries them at all), plus explicit Origin/Referer
  validation on every mutating request as defense-in-depth. The Host header
  itself is also validated (rejects anything but `localhost`, an IP literal,
  or a `.local` mDNS name) to close DNS-rebinding as a way around both.
- **A malicious/tampered update** — `npm publish --provenance` (see
  "Updating" above) cryptographically ties every published version to the
  exact GitHub Actions run and commit that built it, verifiable via
  `npm audit signatures`; `todo-mcp update` also self-tests the freshly
  installed version before keeping it, and rolls back automatically if that
  fails.

## Testing

```sh
npm test
```

Runs the unit suite (`node:test`, no extra dependency) covering the sync
merge algorithm, encryption round-trips and tamper rejection, the pairing
handshake's signature/proof verification, JSON and Markdown export/import,
and UUIDv7 generation.

For an interactive check of the MCP tools themselves:

```sh
npx @modelcontextprotocol/inspector node dist/index.js
```

## License

MIT — see [LICENSE](LICENSE).
