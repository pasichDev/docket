# Verified runtime contracts

**Every contract below was proven by a real local run on 2026-09-06, not read from docs and
not assumed.** Adapters MUST be written against these observed shapes. If an adapter needs a
capability not listed here, probe the real binary first and add it to this file with the
observed output — do not guess, and do not silently fall back to a mock.

Probed on: macOS (darwin 25.6.0).

---

## claude — Claude Code 2.1.259 (`/Users/macbookair/.local/bin/claude`)

**Invocation (proven):**

```sh
claude -p "<prompt>" --output-format stream-json --verbose
```

- `-p/--print` is required for every non-interactive flag below; without it they are ignored.
- `--output-format` accepts `text` (default) | `json` (single result) | `stream-json` (realtime).
- `--verbose` is required alongside `stream-json` for the full event stream.
- `--resume <session-id>` / `-c|--continue` resume a prior conversation (print mode only).
- `--model <model>`, `--permission-mode <mode>` available. **Never** enable a
  bypass-permissions mode by default (spec §7).

**Observed event stream** — one JSON object per line. Distinct `type` values seen in a single
trivial run: `system` (×11, mostly `subtype:"hook_started"` noise from the user's own
SessionStart hooks — adapters must tolerate and ignore unknown `system` subtypes),
`message`, `text`, `assistant`, `rate_limit_event`, `result`.

Every event carries `session_id`. That is the value to persist for `--resume`.

**Final `result` event** (exact key set observed):

```
api_error_status, duration_api_ms, duration_ms, fast_mode_disabled_reason, fast_mode_state,
is_error, modelUsage, num_turns, permission_denials, queued_turn_count, result, session_id,
stop_reason, subagent_stats, subtype, terminal_reason, time_to_request_ms, total_cost_usd,
ttft_ms, ttft_stream_ms, type, usage, uuid
```

Proven values from the probe: `result: "CREW_PROBE_OK"`, `is_error: false`,
`stop_reason: "end_turn"`, `total_cost_usd: 0.25832`.

→ Map `result` event to `AgentEvent{type:"result"}`, `is_error:true` to
`AgentEvent{type:"error"}`.

**Gotcha:** the user's environment has SessionStart hooks that emit many `system` events
before any model output. An adapter that assumes the first event is meaningful will break.

---

## codex — codex-cli 0.151.0 (`/opt/homebrew/bin/codex`)

**Invocation (proven):**

```sh
codex exec --json --sandbox workspace-write --skip-git-repo-check -C <dir> "<prompt>"
```

- `codex exec` (alias `e`) is the non-interactive entry point.
- `--json` prints events to stdout as JSONL.
- `-C/--cd <DIR>` sets the working root. `--add-dir` adds extra writable dirs.
- `-s/--sandbox` ∈ `read-only` | `workspace-write` | `danger-full-access`. Default to
  `workspace-write` for coding workers; never `danger-full-access` (spec §7/§43).
- `-m/--model <MODEL>`, `-p/--profile <name>` for model/profile selection.
- `-o/--output-last-message <FILE>` writes the final message to a file — useful as a
  belt-and-braces result capture alongside the event stream.
- `--output-schema <FILE>` constrains the final response to a JSON Schema.
- `--skip-git-repo-check` for non-repo dirs. Crew passes it on EVERY turn, start and resume:
  a worktree is a real repo, but a scratch or non-git workspace is a normal configuration and
  refusing to run there would be a worse failure than skipping a check Crew does not rely on.
  `--ephemeral` avoids persisting sessions (Crew does not use it — resume needs the session).
- Resume: `codex exec resume <id>` or `codex exec resume --last`. Also `codex exec fork <id>`.

**Observed event stream** (one JSON object per line):

```json
{"type":"thread.started","thread_id":"01a07370-b986-76c0-9ecc-bc4137ffb06e"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"...","kind":"add"}],"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"...","kind":"add"}],"status":"completed"}}
{"type":"turn.completed","usage":{"input_tokens":42053,"cached_input_tokens":31232,"output_tokens":121,"reasoning_output_tokens":16}}
```

`thread_id` from `thread.started` is the session id to persist for resume.

**Gotcha (resume argv):** `codex exec resume` accepts neither `--sandbox` nor `-C/--cd` (probed
2026-09-06 via `codex exec resume --help`). So on resume the working directory comes from the
SPAWN CWD only, and the sandbox is re-asserted through `-c sandbox_mode="workspace-write"`.
Codex also filters resumable sessions BY cwd, which is why a Crew agent's `cwd` is a permanent
pin once it has a native session: moving it into a new worktree must start a FRESH session, not
resume (see `Orchestrator.assign`).

