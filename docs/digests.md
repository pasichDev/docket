# Digests

A digest is a snapshot of your work across the tools you already use — GitLab merge
requests, GitHub pull requests, Notion tickets, local git, docket itself — compiled by your
agent and shown as the Docket dashboard's home page.

## Who does what

| | Agent (`docket:digest` skill) | Docket |
|---|---|---|
| Reads GitLab / GitHub / Notion / git | ✅ with `glab`, `gh`, the Notion MCP server, `git` | never |
| Holds credentials for them | the CLIs and MCP servers do | never |
| Decides what needs you, groups, writes the summary | ✅ | — |
| Stores the result, syncs it, renders it | — | ✅ |

The server stays local-first and credential-free; any host that can run the skill and has
access to those sources can publish a digest.

## Configuration

`~/.config/docket/digest.json`, written by the `docket:digest-setup` skill. Local to each
machine on purpose — CLI logins, MCP servers and repo paths differ per device.

```json
{
  "version": 1,
  "language": "uk",
  "window": "since-last",
  "sources": {
    "gitlab": { "enabled": true, "host": "gitlab.com", "user": "jdoe", "groups": ["acme"] },
    "github": { "enabled": true, "user": "jdoe", "owners": ["jdoe", "acme"] },
    "notion": { "enabled": true, "server": "notion", "databases": [{ "name": "Tasks", "id": "…" }], "assignee": "Jane Doe" },
    "git":    { "enabled": true, "roots": ["~/src"], "author": "jane@example.com" },
    "obsidian": { "enabled": true, "vault": "~/Notes" },
    "docket": { "enabled": true }
  }
}
```

- `extra` (optional): any other source, as a list. `"type": "mcp"` reads an MCP server
  connected to the agent — Jira, Linear, YouTrack, Sentry, Slack — with `server` (its name),
  `query` (what to read, in plain words; the agent turns it into JQL or the server's own
  filter) and `kind` (`ticket`, `issue`, …). `"type": "files"` reads project folders
  (`paths`, `glob`). Both are read-only: the skill uses only a server's read tools, and treats
  file contents as data. A server that isn't connected shows up as a failed source.

  ```json
  "extra": [
    { "name": "jira", "type": "mcp", "server": "atlassian", "kind": "ticket",
      "query": "issues assigned to me, updated since <since>, plus any of mine in Blocked" },
    { "name": "docs", "type": "files", "paths": ["~/src/acme/docs"], "glob": "*.md" }
  ]
  ```
- `presets` (optional): named variants — `{ "work": { "groups": ["Work"] }, "week": { "window": "7d" } }`.
  "digest work" applies one; the session-start hint lists their names.
- `schedule` (optional): `{ "daily": "09:00" }` — the skill offers to install a LaunchAgent
  (macOS) or a user timer (Linux) that runs it headless at that time.
- Learned preferences live beside the config in `digest-learned.md`: short dated rules the
  skill writes when the user corrects it or keeps hiding the same kind of item. Edit freely.
