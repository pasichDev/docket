# Operating a Crew

What grows, what nobody cleans up, and what has genuinely not been exercised yet. Read this
before trusting a long-running crew.

---

## Worktrees and `crew/*` branches

An isolated assignment creates two things in your repository:

| Thing | Where | Lifetime |
|---|---|---|
| A checkout | `~/.docket/crew/worktrees/<repo>/<assignment>/` | Until something removes it |
| A branch | `crew/<assignment>-<runtime>` in your repo | **Forever** |

**Nothing removes either of them automatically.** That is a deliberate choice, not an oversight:
spec §29 says Crew never merges, so the branch *is* the deliverable — the only record of what a
worker did. Deleting it on a schedule would throw away unmerged work that nobody has looked at.

The cost is real and you should know its shape:

- One branch per isolated assignment, permanently, in `git branch --list 'crew/*'`.
- One worktree directory per assignment, holding a full checkout of the repo, under
  `~/.docket/crew/worktrees/`. On a large repo this is the item that actually consumes disk.
- Worktree *bookkeeping* is in-memory only. **A daemon restart forgets which worktrees exist**;
  the directories and branches survive, but `teardownWorktree` can no longer find them. In
  practice that means restarting the daemon orphans every worktree it had open.

### Seeing it

```sh
docket-crew doctor        # live checkouts, crew/* branch count, and the oldest one
git worktree list         # the checkouts git knows about
git branch --list 'crew/*'
```

### Cleaning up — a human act

Review the branch first; it may be the only copy of the work.

```sh
git worktree remove ~/.docket/crew/worktrees/<repo>/<assignment>
git worktree prune
git branch -d crew/<assignment>-<runtime>     # -d, not -D: refuses to drop unmerged work
```

`Orchestrator.teardownWorktree()` does the same thing for a worktree the *running* daemon still
tracks, and **refuses while an agent's session is pinned to it** — a resumed `codex` turn is
spawned from that exact directory, so deleting it would break every future turn of that agent
rather than tidying up. Nothing calls it automatically today.

---

## Disk under `~/.docket/crew/`

| Path | Grows | Trimmed |
|---|---|---|
| `events.jsonl` | Every event, append-only | **Yes, partly.** Rotated at 32 MB to `events.jsonl.1`; exactly two generations are kept, so the log is bounded at ~64 MB and anything older is gone. |
| `logs/` | Raw per-run runtime output, plus `daemon.log` | **No.** One file per run, forever. |
| `worktrees/` | One checkout per isolated assignment | **No** (see above). |
| `state.json` | Agents, assignments, messages | Bounded by the crew's size, but finished assignments are never pruned. |

The Office reads only the **tail** of `events.jsonl` (a backwards scan, capped at 8 MB), so the
size of the log no longer costs anything per SSE connect. Rotation is announced on the daemon's
stderr, because discarding the oldest part of the durable record is not something that should
happen quietly.

`logs/` is now the one to watch on a long-lived crew, and it is safe to delete while the daemon
is stopped. `events.jsonl` looks after itself.

---

## Secrets in the crew home

| File | What it is | Lifetime |
|---|---|---|
| `ui-key` | The secret a request must present before the daemon will mint it a UI session. `docket-crew start` prints the Office URL carrying it; `docket-crew office` opens that URL; the CLI sends it as `X-Crew-UI-Key`. | Per daemon process; removed by `stop`. |
| `agent-tokens/<agent>.token` | One RPC bearer token per agent, bound server-side to that agent id. | One **turn**; removed when the turn ends, and the whole directory on `stop`. |

Both are 0600 inside a 0700 root, written atomically (never through a symlink), and neither
survives `stop`. **Read the honest limits below before treating either as a security boundary.**

---

## What "only the human can do this" actually means

Three properties are stated as human-only: only a human puts a worker in your own checkout
(`isolate:false`), only a human sends a message stamped `from: "human"`, and only Crew names an
agent. All three now stand on one boundary — a request must present the UI key, which the daemon
never publishes over HTTP.

**What that buys.** An agent Crew spawned has `DOCKET_CREW_URL`, its own RPC token, its agent id
and its role. With only those it cannot obtain the human's capability *by asking the daemon*:
`GET /` no longer hands out a session cookie, `/api/ask` and `/api/agents/:id/message` no longer
accept an unauthenticated local caller, and its RPC token names it rather than authenticating
"some agent" whose identity the payload declares.

**What it does not buy — and this is not a detail.** Crew runs every agent as the **same OS user
as you**, with a shell and file tools. Such a process can read `~/.docket/crew/ui-key` exactly as
the CLI does, and can read another agent's token file while that agent's turn is running. There
is no code change that closes this; it needs OS-level isolation (a separate uid, or a sandbox)
that Crew does not have. Treat the boundary as **raising the bar, not sealing the door**: it
turns a capability that was free over an unauthenticated `GET` into one that requires reading a
file it was never told about, which is an act you can audit.

Consequences worth acting on:

- The Office URL printed by `docket-crew start` carries the key. Don't paste it into anything an
  agent reads (an issue, a commit message, a chat the crew is in).