→ `item.completed` with `item.type:"agent_message"` → `AgentEvent{type:"text"}`;
`file_change` → `AgentEvent{type:"tool"}`; `turn.completed` → `AgentEvent{type:"result"}`.

**Gotcha:** with no prompt on argv *and* an open stdin, codex prints
`Reading additional input from stdin...` and waits. Always pass the prompt as an argument
**and** close/redirect stdin (`stdio: ["ignore", ...]` or `< /dev/null`), or turns hang.

**Proof of real work:** the probe run created `/tmp/crew-probe-codex/crew-codex.txt`
containing exactly `CREW_CODEX_OK`.

---

## opencode — 1.18.26 (`/Users/macbookair/.opencode/bin/opencode`)

**Invocation (proven):**

```sh
opencode run --format json --dir <dir> -m "openrouter/<model>" "<prompt>"
```

- `opencode run [message..]` is the non-interactive entry point.
- `--format` ∈ `default` | `json` (raw JSON events).
- `-m/--model` takes `provider/model`. `--variant` sets provider-specific reasoning effort.
- `--dir` sets the working directory. `--agent <name>` selects an agent.
- Resume: `-c/--continue` (last session) or `-s/--session <id>`; `--fork` forks it.
- `--auto` auto-approves permissions — **dangerous, do not use by default**.
- `opencode serve` runs a headless server; `--attach <url>` talks to a running one. Not
  needed for MVP (per-turn subprocesses are enough, spec §18) but is the natural upgrade
  path if per-turn startup cost becomes a problem.

**Observed event stream** (one JSON object per line):

```json
{"type":"step_start","timestamp":...,"sessionID":"ses_f8c8...","part":{...,"type":"step-start"}}
{"type":"text","timestamp":...,"sessionID":"ses_f8c8...","part":{"type":"text","text":"CREW_OPENCODE_OK","time":{...}}}
{"type":"step_finish","timestamp":...,"sessionID":"ses_f8c8...","part":{"reason":"stop","tokens":{"total":31157,"input":30967,"output":7,"reasoning":183,"cache":{...}},"cost":0.02393775}}
```

`sessionID` is the value to persist for `-s`.

→ `text` → `AgentEvent{type:"text"}` (text lives at `part.text`);
`step_finish` → `AgentEvent{type:"result"}` (carries `cost` and `tokens`).

**Gotcha (important):** stdout is **not** pure JSONL. A Warp terminal plugin
(`plugin_version: 0.1.7`) interleaves OSC escape sequences directly into the stream, e.g.

```
]777;notify;warp://cli-agent;{"v":1,"agent":"opencode","event":"session_start",...}
```

These appear *inline*, sometimes concatenated onto the front of a real JSON line with no
separating newline. A naive `JSON.parse` per line will throw. The adapter must strip
`\x1b]777;...` / `]777;...` OSC payloads (terminated by BEL `\x07` or ST) before parsing, and
must tolerate a JSON object starting mid-line. Parse defensively: scan for the first `{` that
begins a balanced JSON object rather than assuming line == object.

**Providers configured on this machine** (`opencode providers list`, credentials in
`~/.local/share/opencode/auth.json`): OpenCode Zen, AKI.IO, **OpenRouter**. 425 models total,
353 of them `openrouter/*`.

Crew must never read, copy or persist those credentials (spec §44) — OpenCode owns auth.

**Proof of real work:** the probe returned `CREW_OPENCODE_OK` via
`openrouter/~google/gemini-flash-latest`, reported cost `$0.0239`.

---

## Cross-cutting adapter rules

1. **Spawn directly, never through a shell** — `spawn(exe, args, {cwd, shell:false})` (spec §30).
2. **Close stdin** unless the runtime is being fed input deliberately (codex hangs otherwise).
3. **Tolerate unknown event types.** All three runtimes emit event kinds not listed here; an
   adapter must forward them as-is or drop them, never crash.
4. **Persist the native session id** (`session_id` / `thread_id` / `sessionID`) so a logical
   Crew agent can resume across turns (spec §18/§46).
5. **Never enable the bypass/auto-approve flags by default** —
   `--dangerously-bypass-approvals-and-sandbox` (codex), `--auto` (opencode), and Claude's
   bypass permission modes are all opt-in only, and never in the default profiles.
