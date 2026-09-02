# Self-hosting Docket

For an always-on machine that keeps the workspace available even when every
laptop is off, with instantly-global claims instead of waiting on P2P
replication. See the [README's Deployment modes](../README.md#deployment-modes)
for how this compares to Local Mode and [P2P sync](p2p-sync.md).

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
in this mode.

## 1. Start the Docket Server

On the always-on machine:

```sh
npm install -g @pasichdev/docket
docket serve                                          # binds 127.0.0.1:8788 by default
docket serve --host 0.0.0.0                           # accept LAN/remote connections — explicit opt-in, never the default
docket serve --port 9000 --data-dir /var/lib/docket    # or DOCKET_SERVER_HOST / DOCKET_SERVER_PORT / DOCKET_DATA_DIR
```

Binding beyond `127.0.0.1` requires an explicit `--host`/`DOCKET_SERVER_HOST`
— never the default, so a fresh `docket serve` never accidentally exposes
itself to the LAN. For anything reachable outside a trusted LAN, put a
reverse proxy (Caddy, nginx, Traefik) in front for HTTPS — Docket itself
doesn't terminate TLS. See [`headless.md`](headless.md) for a full
systemd/Docker walkthrough.

## 2. Pair another device with it

From the client machine:

```sh
docket pair https://docket.home.example
```

This is the same explicit-approval model as [P2P pairing](p2p-sync.md), just
against a server instead of another laptop: the client shows a confirmation
code, the request waits until a human approves it **on the server**:

```sh
# on the server:
docket devices pair                 # generate a pairing code for a new device
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

## 3. Check the connection

From any paired device:

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

## 4. Use it exactly like Local Mode

Same MCP configuration (`claude mcp add docket -- npx -y @pasichdev/docket`),
same tools, same `docket web` for the dashboard. Nothing about how you talk
to Claude/Codex/Cursor changes; only where the data actually lives does.

## Moving a workspace between modes

Always explicit, never an automatic merge:

```sh
docket backend use https://docket.home.example   # switch to remote; uploads local data ONLY if the server is currently empty
docket backend localize                          # download the server's workspace and switch back to local
```

If both the local store and the server already have data, `backend use`
refuses outright rather than guessing how to merge them — move one side's
data manually first.

## What's different once you're on Self-hosted Mode

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

## What Self-hosted Mode does not do

(Today — see the RFC's "Future Hybrid Mode" notes if this changes later.)

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
  [`security.md`](security.md)); there's no per-user login, and nobody's
  running this for you — you run `docket serve` on infrastructure you
  control.

## Security

Device pairing, request authentication, replay protection, transport
requirements, revocation, and self-hosted-specific limitations are covered
in full in [`security.md`](security.md#4-self-hosted-clientserver-traffic) —
worth reading before trusting a self-hosted workspace with anything
sensitive.

## Headless deployment

systemd unit, Docker image (`linux/amd64`/`linux/arm64`), and safe upgrade
steps: see [`headless.md`](headless.md).

## Full CLI reference

Every `docket serve`/`devices`/`pair`/`status`/`backend` flag and every
`DOCKET_*` environment variable: see [`cli.md`](cli.md).
