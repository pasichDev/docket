# Docket Crew

Local multi-agent orchestration. Crew drives `claude`, `codex` and `opencode` as a **team**
against a Docket backlog: a manager agent delegates work to workers and reviewers, each worker
runs in its own git worktree, and when one reports back the manager is **woken automatically**
with the result. No copying prompts between terminals.

Crew is a separate package from Docket Core on purpose. Docket stays a task store; Crew owns
supervision, routing and orchestration, and refers to Docket tasks by id rather than copying them.

---

## Quick start

```sh
cd crew
npm install && npm run build

# 1. Check the machine. Do this first — it tells you what will silently not work.
node dist/cli.js doctor

# 2. Start the daemon. It prints the Office URL.
node dist/cli.js start --open

# 3. Give the crew a goal. This starts a manager if there isn't one.
node dist/cli.js ask "add a CHANGELOG and wire it into the release notes"

# 4. Watch it work in the Office, then stop everything.
node dist/cli.js stop
```

Installed as a package the binary is `docket-crew`; every `node dist/cli.js X` below is
`docket-crew X`.

**Everything the CLI can do, the Office can do** — they are the same HTTP endpoints. After
`start` you need not touch the CLI again.

---

## Requirements

- **Node ≥ 18.**
- **At least one runtime on `PATH`**: `claude`, `codex`, or `opencode`. `doctor` reports which.
- **Docket Core built** (`npm run build` in the repo root). Crew works without it, but workers
  are handed Docket's MCP server only when its `dist/` is findable — without it they lose every
  `todo_*` tool with no error anywhere and cannot claim the task they were told to claim.
  `doctor` reports this explicitly.
- **A git repository** for isolated work. Outside one, `isolate` is unavailable.

---

## Commands

| Command | What it does |
|---|---|
| `doctor` | Runtimes and their probed capabilities, Docket Core, workspace, profiles, **resolved skills per profile**, worktree/branch accumulation, stray daemons. Exit 1 on a real misconfiguration. |
| `start [--open]` | Start the daemon + Office server, detached. Prints the Office URL. |
| `stop` | SIGTERM the daemon, then sweep its process group. Contract: **zero crew-owned processes remain**. |
| `status` | Daemon pid/port/version, agent and assignment counts, active runs. |
| `ask "<goal>"` | Give the manager a goal. Starts a manager if none is running. |
| `ask @<agent> "<goal>"` | Talk to one agent directly. The manager is told, so its plan does not go stale. |
| `office` | Print and open the Office URL. |
| `agents` | List agents, managed and observed. |
| `profiles` | List profiles from `config.yml` (works with the daemon down). |
| `agent start <profile>` | Spawn an agent from a profile. |
| `agent stop <id\|name>` | Stop one agent. |
| `agent rename <id\|name> "<new name>"` | Rename it. **The name is an address**: after this, `ask @<name>` and the manager's `crew_assign to:"<name>"` both reach it. |

---

## Configuration — `~/.docket/crew/config.yml`

Written with defaults on first run. Every key Crew reads:

```yaml
manager:
  profile: manager-claude        # must name a profile whose role is `manager`

profiles:                        # named agent templates
  manager-claude:
    runtime: claude              # claude | codex | opencode
    role: manager                # manager | worker | reviewer
    model: <passed to the runtime verbatim>     # optional
    provider: <opencode only>                   # optional
    skills: [house-style]                       # optional; ADDS to the role skill

automation:
  managerAutoWake: true          # wake the manager when a worker reports
  maxAutonomousTurns: 10         # consecutive manager turns with no human input, then it pauses
  maxAgents: 4                   # live managed agents
  maxConcurrentRuns: 3           # simultaneous runtime subprocesses
  maxRetries: 1                  # automatic retries of a failed assignment (and of a manager turn)
  turnIdleTimeoutMs: 600000      # kill a turn that emits NO output for this long (0 disables)
```

`turnIdleTimeoutMs` is a **silence** budget, not a cap on how long a turn may take. A turn that
is streaming text and tool calls is alive at minute ten; a turn that has said nothing for ten
minutes is wedged whatever its total. Before it existed nothing bounded a turn at all: a runtime
that stopped talking and never exited held its agent at `working` — mailbox undrained, assignment
unresolved, one `maxConcurrentRuns` slot occupied — for the life of the daemon. A turn killed
this way is a **failure with a known cause**, not a cancellation: it retries under `maxRetries`
and the manager is told, and the message says only that Crew killed the process, pointing at the
worktree diff rather than passing judgement on the work.

