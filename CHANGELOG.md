# Changelog

## 3.0.0-rc.2

Two review passes and a full release-readiness audit. The audit's verdict on the
previous build was a plain no-go: not because anything visible was broken, but
because the failures that were left all sat at the seams where state moves —
between processes, between machines, between local and self-hosted — and every
one of them reported success while losing something.

Twenty-seven blockers, all closed, each with a regression test that was checked
to fail against the code it replaces.

### Security

**Device management no longer trusts a source address.** The admin routes behind
`docket devices …` were gated on the request arriving from `127.0.0.1`, on the
reasoning that the operator on the server machine is the trust boundary. A
reverse proxy — which `docs/headless.md` recommends for HTTPS, with a worked
Caddy example — breaks that reasoning completely: every request it forwards
arrives from `127.0.0.1`. Anyone on the internet could mint a pairing code,
approve their own request, and end up with a fully authorised device against the
authoritative store.

They now require a secret written to `admin-token` in the data directory (mode
0600), which the CLI reads because it runs as the same user on the same machine.
The loopback check stays as defence in depth rather than as the boundary, and
`X-Forwarded-For` is deliberately not consulted — it is set by whoever spoke to
the proxy.

### Data correctness

- **A server backup now includes `devices.json.enc`.** The documented
  disaster-recovery path restored the todos and the server's identity but not the
  registry of authorised devices, so every paired client silently stopped
  authenticating at exactly the wrong moment.

- **The delivery cursor no longer steps over records the sanitiser refused.** A
  record rejected for a malformed timestamp still occupied a position in the
  peer's delivery order, and the cursor was computed from the raw page — so the
  next request started above it and it was never asked for again. The merge now
  reports where it refused; the cursor stops below that, and the peer record says
  why syncing is held.

- **A tombstone's `deletedAt` must be a real timestamp.** Deletions are compared
  by string ordering, so `"zzzz"` sorted above every ISO date and produced a
  deletion no later edit from any device could beat.

- **Timestamps at the ISO boundary are refused.** `9999-12-31T23:59:59.999Z` was
  accepted, and one millisecond past it is year 10000, which serialises as
  `+010000-01-01T…` — a shape no Docket accepts. This device could manufacture a
  record the next device would refuse.

- **Releasing a file lock claims it by rename first.** Read-then-unlink had a
  window: a process suspended between the two steps woke to find its lock reaped
  and deleted the new holder's lock instead.

- **Workspace slugs keep the full repository path.** `team-a/platform/backend`
  and `team-b/platform/backend` both collapsed to `platform/backend`, merging two
  teams' lists. **This changes existing slugs again** for nested groups only.

### Durability and concurrency

- **Every persistent write is now durable, not just atomic.** "Temp file plus
  rename" guarantees that no reader sees half a file. It guarantees nothing about
  whether the data or the directory entry reached the disk, so a crash seconds
  after a successful write could leave the old contents, the new contents, or an
  empty file where the store had been. Both fsyncs are in place, and every write
  goes through one function — including three that had no temp file at all: your
  Claude `settings.json`, each MCP host's config, and the backup bundle itself.

- **First-run secrets can no longer be minted twice.** Two processes starting
  against an empty data directory — an MCP session and the dashboard it spawns,
  which is the ordinary case — both read nothing, both generated a key, and both
  wrote. Whichever lost then held a key that was not on disk, and everything it
  encrypted afterwards was unreadable by anyone, itself included, from the next
  restart. The at-rest key, the store epoch and the server's admin token are all
  settled by an exclusive create now.

- **A suspended process can no longer overwrite newer state.** The advisory lock
  cannot stop a laptop that sleeps mid-write from having its lock reaped and
  waking up still inside its own critical section. The todo store detected that;
  the peer list, the viewer list, the server's device registry, the remote
  credentials and this device's own identity did not — so a stale writer could
  silently unpair a device that had just been added. They all carry the same two
  guards now: the lock's identity, then a hash of the bytes.

- **That content check is a hash rather than a size and a timestamp.** Two
  encrypted stores very often share a length, and several filesystems keep
  modification times to the nearest second.

- **The audit log no longer records edits that did not happen.** History was
  written to its side file before the store commit, so an attempt that lost a
  race left its entries behind and then re-ran — a permanent record of an edit
  that was rolled back, in the one file whose entire job is to be trustworthy.

### Sync

