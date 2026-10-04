---
name: digest
description: Use when the user asks for a digest or a status round-up of their own work — "make a digest", "зроби дайджест", "що в мене зараз", "what's waiting on me", "round-up of my MRs/PRs/tickets". Reads the sources in ~/.config/docket/digest.json (GitLab, GitHub, Notion, local git, docket), checks every status against the source, and publishes a structured digest to the Docket dashboard with digest_publish. Read-only towards every source.
---

# Docket digest

You compile it; Docket only stores and shows it. The dashboard at `http://localhost:8787/`
renders the latest digest as the home page, and it syncs to the user's paired devices.
A digest is a **snapshot of what is true now**, built from what you actually read — never
from memory, chat history or what a previous digest said.

**Read-only, without exception.** You read MRs, PRs, tickets and commits. You never
comment, approve, merge, assign, change a status or edit a page while doing this, even if
something looks obviously wrong — that goes in the digest as an item with `attention: true`.

## 1. Config

Read `~/.config/docket/digest.json`. If it does not exist, load the `docket:digest-setup`
skill and run it first, then come back here. Never guess usernames, groups or databases.

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

A source that is absent or `"enabled": false` is skipped and **not** listed in `sources`.

## 2. Window

- `"since-last"` (default): `digest_list(limit: 1)`, then `digest_get` on it. The new
  window starts at its `windowTo` (or `createdAt`). No previous digest → last 24 hours.
- `"24h"` / `"7d"`: that long back from now.
- The user's words win: "за тиждень" → 7 days, "з понеділка" → since Monday 00:00 local.

Keep the previous digest open — step 5 needs it to say what changed.

## 3. Collect

Run independent sources in parallel (one Bash call per source is fine). Collect raw facts;
judge them in step 5. `<since>` is the window start as an ISO timestamp.

**GitLab** (`glab`, read-only — never `mr approve/merge/note`, `ci run`):
```sh
# waiting on the user's review
glab api "merge_requests?scope=all&state=opened&reviewer_username=<user>&per_page=100"
# the user's own MRs touched in the window (opened, merged, closed)
glab api "merge_requests?scope=all&author_username=<user>&updated_after=<since>&per_page=100"
```
Keep only MRs whose `references.full` / `web_url` falls under one of `groups` (when set).
For the user's open MRs, the pipeline and approvals matter: `glab api
"projects/<id>/merge_requests/<iid>/approvals"` and the MR's `head_pipeline.status`
(`glab api "projects/<id>/merge_requests/<iid>"`). A failed pipeline is `tone: "bad"`.

**GitHub** (`gh`, read-only):
```sh
gh search prs --review-requested=@me --state=open --json number,title,url,repository,updatedAt,isDraft --limit 100
gh search prs --author=@me --updated=">=<YYYY-MM-DD>" --json number,title,url,repository,state,updatedAt,isDraft --limit 100
```
Filter by `owners` when set. A merged PR shows `state: closed` here — confirm merged vs
closed with `gh pr view <url> --json state,mergedAt,reviewDecision,statusCheckRollup`.

**Notion** (the MCP server named in `server`; read only — no create/update tools):
query each configured database for pages assigned to `assignee` and edited since `<since>`,
plus every page assigned to them that is currently in a blocked/waiting status regardless
of date. Take the ticket id (e.g. `VPQ-683`), title, status and page URL. If the server
isn't connected in this session, record the source as failed with that reason — don't
switch to a different Notion connector that can't see the same workspace.

**git** (local): for each repo under `roots` (one level down, those with a `.git`):
`git -C <repo> log --all --since=<since> --author=<author> --format='%h %ad %s' --date=iso`,
and `git -C <repo> status --short | wc -l` for uncommitted work. Unpushed branches:
`git -C <repo> log --branches --not --remotes --oneline | wc -l`. This is the only source
for work that never reached a remote — report it as such, never as shipped.

**docket**: `todo_list(workspace: "*", filter: "all", verbose: true)` — what was completed
in the window, what is claimed right now, what is overdue or high priority.

A source that errors (auth expired, CLI missing, MCP not connected) still goes in
`sources` with `ok: false` and the reason in `detail`. Never drop a failed source
silently — the dashboard shows it in red so the user knows the digest has a blind spot.

## 4. Check before you claim

- **Merged** means the source says merged (`merged_at` / `mergedAt`), not "approved".
- **Released** means a tag or release exists.
- A ticket's status is the status the page has *now*, not the one in the previous digest.
- Numbers in metrics are counts of items in this digest, so the tiles and the lists agree.

## 5. Compose

Write in the configured `language` (default: the language the user wrote to you in).

**Link things up.** An MR that implements a Notion ticket is ONE item: kind of the thing
the user acts on (usually the MR), the ticket id in `note` ("Implements VPQ-683"). The same
PR found by two queries is one item.

**`attention: true`** — only when the user personally has to do something:
a review requested from them, their MR with a failed pipeline or requested changes, their
ticket that is blocked or waiting on their answer, an overdue docket item. Not "it's open".

**Tone** — `good` merged/released/done · `warn` waiting, stale (no movement ≥ 3 days),
review requested · `bad` failed pipeline, blocked, changes requested, overdue · `info` in
progress · `neutral` everything else.

**Sections**, in this order, skipping empty ones:
1. **Needs you** — every `attention` item, most urgent first.
2. **Shipped** — merged, released, closed-as-done in the window.
3. **In review** — the user's own open MRs/PRs.
4. **In flight** — tickets in progress, claimed docket items, unpushed local work.
5. **Stuck** — anything with no movement for 3+ days that isn't already above.

Each item: `kind`, `title` (as the source has it), `url` (always, when one exists),
`ref` (`!154`, `#12`, `VPQ-683`, `v1.8.2`), `repo`, `status` (source wording), `tone`,
`updatedAt`, and a `note` only when it adds judgement — why it matters, what it blocks,
what changed since last time. No note that repeats the title.

**Title** — the date and the one or two facts that matter most:
`Пт 4 жовт — 2 MR чекають твого рев'ю, VPQ-683 заблоковано`.

**Summary** — 2–5 sentences of markdown. The first sentence is the most important thing.
Say what **changed since the previous digest** (newly merged, newly blocked, newly waiting),
not a restatement of the lists. No greetings, no "here is your digest".

**Highlights** — 2–5 one-liners, each an action or a decision, most important first.

**Metrics** — 3–6 tiles, e.g. `Чекають на тебе`, `Змерджено`, `Заблоковано`, `Відкриті PR`.
Give `tone` to the ones that should draw the eye.

## 6. Publish

Call `digest_publish` with everything above plus `sources`, `windowFrom`, `windowTo`.
If it rejects the digest, the error names the field — fix that and call again.

Then reply in chat with at most 4 lines: the title, the "needs you" items as a short list
with links, and `http://localhost:8787/`. The dashboard is where the detail lives.
