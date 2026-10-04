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
    "docket": { "enabled": true }
  }
}
```

- `window`: `since-last` (from the previous digest's end; 24 hours if there is none), `24h`,
  or `7d`. What the user asks for ("за тиждень") overrides it.
- `language`: the language of the digest text. The dashboard chrome is English.
- No secrets belong in this file.

## Shape

```text
Digest
├─ title, summary (markdown), highlights[]
├─ metrics[]   { label, value, tone }
├─ sections[]  { title, items[] }
│    └─ item   { kind, title, url, ref, repo, status, tone, attention, note, updatedAt }
├─ sources[]   { name, ok, detail }           ← failed sources show in red
└─ windowFrom, windowTo, agent, device, workspace, createdAt
```

`kind` is one of `pr mr issue ticket commit release todo doc note`; `tone` one of
`good warn bad info neutral`. Limits (enforced on publish, clamped on sync): 300 items per
digest, 16 sections, 8 metrics, 12 highlights, 12 000 characters of summary. Links must be
`http(s)`.

A digest is **immutable**. A new look at the sources is a new digest; the dashboard's
timeline keeps the earlier ones, and the skill reads the previous one to say what changed.

## Storage and sync

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

Not yet supported in remote (self-hosted server) mode: the tools refuse rather than write a
digest no dashboard would read.

## Dashboard

- `/` — the selected digest (newest by default): summary, highlights, metric tiles,
  sections; a **Tasks** card (open, in progress, overdue, due in 7 days, the five most
  pressing items); the timeline of earlier digests.
- `/tasks` — the task list, as before.
- **+ task** on any item creates a todo: ticket-shaped refs (`VPQ-683`) become its category,
  the link becomes its `sourceUrl`, "needs you" becomes high priority. An item whose link
  already belongs to a task shows **in tasks** instead.
- A digest older than 24 hours is labelled as possibly out of date.
