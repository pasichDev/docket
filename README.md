# Docket

[![npm](https://img.shields.io/npm/v/%40pasichdev%2Fdocket.svg)](https://www.npmjs.com/package/@pasichdev/docket)
[![CI](https://github.com/pasichDev/docket/actions/workflows/ci.yml/badge.svg)](https://github.com/pasichDev/docket/actions/workflows/ci.yml)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.pasichDev%2Fdocket-blue)](https://registry.modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**One workspace shared by every AI coding agent you use.** Claude Code, Claude
Desktop, Cursor, Windsurf, Warp, Codex — add an item in one, see it in all of
them, plus a real-time web dashboard and your phone. Nothing gets lost
switching tools or starting a new session.

**Run it locally, or host it yourself. No SaaS account required, either way.**

Docket talks to every one of those tools over [MCP](https://modelcontextprotocol.io)
(Model Context Protocol) — that's the integration mechanism, not the product.
The product is one shared workspace: what's claimed, what's done, who did it,
and when.

**What it adds beyond "just a list":**

- **Local or self-hosted** — keep everything on this machine, or run one
  always-on Docket Server and point every device at it (see
  [Deployment modes](#deployment-modes)).
- **See who's doing what.** Claim an item before starting on it — other
  sessions see it's taken (with a live pulsing highlight) instead of
  duplicating the work; atomic (`409` on a race) in Self-hosted Mode.
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
- **Optional multi-device P2P sync** — pair your laptop and desktop and the
  same list follows you, with an explicit approve/deny handshake on both ends
  (see [Devices & P2P sync](#devices--p2p-sync)).
- **Self-updating** — `docket check-update` / `docket update` check npm
  for a newer version, ask for confirmation, and verify the new version
  actually starts before keeping it (see [Updating](#updating)).

## Architecture

Docket runs in one of two deployment modes. Both give every client the exact
same MCP tools and Web UI; only *where the authoritative state lives* differs.

**Local Mode** (the default — nothing below requires any setup beyond
[Installation](#installation)):

```text
Claude · Codex · Cursor · Windsurf · Warp
                    │
                   MCP
                    │
                 Docket
                    │
             encrypted state
           (this machine, ~/.docket)
```

One process on this machine owns the data file; every MCP host on this
machine talks to it. Optionally [pair another machine](#devices--p2p-sync) to
replicate the same list between two-or-more of your own computers.

**Self-hosted Mode** (opt-in — see [Deployment modes](#deployment-modes)):

```text
Claude / Codex / Cursor
          │
       stdio MCP
          │
   local Docket client
          │
 authenticated remote transport
     (per-device signed requests)
          │
      Docket Server
   (docket serve, on an always-on
    machine you control)
          │
   authoritative state
```

The Docket Server is authoritative — not another P2P replica. Every client
becomes a thin, authenticated forwarder to it; there's no local writable copy
in this mode (see [Deployment modes](#deployment-modes) for what that means in
practice).

## Deployment modes

|  | Local Mode | Self-hosted Mode |
|---|---|---|
| **Default?** | Yes — zero config | Opt-in |
| **Where state lives** | This machine (`~/.docket`) | The Docket Server you run |
| **Setup** | `docket setup` | `docket setup`, choose "Self-hosted", or `docket pair <url>` |
| **Web UI** | Runs on this machine | Served by the Docket Server |
| **Multi-machine** | Optional [P2P sync](#devices--p2p-sync) between your own devices | Every paired device talks to one server |
| **Good for** | A single machine, or a small number you personally use | An always-on Raspberry Pi, Orange Pi, mini PC, NAS, home server, or VPS — a shared workspace reachable even when your laptop is off |
| **If the connection drops** | N/A — nothing to connect to | Every read/write/claim fails clearly; nothing falls back to local state (see [Non-goals](#what-self-hosted-mode-doesnt-do)) |

Both modes install from the same package and expose the same MCP tools — the
difference is entirely in `docket`'s configuration, not in what your AI agent
can do.

### Local Mode

The default. Every MCP host on this machine reads/writes `~/.docket` directly
through one shared process, with an encrypted data file and an optional
real-time Web UI. See [Installation](#installation) to get started, and
[Devices & P2P sync](#devices--p2p-sync) if you want the same list replicated
across your own laptop + desktop.

### Self-hosted Mode

For an always-on machine that keeps the workspace available even when every
laptop is off, with instantly-global claims instead of waiting on P2P
replication.

**1. Start the Docket Server**, on the always-on machine:

```sh
npm install -g @pasichdev/docket
docket serve                                          # binds 127.0.0.1:8788 by default
docket serve --host 0.0.0.0                           # accept LAN/remote connections — explicit opt-in, never the default
docket serve --port 9000 --data-dir /var/lib/docket    # or DOCKET_SERVER_HOST / DOCKET_SERVER_PORT / DOCKET_DATA_DIR
```

Binding beyond `127.0.0.1` requires an explicit `--host`/`DOCKET_SERVER_HOST`
— never the default, so a fresh `docket serve` never accidentally exposes
itself to the LAN. For anything reachable outside a trusted LAN, put a reverse
proxy (Caddy, nginx, Traefik) in front for HTTPS — Docket itself doesn't
terminate TLS. See [`docs/headless.md`](docs/headless.md) for systemd/Docker.

**2. Pair another device with it.** From the client machine:

```sh
docket pair https://docket.home.example
```

This is the same explicit-approval model as [P2P pairing](#devices--p2p-sync)
below, just against a server instead of another laptop: the client shows a
confirmation code, the request waits until a human approves it **on the
server**:

```sh
# on the server:
docket devices pending              # see requests waiting for approval
docket devices approve <requestId>  # approve one (compare its confirmation code first)
docket devices deny <requestId>     # or deny it
docket devices list                 # every paired device
docket devices revoke <deviceId>    # cut one off immediately, without unpairing everyone else
docket devices restore <deviceId>   # un-revoke it
```

Or drive the whole thing non-interactively (scripting, provisioning a fleet):

```sh
npx -y @pasichdev/docket setup --remote https://docket.home.example --yes
```

**3. Check the connection** from any paired device:

```sh
docket status
```

```text
Mode: remote
Server: https://docket.home.example
Status: connected
Latency: 18 ms
Server version: 2.3.0
Device: andrii-desktop
Device authorization: active
```

**4. Use it exactly like Local Mode** — the same MCP configuration
(`claude mcp add docket -- npx -y @pasichdev/docket`), the same tools, the
same `docket web` for the dashboard. Nothing about how you talk to Claude/
Codex/Cursor changes; only where the data actually lives does.

**Moving a workspace between modes** (always explicit, never an automatic
merge):

```sh
docket backend use https://docket.home.example   # switch to remote; uploads local data ONLY if the server is currently empty
docket backend localize                          # download the server's workspace and switch back to local
```

If both the local store and the server already have data, `backend use`
refuses outright rather than guessing how to merge them — move one side's
data manually first.

**What's different once you're on Self-hosted Mode:**

- **Every client is a thin forwarder** to the server's authoritative store —
  there is no local writable replica, and none is ever silently created.
- **Claims are atomic**, not advisory-and-eventually-consistent: two devices
  racing to claim the same item get one winner immediately (`409
  already_claimed`), with explicit `force: true` takeover available when
  that's what you actually want.
- **`docket web`** opens the server's own Web UI instead of starting a
  second, separately stateful local one.
- **`docket backup`** on a client machine refuses and points you at the
  server instead of silently backing up an unused local store — back up on
  the server itself, same as always.

<a id="what-self-hosted-mode-doesnt-do"></a>**What Self-hosted Mode does *not* do** (today):

- **No offline writes and no local fallback.** If the server can't be
  reached, every read/write/claim fails with a clear error — it never
  silently falls back to writing local state. That would create exactly the
  split-brain state this design exists to avoid.
- **No combining P2P sync and Self-hosted Mode on the same device.** A device
  paired with a Docket Server does not also participate in P2P sync with
  other peers — the server is its only source of truth while remote mode is
  active. (A self-hosted server syncing with *another* server is a possible
  future direction, not something implemented today.)
- **No automatic conflict merge.** Local Mode's P2P sync merges concurrent
  edits field-by-field; a self-hosted server instead uses optimistic
  concurrency (`If-Match` / a `409` on a stale write) — a conflicting write is
  rejected, not silently merged.
- **No multi-user accounts, no hosted cloud service.** Every paired device
  gets full read/write access to the one workspace (see
  [Security](#security)); there's no per-user login, and nobody's running
  this for you — you run `docket serve` on infrastructure you control.

## Installation

Five minutes, no prior MCP experience needed. This is the **Local Mode**
path — the simplest default. Want an always-on shared workspace instead? See
[Self-hosted Mode](#self-hosted-mode) above.

**You need:** [Claude Code](https://claude.com/claude-code) (or another MCP host) already
installed, and Node.js 18+ (check with `node --version` in a terminal — if
that command isn't found, get Node from [nodejs.org](https://nodejs.org)).

**1. Run the interactive setup wizard.** It creates and verifies one shared
durable data directory, configures detected MCP hosts, optionally installs the
claim skill for Claude Code and Codex, and can add a `todo_stats` helper to your shell startup:

```sh
npx -y @pasichdev/docket setup
```

The wizard writes host configuration automatically when Codex, Claude Code,
Cursor, or Windsurf is detected. For automation or a non-interactive terminal,
pass the directory explicitly:

```sh
npx -y @pasichdev/docket setup --data-dir "$HOME/.local/state/docket"
```

The printed `DOCKET_DATA_DIR` is the value used in those host entries. The
wizard merges existing JSON configuration and does not replace unrelated
servers.

**2. Register the server.** Open a terminal and run:

```sh
claude mcp add docket -- npx -y @pasichdev/docket
```

This just tells Claude Code how to start Docket — nothing is downloaded
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
/plugin marketplace add pasichDev/docket
/plugin install docket-claim@docket
```

Nothing to configure afterward — it applies automatically.

Using a different MCP host (Claude Desktop, Cursor, Windsurf, Zed, Warp, Codex)? See
[MCP integrations](#mcp-integrations) below for the config-file form.

## MCP integrations

### Other MCP hosts

#### Claude Desktop
Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):
```json
{
  "mcpServers": {
    "docket": {
      "command": "npx",
      "args": ["-y", "@pasichdev/docket"]
    }
  }
}
```

#### Cursor
Add to `.cursor/mcp.json` or Global MCP settings:
```json
{
  "mcpServers": {
    "docket": {
      "command": "npx",
      "args": ["-y", "@pasichdev/docket"]
    }
  }
}
```

#### Windsurf
Add to `~/.codeium/windsurf/mcp_config.json`:
```json
{
  "mcpServers": {
    "docket": {
      "command": "npx",
      "args": ["-y", "@pasichdev/docket"]
    }
  }
}
```

#### Zed
Add to `~/.config/zed/settings.json`:
```json
{
  "context_servers": {
    "docket": {
      "command": {
        "env": {},
        "path": "npx",
        "args": ["-y", "@pasichdev/docket"]
      }
    }
  }
}
```

Any of these hosts can also point at a **self-hosted** Docket the same way —
pair the device first (`docket pair <url>` or `docket setup --remote <url>`),
then register the server exactly as above; the client transparently talks to
the paired server instead of local storage. Nothing about the MCP host config
itself changes.

### From source

```sh
git clone https://github.com/pasichDev/docket.git
cd docket
npm install
npm run build
claude mcp add docket -- node "$(pwd)/dist/index.js"
```

### Claude Code skill

Covered in step 6 of [Installation](#installation) above.
The non-interactive form: `claude plugin marketplace add pasichDev/docket`
then `claude plugin install docket-claim@docket`. Source:
[`skills/docket-claim/SKILL.md`](skills/docket-claim/SKILL.md).

### Using Docket with other agents

The MCP tools themselves work the same in every host — no extra setup needed
beyond the integrations above. The claim-workflow *guidance* (when to
`todo_claim`/`todo_release`, which fields to set) ships as an installable
plugin for Claude Code only; every other agent reads its instructions from a
plain file in your own project, so copy the body of
[`skills/docket-claim/SKILL.md`](skills/docket-claim/SKILL.md) — everything
below the `---` frontmatter — into whichever your agent already looks for:

| Agent | File |
|---|---|
| Codex CLI, and any agent following the emerging convention | `AGENTS.md` |
| Cursor | `.cursor/rules/docket.mdc` (or `.cursorrules`) |
| Windsurf | `.windsurfrules` |
| Claude Desktop / Claude web | `CLAUDE.md` |
| Warp | Warp's own custom-instructions setting |

The content itself doesn't mention any specific host, so it's the same paste
everywhere — only the destination filename changes.

## CLI

`docket` is a full terminal utility beyond the MCP server — inspection,
backup, and (in Self-hosted Mode) server administration:

```text
Workspace
  docket list [open|done|all]     List todos (default: open)
  docket stats                    Terminal stats widget with active claims
  docket export [options]         Export to stdout/file — --format json|markdown, --out <file>
  docket import <file>            Import from a JSON or Markdown file

Server / Deployment
  docket serve [--host <addr>] [--port <n>] [--data-dir <path>]
                                   Run an authoritative Docket Server
  docket setup [--data-dir <path> | --remote <url>] [--yes]
                                   Interactive local/self-hosted setup wizard
  docket pair <serverUrl>         Pair this device with a Docket Server
  docket devices <sub>            pair | pending | approve | deny | list | revoke | restore
                                   — manage devices paired with a `docket serve` on THIS machine
  docket status                   Deployment mode + connection/store health
  docket backend use <url>        Switch this device to a self-hosted server
  docket backend localize         Download the server's workspace, switch back to local

Backup
  docket backup <file>            Encrypted full-device backup (identity, todos, peers)
  docket restore <file>           Restore — REPLACES this device's identity/todos/peers

Web UI
  docket web                      Ensure the Web UI is running and print its URL

Updates
  docket check-update             Check npm for a newer version (read-only)
  docket update                   Check, confirm, install, self-test, roll back on failure
```

Every command above is real, current CLI surface — run `docket help` any
time for the canonical list with full descriptions.

**Environment variables:**

| Variable | Purpose | Default |
|---|---|---|
| `DOCKET_DATA_DIR` | Where local state lives | `~/.docket` |
| `DOCKET_WEB_PORT` | Local Web UI port | `8787` |
| `DOCKET_MODE` | `local` or `remote` | `local` |
| `DOCKET_SERVER_URL` | Server URL when `DOCKET_MODE=remote` | — |
| `DOCKET_ALLOW_INSECURE_REMOTE` | Allow a non-HTTPS remote server URL (trusted-LAN dev only) | unset (HTTPS required) |
| `DOCKET_SERVER_HOST` | Bind address for `docket serve` | `127.0.0.1` |
| `DOCKET_SERVER_PORT` | Port for `docket serve` | `8788` |

## Tools

| Tool | Description |
|---|---|
| `todo_add(title, description?, list?, category?, priority?, dueDate?, sourceUrl?)` | Add an item. `list` is `"todo"` (default) or `"backlog"`. |
| `todo_edit(id, ...)` | Edit any subset of fields by id. Pass `""` to clear description/category/priority/dueDate/sourceUrl. |
| `todo_claim(id)` | Mark an item as actively being worked on by you. Advisory in Local Mode (warns and lets you take over if already claimed); atomic in Self-hosted Mode (see [Deployment modes](#deployment-modes)). Auto-expires after 15 minutes if never renewed or released. |
| `todo_release(id)` | Clear your claim without completing the item. |
| `todo_list(filter?, list?, category?, agent?, session?, inProgress?, limit?, offset?)` | List items with optional filtering by status, list, category, agent, session, claim state, and token-saving pagination (`limit`/`offset`). |
| `todo_complete(id)` | Mark done (also clears any claim). |
| `todo_history(id)` | Full change log for one item — who did what, when. |
| `todo_version()` | Report the running process's data-format version and start time. |
| `todo_delete(id)` | Permanently remove an item. |
| `todo_check_update()` | Check npm for a newer Docket version. Read-only — never installs anything; tells you to run `docket update` yourself. |

These tools behave identically in both deployment modes — the MCP host never
knows or needs to know whether it's talking to local storage or a Docket
Server. See [`skills/docket-claim/SKILL.md`](skills/docket-claim/SKILL.md)
for the full field/workflow reference written for an agent to follow.

## Web UI

A real-time read/write dashboard — `http://localhost:8787` by default in
Local Mode (override with `DOCKET_WEB_PORT`), or the Docket Server's own URL
in Self-hosted Mode. Light/dark theme, search, sort, inline edit,
undo-delete, responsive mobile layout.

### Auto-start & process lifecycle (Local Mode)
Every time an MCP client connects, it checks whether something is already
listening on the web UI's port — if not, it spawns `web.js` detached in the
background. The child process survives after the short-lived MCP connection
exits, ensuring zero overhead and instant UI availability.

### Real-time updates (SSE)
The web UI connects to the server via Server-Sent Events (`/api/events`). When
an AI agent or peer device creates, edits, claims, or completes a task, the dashboard
updates instantly without manual page refreshes or heavy polling.

### LAN Viewer Gate
The web server binds to `0.0.0.0` so you can open your dashboard from your phone or tablet on the same Wi-Fi.

- Requests originating from the local machine (`127.0.0.1` / `::1`) are authenticated automatically via a per-run secure UI session token.
- Any other browser or phone on the LAN is presented with a **Viewer Gate** screen.
- The host device's dashboard receives an incoming access notification. Only when a human clicks **Approve** on the host machine is a scoped viewer token issued to the requesting browser.
- All endpoints are fortified with standard security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`) and IP rate limiting.

## Devices & P2P sync

Pair a second computer (say, a desktop) and both keep the same list —
useful if you work from more than one machine, entirely within **Local
Mode**. This is off by default and stays off until you deliberately turn it
on: nothing scans your network, nothing connects to anything, until you open
the Devices panel (the icon in the header) and start a pairing.

**This is a different topology from Self-hosted Mode above.** P2P sync
replicates a full writable copy onto each paired device:

```text
device A ↔ device B
```

A Docket Server instead owns the one authoritative copy that every client
forwards to:

```text
A ─┐
B ─┼→ Docket Server
C ─┘
```

A device connected to a Docket Server does not also run P2P sync with other
peers — see [What Self-hosted Mode does *not* do](#what-self-hosted-mode-doesnt-do).

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
pair on first run (`device.json` in Docket's resolved data directory) and never transmits its
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

(This field-by-field automatic merge is specific to P2P sync — a Docket
Server instead uses `If-Match`/`409` optimistic concurrency; see
[Deployment modes](#deployment-modes).)

## Security

Docket has **four separate threat models** — don't assume a guarantee from
one applies to another:

1. **Encrypted local storage** — protects the data file at rest.
2. **P2P sync** (Local Mode, [Devices & P2P sync](#devices--p2p-sync)) — protects device-to-device replication traffic.
3. **LAN browser Viewer Gate** ([Web UI](#web-ui)) — gates *who* can open the dashboard from another device.
4. **Self-hosted client/server traffic** (this section) — protects a client talking to a Docket Server.

None of these claim to be "military-grade encryption" or similarly vague —
each uses a specific, named primitive, documented below and in
[Data & encryption](#data--encryption).

### Self-hosted authentication

- **Device identity**: the same X25519 keypair each device already generates
  for P2P sync ([Devices & P2P sync](#devices--p2p-sync)) is reused for
  server auth — but with its **own, domain-separated HKDF label**
  (`docket/server-auth/v1`, vs. P2P sync's own label) so the two protocols
  never derive the same secret bytes, even if a device is paired with both a
  peer and a server.
- **Pairing**: short-lived, single-use code (same shape as P2P pairing),
  per-source-IP rate limited, requires explicit human approval on the server
  (`docket devices approve`) — never automatic. The client computes a
  confirmation code from the shared secret and **aborts the pairing** if the
  server-reported code doesn't match what the human expects to see — a real
  check against an active man-in-the-middle, not just a value that's
  displayed and ignored.
- **Request authentication**: every authenticated request carries
  `X-Docket-Device` / `X-Docket-Timestamp` / `X-Docket-Nonce` /
  `X-Docket-Signature` headers. The signature is HMAC-SHA256 over
  `method\npath\ntimestamp\nnonce\nbodyHash`, keyed by the ECDH+HKDF-derived
  per-device secret above.
- **Replay protection**: the server rejects a timestamp more than 5 minutes
  old, and rejects a reused `(device, nonce)` pair within that window via an
  in-memory replay cache.
- **Transport requirements**: a non-loopback `http://` server URL is refused
  unless you explicitly opt in with `DOCKET_ALLOW_INSECURE_REMOTE=1` (trusted
  LAN development only) — Docket never silently downgrades `https://` to
  `http://`. Docket itself doesn't terminate TLS; put a reverse proxy in
  front for anything reachable outside a trusted LAN.
- **Revocation**: `docket devices revoke <deviceId>` cuts off one device
  immediately, without needing to rotate any secret shared by other devices
  — each device's server-auth secret is derived independently.
- **Protocol/version compatibility**: `GET /api/v1/info` reports the
  server's protocol version; a client refuses to talk to an incompatible
  server rather than guessing at how to speak an unknown version (RFC §23).

### What the local-storage / P2P / Viewer Gate threat models cover

- **Disk / at-rest exposure** — local-machine AES-256-GCM protects against
  accidental exposure (a stray `git add -A`, a backup tool that drops
  permissions, another account on a shared machine), not against someone
  with read access to your own user account — the key sits next to the data
  it protects.
- **LAN sniffing of P2P sync traffic** — encrypted end-to-end regardless of
  transport: the shared secret is derived independently on each side via
  X25519 ECDH + HKDF and never crosses the network, every sync request is
  HMAC-signed with replay protection, and every sync response is AES-256-GCM
  encrypted. A passive LAN listener gets nothing usable from sync traffic.
- **LAN sniffing of viewer (browser) traffic** — **not** encrypted; the local
  web UI is plain HTTP. Real transport encryption here would mean either a
  self-signed TLS cert (constant browser warnings on every device that opens
  the dashboard) or an app-layer scheme keyed off the viewer's own bearer
  token — which protects nothing, since that same token already travels in
  the clear and a LAN eavesdropper who can read the traffic can read the
  token. Given that, the practical mitigation is what's already in place:
  access requires a human to click **Approve** on the host device first (see
  [Web UI](#web-ui)), so the exposure is "an already-approved LAN can read
  dashboard traffic," not "anyone on the LAN gets in."
- **A malicious or compromised P2P peer** — sync payloads from a peer are
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
- **A compromised device** — Docket does not detect or contain this; a
  device that's been compromised can read/write everything that device could
  already read/write (its own todos, and anything its paired peers sync to
  it). Revoking or unpairing it from the Devices panel of an *uncompromised*
  peer stops further sync from it.
- **Cross-site/CSRF requests against the (local) web UI** — the
  session/viewer cookies are `SameSite=Strict` (the primary defense: a real
  cross-site request never carries them at all), plus explicit Origin/
  Referer validation on every mutating request as defense-in-depth. The Host
  header itself is also validated (rejects anything but `localhost`, an IP
  literal, or a `.local` mDNS name) to close DNS-rebinding as a way around
  both.
- **A malicious/tampered update** — `npm publish --provenance` (see
  [Updating](#updating)) cryptographically ties every published version to
  the exact GitHub Actions run and commit that built it, verifiable via
  `npm audit signatures`; `docket update` also self-tests the freshly
  installed version before keeping it, and rolls back automatically if that
  fails.

### Self-hosted-specific limitations

- **A compromised paired client** — in v1 every paired device gets full
  read/write access to the server's workspace (no viewer/read-only role for
  server clients yet); a compromised device can do anything a legitimate
  client could until it's revoked.
- **The server itself is not end-to-end encrypted against its own
  operator.** It holds the authoritative plaintext workspace in memory (and,
  at rest, under the same at-rest encryption as Local Mode) while running,
  and can read it. This is a deliberate, explicit scope boundary —
  self-hosting trades "nobody but this device can read my data" for "one
  machine I control is the source of truth," which is not the same guarantee
  as Local Mode's per-device isolation. Choose Local Mode instead if that
  distinction matters for your threat model.

## Data & encryption

**Where authoritative data lives depends on the deployment mode:**

```text
Local Mode:        this client machine (~/.docket)
Self-hosted Mode:   the Docket Server
```

Your data stays on infrastructure you control either way — Docket requires
no hosted Docket account or SaaS backend in either mode.

**Local Mode's data directory:** `~/.docket` by default. Set `DOCKET_DATA_DIR`
to explicitly select a shared location. If creation of a missing default-home
directory is blocked, an explicitly configured `$XDG_STATE_HOME` is used. If
existing legacy data is inaccessible or read-only, startup refuses rather
than silently splitting the store; set `DOCKET_DATA_DIR` to an approved
writable durable location. If neither durable location is writable, startup
names `DOCKET_DATA_DIR` as the required fix rather than creating a second
list in a disposable cache. To share one list across multiple isolated MCP
hosts, set the same `DOCKET_DATA_DIR` in each host's configuration. (A
self-hosted Docket Server uses the same on-disk format and the same
`DOCKET_DATA_DIR` resolution, just on the server machine instead — see
[Self-hosted Mode](#self-hosted-mode).)

- `todos.json.enc` — the store, AES-256-GCM encrypted
- `key` — a locally generated 256-bit key, written once with `chmod 600`
  (owner-read-only)
- `device.json` — this machine's id, display name, and X25519 identity key
  pair — private half never leaves this file
- `peers.json.enc` — paired P2P devices and their derived sync secrets,
  encrypted the same way as the todo store
- `server.log` — plain-text process log (no todo content in it)

If you upgrade from a version before encryption was added, the old plaintext
`todos.json` is migrated automatically on first read and kept as `todos.json.bak`.

## Backup

**Encrypted full-device backup/restore:** `docket backup <file>` bundles this
whole data directory — identity, at-rest key, todos, and paired P2P peers —
into one password-protected file (AES-256-GCM, key derived with scrypt), so a
lost or wiped machine can be brought back on the same or different hardware
and still be recognized by every device it was paired with, instead of
showing up as a new, unpaired one. `docket restore <file>` decrypts and
writes it back, renaming whatever's currently on disk aside as
`.pre-restore-*.bak` first rather than overwriting it outright. Store the
backup file and its password separately — either one alone is useless, but
losing **both** makes the backup itself unrecoverable, same as losing the
file with no backup at all.

In **Self-hosted Mode**, `docket backup` on a client refuses and points you
at the server — back up the server's own data directory instead, using the
same command run there.

## Updating

```sh
docket check-update   # read-only — reports current vs. latest, installs nothing
docket update         # checks, asks for confirmation, then installs
```

`update` only applies to a **global npm install** (`npm install -g @pasichdev/docket`).
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
Docket managing its own signing keys.

## Testing

```sh
npm test
```

Runs the unit + integration suite (`node:test`, no extra dependency) covering
the P2P sync merge algorithm, encryption round-trips and tamper rejection,
the P2P pairing handshake's signature/proof verification, JSON and Markdown
export/import, UUIDv7 generation, and — for Self-hosted Mode — the device
HMAC auth scheme, `docket serve`'s full `/api/v1` lifecycle end-to-end
(claims, `If-Match` conflicts, SSE), and the local/remote deployment-mode
switch.

For an interactive check of the MCP tools themselves:

```sh
npx @modelcontextprotocol/inspector node dist/index.js
```

## License

MIT — see [LICENSE](LICENSE).