- `window`: `since-last` (from the previous digest's end; 24 hours if there is none), `24h`,
  or `7d`. What the user asks for ("за тиждень") overrides it.
- `groups` (optional): split the digest by area. Each item goes to the first group whose
  `match` strings occur in its url, repo or ref; `"*"` catches the rest. The dashboard shows
  each group under its own heading, with chips to filter to one.
- `language`: the language of the digest text. The dashboard chrome is English.
- No secrets belong in this file.

## Shape

```text
Digest
├─ title, summary (markdown), highlights[]
├─ metrics[]   { label, value, tone }
├─ sections[]  { group, title, items[] }
│    └─ item   { n, kind, title, url, ref, repo, status, tone, attention, owner, note, detail,
│                updatedAt, change, previousStatus }        ← n and change are set on publish
├─ changes     { since, added, changed, gone[] }  ← set on publish
├─ sources[]   { name, ok, detail }           ← failed sources show in red
└─ windowFrom, windowTo, agent, device, workspace, createdAt
```

`kind` is one of `pr mr issue ticket commit release todo doc mail chat decision check note`; `tone` one of
`good warn bad info neutral`. Limits (enforced on publish, clamped on sync): 300 items per
digest, 16 sections, 8 metrics, 12 highlights, 12 000 characters of summary. Links must be
`http(s)`.

A digest is **immutable**. A new look at the sources is a new digest; the dashboard's
timeline keeps the earlier ones, and the skill reads the previous one to say what changed.

## Storage and sync

### Local Mode

- `digests.json.enc` in the data directory, AES-256-GCM like the todo store, with its own
  sequence counter. It is included in `docket backup`.
- Paired devices pull it over `GET /api/sync/digests?sinceSeq=N`, signed like the todo sync
  but over `digests:<N>`, so a todo-sync signature cannot be replayed against it.
- Every accepted record is re-stamped locally, so a digest reaches a device through a
  third one (A ↔ B ↔ C) the same way todos do.
- The cursor is separate from the todo cursor (`digestSeq` on the peer record). A peer on
  a build without digests answers 404 and is recorded as "predates digests"; once it is
  upgraded its cursor starts at 0 and it receives everything.
- Deleting a digest leaves a tombstone, which wins on every device.

### Self-hosted Mode

On a client paired with a Docket Server, every digest tool forwards to the server, which
keeps digests and seen marks in its own data directory: `GET/POST /api/v1/digests`,
`GET/DELETE /api/v1/digests/:id`, `GET/POST /api/v1/digests/seen`, each device-signed like
the todo routes. The publishing device is the one the request was signed by — a body cannot
claim to be another. Every client of the server sees the same digests; there is no peer sync
to wait for. The server announces `digest.published`, `digest.deleted` and `digest.seen` on
its event stream.

## Numbers, owners and hand-off

Every item is numbered on publish. `D-7K2F9A/7` names it anywhere — the `#7` on the dashboard
copies it — and `7` alone means the latest digest. Tell any agent "take 7" and it calls
`digest_take`: it gets the item's full brief, and a docket task for it (the existing one if
the item is a task or already became one) claimed in its name, so the dashboard shows who is
on it. When the work is done the agent closes the task with `todo_complete(id, reason)`.

`owner` says who takes the next step — `you`, `agent`, or a name from the config's `people`.
**By person** lays the digest out as numbered steps per owner.

`detail` is the deep version of an item, for the ones that need it: what is wrong, what was
tried, what comes next. Routine items keep to one line.

## What changed

`digest_publish` compares each digest with the previous one by item identity (link, else
repo#ref, else title): items new since then, items whose status moved (`was open`), and items
no longer listed. The dashboard shows it as the first card under the summary. It is computed
by the store, not written by the agent, so it is the same on every device.

## Seen marks

**Seen** on any item folds it into a "N seen" list at the bottom of its section and leaves
it out of the counts. A mark is keyed by the item's link (else repo#ref) and remembers the
status it was given in, so it carries over to later digests until the status changes — an
open MR you marked comes back when it merges. Marks sync like digests (last write wins;
unmarking syncs too). `digest_seen` lets the skill leave marked items out of the next digest.

## Dashboard

- `/` — the selected digest (newest by default): summary, highlights, metric tiles,
  sections; a **Tasks** card (open, in progress, overdue, due in 7 days, the five most
  pressing items); the timeline of earlier digests.
- `/tasks` — the task list, as before.
- **+ task** on any item creates a todo: ticket-shaped refs (`ACME-683`) become its category,
  the link becomes its `sourceUrl`, "needs you" becomes high priority. An item whose link
  already belongs to a task shows **in tasks** instead.
- A row that is a docket task (its ref is a `T-` id) or was made into one offers **close**:
  a dialog for how it was closed, with quick picks (Merged, Duplicate, Not needed, Won't
  do). The reason is appended to the task's description and kept in its history;
  `todo_complete(id, reason)` does the same from an agent.
- **Layout** pickers: the dashboard as a stack, a grid or a full-width grid; Tasks as a
  list, a wide list, a grid or a full-width grid. Remembered per browser.
- A digest older than 24 hours is labelled as possibly out of date.