A `config.yml` that exists but does not validate is a **hard error** at startup — substituting
defaults over a typo would run the wrong models with the wrong limits and look deliberate.

### Environment variables

| Variable | Effect |
|---|---|
| `DOCKET_CREW_HOME` | Move the whole state tree off `~/.docket/crew`. Every test and smoke run uses this. |
| `DOCKET_CREW_PORT` | Daemon/Office port (default `8790`). |
| `DOCKET_CREW_SKILLS_DIR` | Extra skill roots, `:`- or `;`-separated. Highest precedence. |
| `DOCKET_CREW_ALLOW_UNISOLATED=1` | Let a headless human choose `isolate:false`. See Safety. |
| `DOCKET_CREW_OBSERVE_INTERVAL_MS` | Observed-session poll cadence; `0` disables the loop. |
| `CREW_DOCKET_DIST` | Point at Docket Core's `dist/` explicitly. |
| `DOCKET_WEB_PORT`, `DOCKET_WORKSPACE`, `DOCKET_DATA_DIR` | Read through Docket Core's own resolution. |

---

## How the loop actually works

1. You give the **manager** a goal (`ask`, or the Office composer).
2. The manager delegates with `crew_assign`. A coding assignment gets a **fresh git worktree**
   on a `crew/<assignment>-<runtime>` branch.
3. The **worker** runs one turn there, claims its Docket todo, does the work, calls `crew_report`.
4. `crew_report` transitions the assignment and **wakes the manager** with the result — the
   feature the whole package exists for.
5. The manager decides what is next, bounded by `maxAutonomousTurns`. When that budget is spent
   it **pauses and says so** rather than looping.

Mail follows exactly one rule (there is no second delivery path): an agent that can take a turn
gets woken with the message now; an agent mid-turn has it **queued and drained into the prompt at
the start of its next turn**. Nothing is ever written into a running subprocess's stdin.

---

## Safety properties — please do not weaken these

- **Observed sessions are look-don't-touch.** A Docket MCP session Crew did not launch appears in
  the Office so you can see the whole room, but it can never be messaged, renamed, assigned,
  cancelled or stopped. Every such attempt is refused (409 / RPC error).
- **An agent cannot put a worker in your checkout.** `isolate:false` inside the crew's own git
  workspace is a **human** decision — the Office form, or `DOCKET_CREW_ALLOW_UNISOLATED=1`. A
  `crew_assign` hard-codes "agent" where no tool argument can reach it.
- **A dirty repo refuses isolation, loudly.** A worker branching from HEAD would silently miss
  your uncommitted work, so its report would describe a different tree than the one in your
  editor. Commit or stash; do not work around it.
- **Crew never merges.** The branch is the deliverable (see [OPERATIONS.md](docs/OPERATIONS.md)).
- **`stop` leaves zero crew-owned processes**, and says so or warns that it could not.
- **No fake successes.** A turn that ends without `crew_report` goes to `review` with its diff
  attached, not to `done` — Crew does not know whether the work happened, and says so.
- **The Office escapes everything at render time.** Agent names, titles and summaries are written
  by *models*; nothing upstream sanitises them.
- **Bypass/auto-approve flags are never on by default** — not `--dangerously-bypass-approvals-and-sandbox`,
  not `--auto`, not a Claude bypass permission mode.

---

## Further reading

- **[docs/OPERATIONS.md](docs/OPERATIONS.md)** — worktree and branch lifecycle, disk growth, and
  the honest list of what is **not** yet exercised. Read this before trusting a long run.
- [docs/SKILLS.md](docs/SKILLS.md) — the skill system: roots, precedence, budget, diagnostics.
- [docs/RUNTIME-CONTRACTS.md](docs/RUNTIME-CONTRACTS.md) — what each CLI actually emits, proven
  by real runs. Adapters are written against this, never against assumptions.
- [docs/MCP-REGISTRATION.md](docs/MCP-REGISTRATION.md) — how each runtime is handed the Crew and
  Docket MCP servers.

## Development

```sh
npm run build     # rm -rf dist && tsc
npm test          # builds, then runs every dist/**/*.test.js against a scratch DOCKET_CREW_HOME
npm run test:live # additionally exercises the real CLIs (DOCKET_CREW_LIVE=1) — costs tokens
```

Tests never touch `~/.docket`: every path comes from `mkdtemp` and `DOCKET_CREW_HOME` is always
a scratch directory.