- **An item that outlives a peer's deletion is delivered back to that peer.** When a
  deletion loses to a newer edit the item correctly stays alive — but the device
  that deleted it was never told, because our copy still sat at the sequence
  number it had when that device last saw it, below its cursor. One device showed
  the item, the other showed it deleted, both reported a healthy sync, and no
  amount of further syncing repaired it: there was nothing left to send. Reachable
  with two devices whenever one clock runs behind the other.

- **The convergence property test now controls its own clock.** It generated
  topologies, operations and clock skew from a seed, then read the real clock for
  the timestamps — so whether two operations landed in the same millisecond
  depended on how fast the machine was, and a seed that failed on a CI runner
  passed everywhere else. A failure that cannot be reproduced is indistinguishable
  from noise, and this one was dismissed as flaky more than once. The clock is part
  of the seed now, and the sweep runs deeper on demand
  (`DOCKET_CONVERGENCE_SEEDS`, `DOCKET_CONVERGENCE_CLOCK_STEP`).

### Backup and restore

- **A backup is one moment.** It read the data directory's files one after
  another while the rest of the machine kept working, so a bundle could pair a
  store from before a sync with a peer list from after it. Each file was
  individually valid; the mixture surfaced much later as a peer that had gone
  quiet. Backups are now read under every relevant lock and carry a per-file
  checksum, so a damaged bundle is refused before anything is touched.

- **Restore is a transaction.** It replaced the encryption key and then each
  encrypted file in turn, so a crash in the middle left the new key beside some
  of the old ciphertext — unreadable, and unreadable in a way no later run could
  diagnose. Everything is now validated and staged first, the operation is
  journalled before the first file moves, and an interrupted restore is finished
  automatically on the next start.

- **Nothing that predates a restore can write into what it produced.** Every
  long-running process caches the key, this device's identity, the store epoch
  and the admin token, and all four are silently wrong the moment the directory
  underneath is replaced. The directory now carries a generation id that every
  write re-checks; a process whose generation has moved stops and says so.
  `docket restore` also names what is still running and asks you to stop it.

### Moving a workspace between local and self-hosted

- **`docket backend use` and `backend localize` preserve the workspace.** They
  re-created every item through the ordinary "add a todo" path, which meant new
  identities (so every paired device saw the whole list deleted and a different
  one appear), today's timestamps, no history, and — since v3 made projects the
  centre of the product — no project either: everything landed in Unfiled. None
  of it was reported. A migration now carries item identity, project, chronology,
  completion, revision, provenance, full history and deletions.

- **A migration that fails halfway can simply be run again.** It used to leave
  both sides populated and refuse to continue, telling you to repair it by hand.

- **Switching to a server stops the local dashboard and its sync loop.** It kept
  running, kept pulling from paired devices, and kept writing to a store that was
  no longer the source of truth.

- **`docket setup --remote` no longer hides an existing local workspace.** It
  wrote remote mode without looking at what was already there: a year of todos
  stayed on disk and stopped being part of the product, with nothing saying so.
  It now offers to upload, to keep them where they are, or to cancel.

### Configuration

- **`~/.config/docket/config.json` is the source of truth.** Setup wrote
  `DOCKET_MODE` into every MCP host's config, and the environment beats the
  config file — so `docket backend localize` would report a switch to local mode
  while every agent carried on talking to the server, and the only way out was
  hand-editing four host config files you never knew existed. Setup writes no
  deployment environment at all now; the override still exists for a container or
  a single command.

- **A custom data directory is recorded in one place.** It lived only in host
  configs and a shell startup file, so `docket backup` typed in a terminal that
  had not sourced that file backed up an empty `~/.docket` and reported success.
  `docket status` now says which source the directory came from.

- **In remote mode the CLI reads the server.** `list`, `stats`, `workspaces` and
  `export` read the local store, and `import` wrote to it — the terminal showed
  an empty list while the editor showed the real one, and an import reported
  success for items that existed nowhere you could reach.

### Identity, installation and containers

- **Two items can no longer share a short id in silence.** The six-character id
  is a hash, and the lookup returned the first match — so on a list that has run
  for a while, `todo_complete T-XXXXXX` could quietly complete somebody else's
  task. An ambiguous id is now refused, naming both items.

