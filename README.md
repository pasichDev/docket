# Docket

[![npm](https://img.shields.io/npm/v/%40pasichdev%2Fdocket.svg)](https://www.npmjs.com/package/@pasichdev/docket)
[![CI](https://github.com/pasichDev/docket/actions/workflows/ci.yml/badge.svg)](https://github.com/pasichDev/docket/actions/workflows/ci.yml)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.pasichDev%2Fdocket-blue)](https://registry.modelcontextprotocol.io)
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
                    Docket  ---->  Encrypted list (your machine)
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
- **Self-updating** — `docket check-update` / `docket update` check npm
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
[Install](#install) below for the config-file form.

## CLI Commands & Backup

`docket` is also a full terminal utility with subcommands for inspection, backup, and quick access:

```sh
# Terminal stats widget (great for tmux / prompt scripts)
npx @pasichdev/docket stats

# Quick task list in your terminal
npx @pasichdev/docket list
npx @pasichdev/docket list all

# Export tasks to Markdown or JSON
npx @pasichdev/docket export --format markdown > tasks.md
npx @pasichdev/docket export --format json --out backup.json

# Import tasks from Markdown or JSON
npx @pasichdev/docket import tasks.md
npx @pasichdev/docket import backup.json

# Encrypted full-device backup/restore — identity, todos, and paired peers, not just the
# task list (see "Data & encryption" below for what's in it and the recovery flow)
npx @pasichdev/docket backup ./docket.backup
npx @pasichdev/docket restore ./docket.backup

# Open or verify Web UI dashboard
npx @pasichdev/docket web

# Check for / install a newer version (global installs only — see Updating)
npx @pasichdev/docket check-update
npx @pasichdev/docket update
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

### From source

```sh
git clone https://github.com/pasichDev/docket.git
cd docket
npm install
npm run build
claude mcp add docket -- node "$(pwd)/dist/index.js"
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
| `todo_check_update()` | Check npm for a newer Docket version. Read-only — never installs anything; tells you to run `docket update` yourself. |

See [`skills/docket-claim/SKILL.md`](skills/docket-claim/SKILL.md) for
the full field/workflow reference written for an agent to follow.

## Claude Code skill

Covered in step 5 of the [Installation guide](#installation-guide) above.
The non-interactive form: `claude plugin marketplace add pasichDev/docket`
then `claude plugin install docket-claim@docket`. Source:
[`skills/docket-claim/SKILL.md`](skills/docket-claim/SKILL.md).

## Using Docket with other agents

The MCP tools themselves work the same in every host — no extra setup needed
beyond [Install](#install) above. The claim-workflow *guidance* (when to
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

## Web UI & Security

A real-time read/write dashboard on `http://localhost:8787` (override with
`DOCKET_WEB_PORT`) — light/dark theme, search, sort, inline edit,
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

## Local vs self-hosted server

By default docket runs entirely **local**: every MCP host on this machine talks to a
process that reads/writes `~/.docket` directly — nothing changes here, ever, unless you
opt in.

If you have an always-on machine (a Raspberry Pi, a mini PC, a NAS, a home server, a VPS),
you can instead point every device at one **self-hosted docket server**: one authoritative
copy, a Web UI that's up even when your laptop is off, and claims that are instantly global
instead of waiting on P2P replication. This is a different topology from
[Devices & sync](#devices--sync) above (which replicates copies between peers) — a remote
client does **not** also participate in P2P sync; the server is its only source of truth.

```text
Deployment

● Local              Store everything on this device.
○ Self-hosted server Use an existing docket server.
```

**Set it up:**

```sh
npx -y @pasichdev/docket setup
```

Choose "Self-hosted docket server", enter its address, and pair this device with a
short-lived code — same explicit-approval model as [Devices & sync](#devices--sync)'s
peer pairing, just against a server instead of another laptop. Or drive it directly:

```sh
docket pair https://todo.home.example

# Non-interactive (scripting, provisioning a fleet of devices):
npx -y @pasichdev/docket setup --remote https://todo.home.example --yes
```

**Run the server** (on the always-on machine):

```sh
docket serve                        # binds 127.0.0.1:8788 by default — RFC-required explicit opt-in to bind wider
docket serve --host 0.0.0.0         # accept LAN/remote connections (put a reverse proxy + HTTPS in front for anything off-LAN)
docket serve --port 9000 --data-dir /var/lib/docket   # or DOCKET_SERVER_HOST / DOCKET_SERVER_PORT / DOCKET_DATA_DIR
docket devices pair                 # generate a pairing code for a new device
docket devices pending              # review requests waiting for approval
docket devices approve <requestId>  # approve one
docket devices deny <requestId>     # or deny it
docket devices list                 # see every paired device
docket devices revoke <deviceId>    # cut off one device immediately, without unpairing everyone else
docket devices restore <deviceId>   # un-revoke it
```

**Check on it from any paired device:**

```sh
docket status
```

```text
Mode: remote
Server: https://todo.home.example
Status: connected
Latency: 18 ms
Server version: 2.3.0
Device: andrii-desktop
Device authorization: active
```

**Move a workspace between modes** (RFC §28/§29 — always explicit, never an automatic
merge):

```sh
docket backend use https://todo.home.example   # switch to remote; uploads local data only if the server is currently empty
docket backend localize                        # download the server's workspace and switch back to local
```

**What's different in remote mode:**

- **Every client is a thin forwarder** to the server's authoritative store — there is no
  local writable replica, and (per the RFC's core invariant) none is ever silently created.
- **A connectivity failure fails loudly.** If the server can't be reached, every read/write/
  claim errors clearly instead of silently falling back to a local copy — that would create
  exactly the split-brain state this design avoids.
- **Claims are atomic**, not advisory-and-eventually-consistent: two devices racing to claim
  the same item get one winner immediately (`409 already_claimed`), with explicit
  `force: true` takeover available when that's what you actually want.
- **`docket web`** opens the server's own Web UI instead of starting a second, separately
  stateful local one.
- **`docket backup`** on a client machine doesn't back up the (empty/unused) local store —
  run backups on the server itself, same as always.

**Headless deployment** (systemd unit, Docker image for `linux/amd64`/`linux/arm64`, safe
upgrade steps): see [`docs/headless.md`](docs/headless.md).

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

## Data & encryption

Data lives in the retained legacy location `~/.docket/` by default. Set
`DOCKET_DATA_DIR` to explicitly select a shared location. If creation of a
missing default-home directory is blocked, an explicitly configured
`$XDG_STATE_HOME` is used. If existing legacy data is inaccessible or read-only,
startup refuses rather than silently splitting the store; set
`DOCKET_DATA_DIR` to an approved writable durable location. If neither durable
location is writable, startup names `DOCKET_DATA_DIR` as the required fix rather
than creating a second list in a disposable cache. To share
one list across multiple isolated MCP hosts, set the same
`DOCKET_DATA_DIR` in each host's configuration.

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

**Encrypted backup/restore:** `docket backup <file>` bundles this whole data
directory — identity, at-rest key, todos, and paired peers — into one
password-protected file (AES-256-GCM, key derived with scrypt), so a lost or
wiped machine can be brought back on the same or different hardware and still
be recognized by every device it was paired with, instead of showing up as a
new, unpaired one. `docket restore <file>` decrypts and writes it back,
renaming whatever's currently on disk aside as `.pre-restore-*.bak` first
rather than overwriting it outright. Store the backup file and its password
separately — either one alone is useless, but losing **both** makes the
backup itself unrecoverable, same as losing the file with no backup at all.

## Threat model

What Docket protects against, what it deliberately doesn't, and why:

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
- **A compromised device** — Docket does not detect or contain this; a
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
  `npm audit signatures`; `docket update` also self-tests the freshly
  installed version before keeping it, and rolls back automatically if that
  fails.

**Additions specific to a self-hosted server** (see
[Local vs self-hosted server](#local-vs-self-hosted-server) above):

- **A network observer between a client and the server** — every request is
  authenticated with a per-device HMAC signature (timestamp + nonce + body
  hash, so a captured request can't be replayed) on top of TLS; docket
  refuses a non-loopback `http://` server URL unless you explicitly opt in
  (`DOCKET_ALLOW_INSECURE_REMOTE`), and never silently downgrades HTTPS to
  HTTP.
- **A stolen or guessed pairing code** — same shape as peer pairing above:
  short TTL, single use, per-source-IP rate limiting, and it only ever grants
  access after a human explicitly approves the request on the server
  (`docket devices approve`) — never automatically.
- **Leaked device credentials** — revoking that one device
  (`docket devices revoke <deviceId>`) cuts it off immediately without
  needing to rotate anything shared by every other device, since each
  device's server-auth secret is derived independently (ECDH + HKDF, domain-
  separated from the P2P sync secret so the two protocols never share key
  material).
- **A compromised paired client** — in v1 every paired device gets full
  read/write access to the server's workspace (no viewer/read-only role for
  server clients yet); a compromised device can do anything a legitimate
  client could until it's revoked.
- **The server itself** — a self-hosted server is **not** end-to-end
  encrypted against its own operator: it holds the authoritative plaintext
  workspace in memory (and at rest, under the same at-rest encryption as
  local mode) while running, and can read it. This is a deliberate, explicit
  scope boundary (RFC §31) — self-hosting trades "nobody but this device can
  read my data" for "one machine I control is the source of truth," which is
  not the same guarantee as local mode's per-device isolation. Choose local
  mode instead if that distinction matters for your threat model.

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
