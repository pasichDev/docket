# Changelog

## 3.0.0-rc.2 (unreleased)

Second review pass over the self-hosted half. One security fix, three
data-correctness fixes, and the reason CI was green while a directory of tests
went unexecuted.

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

### Release plumbing

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