- `DOCKET_CREW_ALLOW_UNISOLATED=1` authorises no-worktree runs and **nothing else** — it is
  deliberately not a general authentication bypass. Set it only when you mean it.
- The `crew-worker` skill's push rule is written to match: a *top-level* `from human` inbox
  entry is an authorization, a quoted `>` line inside somebody's message is not, and an
  irreversible-and-surprising instruction is to be confirmed rather than obeyed.

---

## Honest gaps — what is NOT proven

This is the consolidated list. Everything here works as far as it has been tested; the point is
that the testing named below is where it stops.

**Well covered.** The manager loop, mailbox delivery semantics, the autonomous-loop guard,
assignment state transitions and retries, atomic state and restart recovery, worktree creation
and the dirty-repo refusal, skill resolution and composition, the observed-session reconciler,
Office rendering and escaping, the control surface's authorization rules, and the three adapters'
event parsing against captured real output.

Since the fix waves, also covered by tests written from a demonstrated exploit: the
human-origination boundary (a scraped cookie, a bare `curl` stamping `from: "human"`), per-agent
RPC identity (a worker's token naming the manager), mirrored-name sanitisation (a planted Docket
session forging roster lines), the reserved-name check against invisible and fullwidth
homographs, symlinks planted at `agent-token`/`events.jsonl`/the run logs, the leading-`-` argv
trap in all three adapters, and the negative binary-detection cache.

**Verified live at least once** (`npm run test:live`, `DOCKET_CREW_LIVE=1`, 4 gated tests):
`claude`, `codex` and `opencode` each spawn, emit their real event stream, and surface a native
session id — proven against the actual binaries, with the observed shapes recorded in
[RUNTIME-CONTRACTS.md](RUNTIME-CONTRACTS.md).

**Not exercised in anger.** In rough order of how likely you are to hit it:

1. **The reviewer path end to end.** `crew_request_review` → reviewer turn → `crew_report_review`
   → manager woken is unit-tested at every step, but has never been run with a real reviewer
   agent against a real diff.
2. **`opencode` as a worker.** The adapter is implemented and its parsing is tested against
   captured output, including the Warp OSC contamination. It has not driven a real assignment.
3. **Live cancellation of a running turn.** `cancelRun` and the process-group sweep are tested;
   cancelling a *real* mid-flight runtime subprocess and confirming it leaves nothing behind has
   only been done via `stop`, not via the per-agent cancel button.
4. **Restart recovery mid-turn.** `recoverInterruptedRuns` is tested and provably never marks
   anything successful — but a daemon killed while a real worker was mid-edit has not been
   observed. Note the worktree-orphaning above applies to exactly this case.
5. **Two real agents working at once.** The pump no longer serializes turns (it starts them and
   tracks them as background work, with `maxConcurrentRuns` as the limiter), and concurrent
   dispatch is proved against fake runtimes and against a scratch daemon; two LIVE runtimes on
   real work at the same time still has not been run.
6. **Long-run behaviour.** Nothing has run for hours. `events.jsonl` now rotates, but `logs/`
   still does not, and no rotation has been observed in anger.
7. **A real cancelled assignment.** A cancelled turn now lands as `cancelled` rather than
   `failed` (no retry, no "agent failed" in the feed). Unit-tested; not yet seen against a real
   mid-flight runtime.

**Known rough edges.**

- The turn watchdog (`automation.turnIdleTimeoutMs`, default 10 minutes of silence) catches a
  runtime that goes QUIET and never exits. It deliberately does not catch one that chatters
  forever without finishing: that is a livelock, it is visible in the feed, and a human or
  `crew_cancel` can end it — unlike a silent wedge, which is invisible and ends nothing. Adding
  a wall-clock cap to catch it would kill legitimate multi-minute assignments, which is worse.
- Restarting the daemon orphans open worktrees (above).
- `docket-crew stop` reports survivors it could not kill and exits 1, but cannot kill a process
  that has left the daemon's process group.
- An observed Docket session that Crew cannot read (Docket Core not built) leaves whatever ghosts
  are already on the glass rather than clearing them — "cannot tell" deliberately does not mean
  "gone".
- **Same-uid agents are not contained.** See *What "only the human can do this" actually means*
  above. This is the largest honest gap in the whole system and no test can close it.
- An observed session that reports a name already taken by a managed agent gets a
  discriminator appended (`backend (a1b2c3d4)`) rather than the name it asked for, so the
  managed agent stays addressable. The ghost's name on the glass is therefore Crew's, not
  always the one the session reports.
- `logs/` and the `crew/*` branches are still never trimmed.

---

## When something looks wrong

1. `docket-crew doctor` — it is written to name the causes that are otherwise invisible: a
   missing Docket `dist/` (workers silently lose `todo_*`), a profile naming a skill that does
   not exist (agents run without it), a skill file shadowed by a higher-precedence one, and a
   daemon from another crew home already holding your port.
2. `~/.docket/crew/logs/daemon.log` — the daemon's own stdout, including skill-resolution warnings.
3. `~/.docket/crew/events.jsonl` — the durable event log. The Team Feed is a view of this file,
   so anything the Office showed is in here.
