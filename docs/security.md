# Security & threat model

Docket has **four separate threat models** — don't assume a guarantee from one
applies to another:

1. **Encrypted local storage** — protects the data file at rest.
2. **P2P sync** (Local Mode — see [`p2p-sync.md`](p2p-sync.md)) — protects device-to-device replication traffic.
3. **LAN browser Viewer Gate** (the local Web UI) — gates *who* can open the dashboard from another device.
4. **Self-hosted client/server traffic** (this page) — protects a client talking to a Docket Server.

None of these claim to be "military-grade encryption" or similarly vague —
each uses a specific, named primitive, documented below and in the
[README's Data & encryption section](../README.md#data--encryption).

## 1. Encrypted local storage

- **Disk / at-rest exposure** — local-machine AES-256-GCM protects against
  accidental exposure (a stray `git add -A`, a backup tool that drops
  permissions, another account on a shared machine), **not** against someone
  with read access to your own user account — the key sits next to the data
  it protects (`key` and `todos.json.enc` live in the same data directory).
- **A malicious/tampered update** — every release is published with
  `npm publish --provenance`, a Sigstore-backed attestation that
  cryptographically ties the published package to the exact GitHub Actions
  run and commit that built it, verifiable via `npm audit signatures`.
  `docket update` also self-tests the freshly installed version before
  keeping it, and rolls back automatically if that fails. See the
  [README's Updating section](../README.md#backup--updating).

## 2. P2P sync (Local Mode)

Full pairing/crypto/merge mechanics are documented in
[`p2p-sync.md`](p2p-sync.md). The relevant guarantees:

- **LAN sniffing of P2P sync traffic** — encrypted end-to-end regardless of
  transport: the shared secret is derived independently on each side via
  X25519 ECDH + HKDF and never crosses the network, every sync request is
  HMAC-signed with replay protection, and every sync response is AES-256-GCM
  encrypted. A passive LAN listener gets nothing usable from sync traffic.
- **A malicious or compromised P2P peer** — sync payloads from a peer are
  validated and clamped field-by-field before touching the store (rejects
  malformed items, strips `javascript:`/`data:` URLs, drops unrecognized
  history actions and `fieldTimestamps` keys) rather than trusted wholesale,
  and a sync request body is capped at 10MB. A peer can be **revoked**
  (Devices panel) to immediately stop syncing with it without losing the
  pairing itself, or fully **unpaired** to drop it entirely.
- **A compromised device** — Docket does not detect or contain this; a
  device that's been compromised can read/write everything that device could
  already read/write (its own todos, and anything its paired peers sync to
  it). Revoking or unpairing it from the Devices panel of an *uncompromised*
  peer stops further sync from it.

## 3. LAN browser Viewer Gate (local Web UI)

- **Requests from the local machine** (`127.0.0.1` / `::1`) are authenticated
  automatically via a per-run secure UI session token.
- **Any other browser or phone on the LAN** is presented with a Viewer Gate
  screen; the host device's dashboard receives an incoming access
  notification, and only when a human clicks **Approve** on the host machine
  is a scoped viewer token issued to the requesting browser. There is no
  automatic or silent approval path.
- **LAN sniffing of viewer (browser) traffic** — **not** encrypted; the local
  web UI is plain HTTP. Real transport encryption here would mean either a
  self-signed TLS cert (constant browser warnings on every device that opens
  the dashboard) or an app-layer scheme keyed off the viewer's own bearer
  token — which protects nothing, since that same token already travels in
  the clear and a LAN eavesdropper who can read the traffic can read the
  token. Given that, the practical mitigation is what's already in place:
  access requires a human to click Approve on the host device first, so the
  exposure is "an already-approved LAN can read dashboard traffic," not
  "anyone on the LAN gets in."
- **A stolen/leaked viewer bearer token** — grants read/write dashboard
  access until the host explicitly revokes that viewer (Devices panel); it
  is not scoped further (no read-only mode, no per-token expiry today).
  Treat a viewer link/token the way you'd treat a shared password.
- **Cross-site/CSRF requests against the (local) web UI** — the
  session/viewer cookies are `SameSite=Strict` (the primary defense: a real
  cross-site request never carries them at all), plus explicit Origin/
  Referer validation on every mutating request as defense-in-depth. The Host
  header itself is also validated (rejects anything but `localhost`, an IP
  literal, or a `.local` mDNS name) to close DNS-rebinding as a way around
  both.
- All endpoints carry standard security headers
  (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: same-origin`) and IP rate limiting.

## 4. Self-hosted client/server traffic

### Authentication

- **Device identity**: the same X25519 keypair each device already generates
  for P2P sync ([`p2p-sync.md`](p2p-sync.md)) is reused for server auth —
  but with its **own, domain-separated HKDF label**
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
  front for anything reachable outside a trusted LAN — see
  [`headless.md`](headless.md).
- **Revocation**: `docket devices revoke <deviceId>` cuts off one device
  immediately, without needing to rotate any secret shared by other devices
  — each device's server-auth secret is derived independently.
- **Protocol/version compatibility**: `GET /api/v1/info` reports the
  server's protocol version; a client refuses to talk to an incompatible
  server rather than guessing at how to speak an unknown version.

### Limitations — read before relying on self-hosted mode for a sensitive workspace

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
- **No multi-user accounts, no hosted cloud service.** Every paired device
  gets full read/write access to the one workspace; there's no per-user
  login, and nobody's running this for you — you run `docket serve` on
  infrastructure you control.

See [`self-hosting.md`](self-hosting.md) for setup, and the
[README's Deployment modes](../README.md#deployment-modes) for how this
compares to Local Mode and P2P sync.

## 5. The audit log's write ordering

Since v3.0 an item's history lives in `history.json.enc`, beside the store rather than
inside it — every mutation used to re-serialise and re-encrypt every item's full history
along with the store it was attached to, so an item worked on all week made every later
write to any *other* item more expensive.

Both files are written under the same lock, in a fixed order: **history first, then the
store**, and an item's inline entries are trimmed only once the side file is safely on
disk. Three consequences, all deliberate:

- A crash between the two writes leaves the side file holding entries the store still has
  inline too. The deduplication on the next flush absorbs that. The other order would drop
  exactly the entries that had just been trimmed away.
- A crash *after* a flush that pruned a deleted item's log, but before the store write,
  loses that item's history while the item itself comes back. The item is recoverable; its
  audit trail is not.
- A side file that exists but cannot be decrypted is never overwritten, only skipped — a
  transient failure (a wrong key mid-restore, say) must not turn into permanent loss.

The consequence to be explicit about: **history can lag the store by one write, and in the
pruning case can lose an entry outright.** That is accepted rather than worked around.
History is an audit log — a diagnostic for "who changed this and when" — not the source of
truth for any item's state, and a two-phase commit across two encrypted files would buy
consistency for a record nothing reads to make a decision.

`history.json.enc` carries the same at-rest protection as `todos.json.enc` (AES-256-GCM
under the same locally generated key), is included in `docket backup`, and an item's log is
deleted along with the item.

Three related limits worth stating plainly:

- **Only recent entries cross the wire during P2P sync.** What a peer sends is the tail of
  its inline history, not its whole log. A device's history is therefore a complete record
  of what *it* did, plus whatever recent activity reached it from peers — not a full record
  of everything every other device did.
- **A claim renewal writes no history entry.** A renewal is the absence of an event — same
  agent, same session, same item — and at one heartbeat every few minutes per active item
  it was the main driver of history growth. Who holds a claim and until when is still
  recorded on the item itself.
- **The split moves the cost off the common write, it does not remove it.** Flushing
  rewrites the whole audit log, so it is batched: an item accumulates entries inline and
  pays for one rewrite roughly every `HISTORY_FLUSH_THRESHOLD` writes, instead of on every
  write. Reads of the todo list never touch the file at all.

## 6. The live session registry

`sessions.json` records which agent sessions are open right now: the agent name the host
reported, the resolved project, the process id, and **the absolute path of the working
directory**. It is written on MCP startup and touched on tool calls; entries are removed on
clean shutdown and reaped by TTL or a dead pid otherwise.

Three properties, each chosen rather than defaulted into:

- **It is not encrypted.** It holds no user content — no titles, no descriptions, nothing an
  item ever said. What it does hold is process metadata, and the most sensitive thing in it
  is a directory path, which is already visible to anything on this machine that can run
  `ps` or read `/proc`. Encrypting it would mean touching the at-rest key on every
  heartbeat, on a path deliberately kept off the store's lock, to protect something the
  operating system already discloses to the same audience.
- **It is not synced, and never leaves the device.** A session open on another machine tells
  you nothing you can act on — you cannot switch to a terminal that isn't in front of you —
  so shipping paths from one machine to another would add exposure and buy nothing. It is
  also excluded from `docket backup` for the same reason: a restored backup should not
  resurrect a list of sessions that ended.
- **Its paths are readable by anything running as this user.** Same boundary as the rest of
  `~/.docket`: the at-rest encryption there protects against a stray `git add -A`, a backup
  tool that ignores permissions, or another account on a shared machine — not against code
  already running as you. If a project's *path* is itself sensitive on a shared machine,
  note that the file is `chmod 600` like everything else in the data directory, and that
  `docket sessions` is the only thing that reads it.

The web UI serves this list at `/api/sessions`, behind the same Viewer Gate as every other
browser-facing route (§3) — so a LAN device that has not been explicitly approved cannot
read your directory paths.