- **Setup no longer discards MCP configuration it cannot parse.** A trailing
  comma in `~/.cursor/mcp.json` was treated as "there is nothing here", and every
  other MCP server you had configured was replaced by a file containing only
  Docket. Unreadable configs are now left exactly as they are, readable ones keep
  their unknown fields, and the previous version is saved beside them.

- **An old dashboard left over from a previous version is replaced, not
  adopted.** Auto-start accepted any answer on the port as "already running", so
  after an upgrade the old process kept serving the same data directory.

- **The container image builds, and the documented commands work inside it.** The
  image copied one of the three TypeScript configs its own build needs, and had
  no `docket` on `PATH` at all — so `docker compose exec docket docket devices
  pair`, the first instruction given to a new self-hoster, could not have worked.
  The default `docker compose up -d` also no longer needs a `chown` you would
  have to guess at, and the published port is overridable for a machine already
  running `docket serve`.

### Release plumbing

- **A pre-release can no longer be published as `latest`.** npm's default tag is
  `latest`, so publishing a release candidate would have pointed every
  unpinned install, every `npx`, and the update checker itself at it.
- **A tag alone no longer publishes.** The release job built and published; a tag
  on any commit on any branch became a release. Publishing now requires proof
  that the tag is on `main`, that it matches the version it claims, and that the
  full test suite, a dependency audit, an install of the packed artifact, and a
  container build-and-pair all pass on that exact commit.
- **Generated host configs pin the version that generated them.** Running a
  release candidate's own setup configured every agent to launch whatever
  `latest` resolved to — 2.x code against a 3.x data directory.
- **CI covers what the package claims.** Node 18, 20, 22 and 24 on Linux plus
  macOS, the packed artifact, and the container image.
- CI runs `npm test` rather than a hand-copied glob of it. The copy stopped
  running the browser-client tests the moment they moved, and CI stayed green.
- `docket check-update` follows the channel it was installed from, so an RC hears
  about the next RC instead of being told 2.3.1 is the newest build.
- A protocol-v1 peer with more records than one merge can accept is reported as
  incompatible instead of "syncing" forever without converging.
- The sync error told users to `npm install -g docket@latest`; the package is
  `@pasichdev/docket`.
- `qs` is pinned past a moderate advisory. It reaches us only through the MCP
  SDK's `express` dependency, which Docket never loads — but a red audit trains
  people to ignore audits.

## 3.0.0-rc.1

Release candidate. Publish under `npm publish --tag next` so `latest` keeps
pointing at 2.3.1 until this has run on machines that are not the author's.

### Fixed since the first 3.0.0 branch cut

Six issues from PR review, each with a regression test:

- **A peer's `maxSeq` is no longer taken on trust.** The delivery cursor is the
  one piece of sync state where a wrong value is silent *and* permanent: advance
  it past records that were never sent and this device stops asking for that
  range forever. A page that carried records can no longer promise more than its
  highest record, and a `maxSeq` that is not a sequence number is rejected
  outright.
- **Peer timestamps are validated before they enter the store.** `createdAt` and
  `updatedAt` must parse; a record whose timestamps do not is refused. Shape
  alone was not enough — `2026-13-45T99:99:99Z` looks right and still parses to
  `NaN`, which made `new Date(Date.parse(x) + 1).toISOString()` in `mutations.ts`
  throw `RangeError` on the next ordinary edit, long after the sync that accepted
  it. Optional timestamps (`completedAt`, the working-lease pair, per-field
  stamps) degrade to `null` instead of failing the record.
- **History pruning moved after the store commit.** `withStore`'s write is
  optimistic and retries; a prune done before the commit could delete the audit
  log of an item the winning write had kept alive. Appending still happens
  before the commit, which is what buys the crash-safety ordering.
- **Restoring a backup without `history.json.enc` no longer leaves the current
  one in place.** An old store paired with a newer sidecar produces an audit log
  describing edits the store does not contain. Only that file is swept aside —
  `peers.json.enc` is independent state, and clearing it would silently unpair
  every device.
- **Workspace slugs now include the git host.** `owner/repo` alone collided
  whenever two forges shared a namespace. **This changes existing slugs:**
  `acme/backend` becomes `gitlab.com/acme/backend`, so items filed under the old
  name stay under it and appear as a separate project in the switcher. Rename
  them with `.docket.json` or `DOCKET_WORKSPACE` if you have any.
