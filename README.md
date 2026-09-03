# Docket

[![npm](https://img.shields.io/npm/v/%40pasichdev%2Fdocket.svg)](https://www.npmjs.com/package/@pasichdev/docket)
[![CI](https://github.com/pasichDev/docket/actions/workflows/ci.yml/badge.svg)](https://github.com/pasichDev/docket/actions/workflows/ci.yml)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.pasichDev%2Fdocket-blue)](https://registry.modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**One shared workspace for your AI coding agents. Local-first and
self-hostable.** Claude Code, Claude Desktop, Cursor, Windsurf, Warp, Codex —
add an item in one, see it in all of them, plus a real-time web dashboard and
your phone. Nothing gets lost switching tools or starting a new session.

Docket talks to every one of those tools over [MCP](https://modelcontextprotocol.io)
(Model Context Protocol) — that's the integration mechanism, not the product.
The product is one shared workspace: what's claimed, what's done, who did it,
and when. **Run it entirely on this machine, or self-host it on infrastructure
you control — no SaaS account either way.**

**What it adds beyond "just a list":**

- **Local or self-hosted** — keep everything on this machine, or run one
  always-on Docket Server and point every device at it (see
  [Deployment modes](#deployment-modes)).
- **See who's doing what.** Claim an item before starting on it — other
  sessions see it's taken instead of duplicating the work; atomic (`409` on a
  race) in Self-hosted Mode.
- **Full history** — every create/edit/claim/complete is logged with who and
  when.
- **Todo vs. backlog** — keep near-term work separate from things you want to
  park without losing them.
- **Private by default** — the data file is encrypted on disk (see
  [Security](#security)).
- **Real-time Web UI** — light/dark theme, search, sort, inline edit, and a
  Viewer Gate for opening it from your phone.
- **Optional multi-device P2P sync**, entirely separate from Self-hosted Mode
  — see [Devices & P2P sync](#devices--p2p-sync).

<p align="center">
  <img src="docs/assets/demo-dark.jpg" alt="Docket web dashboard, dark theme, showing a claimed in-progress item" width="49%" />
  <img src="docs/assets/demo-light.jpg" alt="Docket web dashboard, light theme, same workspace" width="49%" />
</p>

## Architecture

Docket runs in one of two deployment modes. Both give every client the exact
same MCP tools and Web UI; only *where the authoritative state lives*
differs.

**Local Mode** (the default — nothing here requires any setup beyond
[Quick start](#quick-start)):

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

**Self-hosted Mode** (opt-in):

```text
Claude / Codex / Cursor
          │
       stdio MCP
          │
   local Docket client
          │
 authenticated remote transport
          │
      Docket Server
   (an always-on machine you control)
          │
   authoritative state
```

The Docket Server is authoritative — **not** another P2P replica. Every
client becomes a thin, authenticated forwarder to it; there's no local
writable copy in this mode. A third, independent topology —
[P2P sync](#devices--p2p-sync) — replicates a full copy onto each of your own
paired devices instead; see [Deployment modes](#deployment-modes) for how all
three fit together.

## Deployment modes

|  | Local Mode | Self-hosted Mode |
|---|---|---|
| **Default?** | Yes — zero config | Opt-in |
| **Where state lives** | This machine (`~/.docket`) | The Docket Server you run |
| **Setup** | `docket setup` | `docket setup`, choose "Self-hosted", or `docket pair <url>` |
| **Web UI** | Runs on this machine | Served by the Docket Server |
| **Multi-machine** | Optional [P2P sync](#devices--p2p-sync) between your own devices | Every paired device talks to one server |
| **Good for** | A single machine, or a few you personally use | An always-on Raspberry Pi, mini PC, NAS, home server, or VPS |
| **If the connection drops** | N/A | Every read/write/claim fails clearly — never a silent local fallback |

Both modes install from the same package and expose the same MCP tools — the
difference is entirely in `docket`'s configuration, not in what your AI agent
can do. Full self-hosted setup, CLI, and what it deliberately doesn't do
(offline writes, combining with P2P sync, automatic conflict merge, hosted
accounts): **[`docs/self-hosting.md`](docs/self-hosting.md)**.

## Quick start

Five minutes, no prior MCP experience needed. This is the **Local Mode**
path — the simplest default. Want an always-on shared workspace instead? See
[`docs/self-hosting.md`](docs/self-hosting.md).

**You need:** [Claude Code](https://claude.com/claude-code) (or another MCP host) already
installed, and Node.js 18+ (`node --version`; get it from [nodejs.org](https://nodejs.org) if missing).

**1. Run the interactive setup wizard.** Creates and verifies one shared data
directory, configures detected MCP hosts, optionally installs the claim
skill:

```sh
npx -y @pasichdev/docket setup
```

**2. Register the server.**

```sh
claude mcp add docket -- npx -y @pasichdev/docket
```

**3. Restart Claude Code**, then **try it** — ask Claude *"add a todo: buy
milk"*. If it uses the tool and confirms, you're set.

**4. Open the web UI** at **http://localhost:8787** — it started itself the
moment step 3 ran.

**5. (Optional) Install the claim-tracking skill** — teaches Claude Code to
mark items in progress and check before duplicating work:

```sh
/plugin marketplace add pasichDev/docket
/plugin install docket-claim@docket
```

Using Claude Desktop, Cursor, Windsurf, Zed, or Warp instead? See
[MCP integrations](#mcp-integrations) below.

## MCP integrations

Add to your host's MCP config — same `command`/`args` shape everywhere:

```json
{
  "mcpServers": {
    "docket": { "command": "npx", "args": ["-y", "@pasichdev/docket"] }
  }
}
```

| Host | Config file |
|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| Cursor | `.cursor/mcp.json` or Global MCP settings |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Zed | `~/.config/zed/settings.json` — uses `context_servers`, see below |

<details>
<summary>Zed's config shape is slightly different</summary>

```json
{
  "context_servers": {
    "docket": { "command": { "env": {}, "path": "npx", "args": ["-y", "@pasichdev/docket"] } }
  }
}
```
</details>

Any of these hosts can also point at a **self-hosted** Docket — pair the
device first (`docket pair <url>` or `docket setup --remote <url>`), then
register the server exactly as above; nothing about the MCP host config
itself changes.

**From source:**

```sh
git clone https://github.com/pasichDev/docket.git && cd docket
npm install && npm run build
claude mcp add docket -- node "$(pwd)/dist/index.js"
```

**Non-Claude-Code agents** (Codex, Cursor, Windsurf, Warp, ...): the MCP
tools work identically everywhere; the claim-workflow *guidance* ships as an
installable plugin for Claude Code only — for every other agent, copy
[`skills/docket-claim/SKILL.md`](skills/docket-claim/SKILL.md) (everything
below the `---` frontmatter) into whichever file your agent reads
(`AGENTS.md` for Codex, `.cursor/rules/docket.mdc` for Cursor,
`.windsurfrules` for Windsurf, `CLAUDE.md` for Claude Desktop/web, or Warp's
custom-instructions setting).

## CLI

```text
docket list | stats | export | import       Workspace inspection
docket serve | pair | devices | status      Self-hosted server & devices
docket backend use <url> | localize         Switch deployment mode
docket backup <file> | restore <file>       Encrypted full-device backup
docket web                                  Ensure the Web UI is running
docket check-update | update                Version management
```

`docket help` prints the canonical, always-current list. Full flag-by-flag
reference and the complete environment-variable table:
**[`docs/cli.md`](docs/cli.md)**.

## Tools

| Tool | Description |
|---|---|
| `todo_add(title, description?, list?, category?, priority?, dueDate?, sourceUrl?)` | Add an item. `list` is `"todo"` (default) or `"backlog"`. |
| `todo_edit(id, ...)` | Edit any subset of fields by id. Pass `""` to clear an optional field. |
| `todo_claim(id)` | Mark an item as actively worked on. Advisory in Local Mode (warns/lets you take over); atomic in Self-hosted Mode. Auto-expires after 15 minutes. |
| `todo_release(id)` | Clear your claim without completing the item. |
| `todo_list(filter?, list?, category?, agent?, session?, inProgress?, limit?, offset?)` | List with filtering and token-saving pagination. |
| `todo_complete(id)` | Mark done (also clears any claim). |
| `todo_history(id)` | Full change log for one item. |
| `todo_version()` | Data-format version and process start time. |
| `todo_delete(id)` | Permanently remove an item. |
| `todo_check_update()` | Check npm for a newer version (read-only). |

Identical behavior in both deployment modes. Full field/workflow reference:
[`skills/docket-claim/SKILL.md`](skills/docket-claim/SKILL.md).

## Web UI

A real-time read/write dashboard — `http://localhost:8787` by default in
Local Mode (override with `DOCKET_WEB_PORT`), or the Docket Server's own URL
in Self-hosted Mode. Light/dark theme, search, sort, inline edit,
undo-delete, responsive mobile layout.

In Local Mode it starts itself: the first MCP client to connect spawns it
detached in the background if nothing's listening yet, and it keeps running
after that short-lived MCP connection exits — no separate install step, zero
overhead until it's actually used. Updates push live over Server-Sent Events
(`/api/events`) whenever an agent or peer changes a task, no polling.

Opening it from another device on your LAN (phone, tablet) requires an
explicit **Viewer Gate** approval from the host machine first — see
[Security](#security).

## Devices & P2P sync

Pair a second computer and both keep the same list, entirely within **Local
Mode** — off by default, nothing connects until you open the Devices panel
and start a pairing with an explicit Approve/Deny on the host device. This is
a *different topology* from Self-hosted Mode (see [Architecture](#architecture)):
P2P sync replicates a full writable copy onto each paired device, merged
field-by-field on reconnect; a Docket Server instead owns the one
authoritative copy every client forwards to.

Full pairing steps, the host/guest model, the X25519+HMAC+AES-GCM trust
model, and how the merge algorithm actually works:
**[`docs/p2p-sync.md`](docs/p2p-sync.md)**.

## Security

Docket has **four separate threat models** (encrypted local storage, P2P
sync, the LAN Viewer Gate, and self-hosted client/server traffic) — a
guarantee from one does not apply to another. The basics:

- **At rest**: the data file is AES-256-GCM encrypted with a locally
  generated key — protects against accidental exposure, not against someone
  with read access to your own user account.
- **P2P sync**: X25519 ECDH + HKDF-derived per-pair secrets, HMAC-signed
  requests with replay protection, AES-256-GCM encrypted responses. Nothing
  usable to a passive LAN listener.
- **LAN Viewer Gate**: any browser other than the host machine needs explicit
  human approval before it can open the dashboard; that local traffic itself
  is plain HTTP, not TLS (documented tradeoff, not an oversight).
- **Self-hosted mode**: every request is authenticated with a per-device
  HMAC signature (domain-separated from the P2P secret) with timestamp+nonce
  replay protection; a non-loopback `http://` server URL is refused unless
  explicitly opted into. The server itself is **not** end-to-end encrypted
  against its own operator — it holds the authoritative plaintext workspace
  while running.
- **Updates**: every release is published with Sigstore-backed npm
  provenance, verifiable with `npm audit signatures`.

None of this is simplified into vague "military-grade encryption" claims —
the full threat model, exact primitives, replay-protection details, and
self-hosted-specific limitations are in **[`docs/security.md`](docs/security.md)**.

## Data & encryption

Authoritative data lives on this client machine (`~/.docket`) in Local Mode,
or on the Docket Server in Self-hosted Mode — either way, on infrastructure
you control, never a hosted Docket account.

- `todos.json.enc` — the store, AES-256-GCM encrypted
- `key` — a locally generated 256-bit key, `chmod 600` (owner-read-only)
- `device.json` — this machine's id, name, and X25519 identity keypair (private half never leaves this file)
- `peers.json.enc` — paired P2P devices and their derived sync secrets

Set `DOCKET_DATA_DIR` to relocate/share the directory explicitly; startup
refuses to silently split an existing store rather than guessing. If you
upgrade from a version before encryption existed, the old plaintext
`todos.json` is migrated automatically and kept as `todos.json.bak`.

## Backup

`docket backup <file>` bundles the whole data directory — identity, at-rest
key, todos, paired P2P peers — into one password-protected file (AES-256-GCM,
key derived with scrypt). `docket restore <file>` decrypts and writes it
back, renaming what's currently on disk aside rather than overwriting it.
Store the file and its password separately — losing either makes it useless,
losing both makes it unrecoverable. Refuses in Self-hosted Mode; back up on
the server itself instead.

## Updating

```sh
docket check-update   # read-only — reports current vs. latest
docket update         # checks, confirms, installs, self-tests, rolls back on failure
```

Applies to a **global npm install** only; `npx` always runs latest, and a
`git clone` checkout updates with `git pull && npm run build`. Every release
ships with Sigstore npm provenance — see [Security](#security).

## Testing

```sh
npm test
```

Runs the full `node:test` suite — P2P sync merge, encryption round-trips,
pairing handshake verification, export/import, and (Self-hosted Mode) the
device HMAC auth scheme plus `docket serve`'s full `/api/v1` lifecycle
end-to-end.

## License

MIT — see [LICENSE](LICENSE).