- **`compareVersions` implements SemVer §11.** It split on `.` and ran `Number()`
  over the parts, so `0-rc` became `NaN` and every comparison against it fell
  through to the "greater" branch — `3.0.0-rc.1` compared as *newer* than
  `3.0.0-rc.2`, which would have offered an RC user a downgrade as an update.

### Dashboard

- Cards lead with the title. The meta row moved below it and stopped repeating
  what the filter row above already says: the Todo/Backlog badge disappears once
  you have filtered to one, and `via web` is gone entirely — web is where you are
  looking.
- The project switcher is a select in the toolbar rather than a second row of
  pills that opened with its own "All".
- Long descriptions are previewed at 300 characters with a **Read more**; the
  full item and its history open in a modal. Editing moved into a modal too, with
  a markdown editor (formatting bar, Write/Preview, `Ctrl`/`⌘`+`B`/`I`/`K`).
- Descriptions render markdown. Emphasis follows CommonMark's flanking rule, so
  ordinary prose like `rename *.js to *.ts` is left alone, and four-space indented
  blocks keep their shape.
- Clicking an item's id copies it.

## 3.0.0

Three silent data-loss bugs in the sync layer, one latent lock-corruption bug,
and the feature the tool was missing: **workspaces**.

### Breaking / migration

**Data format v7 → v8.** Migration is automatic and one-way, applied by the
single locked write `migrateLegacyFields()` already performed at startup.

- Every item and tombstone gains **`localSeq`**, a per-device delivery counter.
  Existing records are numbered in a stable order (`createdAt` ascending,
  `uuid` as tiebreak) so two devices migrating the same exported store agree.
- Every item gains **`workspace`**, set to `null` for existing items. It is
  never guessed: there is no honest way to know which project a v7 item came
  from, and a wrong workspace hides an item where its author will never look.
- History moves to **`history.json.enc`**. Items keep their last 5 entries
  inline for card previews; the full log is read only by `todo_history` and the
  web UI's detail panel.

**Rolling back to 2.x — read before downgrading.** A v8 store is refused by
older builds rather than misread, so 2.3.1 will not *read* your data. It will
still **write** it: 2.3.1's `saveStore` serialises from its own v7 shape, so
its first write strips `localSeq`, `workspace` and `seqCounter` from every
item, silently. A later re-upgrade then assigns fresh sequence numbers and
every paired device's cursor means something different than it did. 2.3.1 is
published and cannot be patched.

So 3.0 copies your store aside once, immediately before the v7 → v8 write:

```text
~/.docket/todos.v7-pre-upgrade.enc
```

Written once, never overwritten, and its path is printed on the run that
creates it. To downgrade:

```sh
docket restore --from-v7                     # restores that copy; moves the v8 store aside
npm install -g @pasichdev/docket@2.3.1
```

In that order. Nothing is deleted either way — `restore --from-v7` renames the
v8 store aside, and `docket backup` before upgrading gives you a portable copy
including identity and paired peers.

Restoring works in both directions, and paired devices notice. `localSeq` is a
counter and a peer's cursor is a number in it, so a restored (lower) counter
would otherwise leave every paired device deaf to this one. Each store now has
a **`store-epoch`** — a plaintext id beside the store, re-minted by `restore`,
and deliberately excluded from backups so that restoring onto *new hardware*
mints a fresh one too (that case brings `peers.json.enc` back with it, so
remote peers still hold cursors into the old machine's sequence space). The
epoch travels in the sync payload; a peer whose recorded epoch no longer
matches discards its cursor and re-syncs from scratch. The check runs on the
side that owns the cursor, which is the only side that can be wrong about it.

**Sync protocol v1 → v2.** `MIN_COMPATIBLE_SYNC_PROTOCOL_VERSION` stays at 1,
so a mesh does not have to be upgraded atomically. A peer still on v1 syncs in
a degraded mode and says so on its own peer record:
*"peer is on sync protocol v1 — updates from a third device may not reach this
one; update that peer."*

**Renamed:** the `docket-claim` skill and plugin are now `docket`
(`/plugin install docket@docket`). `skills/docket-claim/` →`skills/docket/`.

### Fixed

- **Transitive propagation.** `updatedAt` was doing two different jobs —
  merge resolution and delivery cursor — and merging copies the *author's*
  `updatedAt` onto the local record. An item reaching B second-hand landed in
  B's store already timestamped in A's past, below A's cursor for B, and A
  never heard about it. With A↔B↔C paired and A↔C not, an edit made on C was
  silently lost. Delivery now has its own counter (`localSeq`), stamped on
  every local write *including accepting a peer's change*.
- **Silent truncation on first sync.** `mergeSyncPayload` capped the payload at
  2000 items and the caller then advanced its cursor to the peer's clock
  regardless — a first sync of a larger store permanently lost the remainder,
  with no error and no log line. Sync now pages, and the cursor advances only
  to what was actually merged.
- **Two processes could hold the file lock at once.** Both saw a stale lock,
  both removed it, and the second removed the *first's* brand-new lock. Two
  concurrent read-modify-writes on the store, one silently discarded. Reaping
  is now an atomic rename with a compare-and-swap on the holder record and a
  re-check of its age. This is still an advisory lock between cooperating
  processes on one machine, not a proof of exclusion: a much narrower window
  remains, and release and heartbeat now verify ownership so a process that
  lost its lock can't take the new holder's down with it.
- **A lock held longer than 10s was reaped out from under its holder** (a
  suspended laptop, a network filesystem, a debugger). Held locks now heartbeat.
- **A nested `withStore` waited 5 seconds and then timed out.** It now fails
  immediately, naming both call sites.

### Added

- **Workspaces.** Items are filed under the project they were captured in,
  resolved from the git remote where possible so the same repo on two machines
  is one workspace. `todo_list` defaults to the current project plus unfiled
  items. `docket workspaces`, `docket list -w <name>`, `docket list --all`, a
  workspace switcher in the web UI, per-project counts in `docket stats`.
  See [`docs/workspaces.md`](docs/workspaces.md).
- **Live session registry.** `docket sessions`, an "Active sessions" panel in
  the web UI, and a one-line routing hint on capture when another session is
  already live in that project.
- **`docket hook install | uninstall | doctor`** — a Claude Code `SessionStart`
  hook that injects what's open in the current project (compact, ≤7 items,
  ≤120 tokens), and nothing when there's nothing open. Merges into existing
  hooks, never overwrites; removes only its own entries; **fails open always**.
  `doctor` runs the configured command as a real subprocess, so it catches the
  most likely failure — an executable that isn't on `PATH` — instead of testing
  a copy of the hook in-process. Disable with `DOCKET_HOOKS=off`.

### Changed

- **A peer that restored a backup is no longer invisible.** Its sequence
  counter goes backwards, leaving every cursor into it pointing past records
  that were never seen. See `store-epoch` above.
- **Sync merges no longer trim an item's history.** A peer sends only recent
  entries; trimming the merged result destroyed local entries that had not yet
  been flushed to the side file.
- **A newer deletion of an already-deleted item now propagates.** A second
  deletion of an item that a later edit had resurrected was applied locally but
  never sequenced, so a third device kept comparing against the original,
  older deletion and resurrected the item again — permanently.
- **`todo_list` is compact by default** — one line per item, `verbose: true`
  for full records. It used to return everything, including history, on every
  call.
- **Claim renewals no longer write a history entry.** A renewal is the absence
  of an event, and at one heartbeat every few minutes per active item it was
  the main driver of history growth that every unrelated write then paid for.
- **P2P sync is deprecated**, and the deployment-mode table now says so
  plainly: claims are **advisory** in Local/P2P mode and **atomic** in
  Self-hosted mode. The 15-second pull interval means P2P cannot deliver an
  atomic guarantee. It still works in 3.0; nothing is removed.

## Not in this release, and why

Recorded so a later reader can tell a decision from an oversight.

- **File leases and blocking hooks** — reserving a path so two agents can't edit it at once.
  There is no evidence of file-level collisions in the usage this is built for: one person
  across several *unrelated* projects, different trees, nothing overlapping. What gets lost
  is the thread, not the file, which is what workspace scoping addresses. `docket sessions`
  now makes real collisions visible; repeated ones on the same paths would change this.
- **Hook adapters for other hosts** — four mutually incompatible output shapes, each of
  which shifts between host versions. With blocking deferred, the only hook worth having is
  `SessionStart`, and only Claude Code has one stable enough to depend on.
- **Cross-vendor dispatch** — "hand this item to the Codex terminal that's already open"
  isn't possible over stdio MCP: the server cannot wake an agent, and an agent only acts
  inside a turn a human starts. Headless spawn *is* possible and buys the whole orchestrator
  problem set — process ownership, output routing, crash handling, result collection — which
  is a separate product. The routing hint shipped instead.
