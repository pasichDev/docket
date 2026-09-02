---
name: todo-mcp-claim
description: Use whenever adding, editing, or working an item tracked in todo-mcp (the shared todo_add/todo_edit/todo_list/todo_claim MCP tools) — set the fields the tools actually support (title + optional description, category, priority, dueDate), and claim/release around substantive work so other agents/sessions sharing the same list see what's in progress.
---

# todo-mcp: full tool surface + claim workflow

todo-mcp is a shared backlog/todo list across multiple AI clients (Claude
Code, Warp, Codex, or any other MCP host) and multiple concurrent sessions,
with a web UI (default `http://localhost:8787`). Use the fields the tools
support — don't just dump everything into one string.

## Fields (todo_add / todo_edit)

- `title` (required) — short one-line summary. Shown in a distinct heading
  font in the web UI; keep it a title, not a paragraph.
- `description` (optional) — the longer body: details, context, links,
  repro steps. Put anything beyond one line here, not crammed into `title`.
- `list`: `"todo"` (near-term actionable, default) or `"backlog"` (park it,
  don't hold it in context).
- `category` (optional) — free-form tag, typically a ticket id like
  `"PROJ-834"`. Drives the colored badge/card-tint in the UI and is
  filterable/searchable — set it whenever the item maps to a real ticket.
- `priority` (optional): `"low" | "medium" | "high"`.
- `dueDate` (optional): `"YYYY-MM-DD"`.
- `sourceUrl` (**strongly recommended whenever there is one**) — a link back
  to where this item came from: a GitHub issue/PR, a Notion page, an
  Obsidian note's share/publish link, a Slack thread, a doc, a Linear/Jira
  ticket — any URL. Set it whenever you create or already know about an item
  that maps to something with a URL, so a human can jump straight back to
  the source later instead of re-finding it. Shown as a small clickable link
  chip on the card.
- `todo_edit(id, ...)` changes only the fields you pass; pass `""` to clear
  description/category/priority/dueDate/sourceUrl.

Use `todo_list(filter, list, category, agent, session, inProgress, limit,
offset)` to query — it supports filtering by all of the above, not just
open/done, plus pagination for large lists.

Other tools you have: `todo_history(id)` — full change log for one item, who
did what and when. `todo_delete(id)` — permanently remove an item (destructive,
confirm with the human first unless they clearly already decided). `todo_version()`
— sanity-check the running server isn't stale (e.g. right after an update).
`todo_check_update()` — read-only check for a newer todo-mcp version; if one's
available, tell the human and let them run `todo-mcp update` themselves —
never trigger it yourself.

## Claim workflow

Claiming makes "who's doing what right now" visible instead of silent
duplicate effort across the shared clients/sessions.

1. **Before starting** substantive work on a specific item (not just glancing
   at the list), call `todo_claim(id)`.
2. **When you stop:**
   - Finished the work → `todo_complete(id)` (this also clears the claim).
   - Stopping without finishing → `todo_release(id)`.
3. **Before picking a NEW item** from the backlog/todo list, check
   `todo_list(inProgress: true)` first — if it's already claimed by another
   agent, don't start the same item unless you're deliberately taking over
   (todo_claim will warn you and let you take over anyway).
4. A claim self-expires after 15 minutes if never renewed, completed, or
   released — `todo_list(inProgress: true)` only shows claims still inside
   that window, so a claim you forgot to release will quietly stop blocking
   other agents on its own rather than needing manual cleanup.

## When claiming doesn't apply

- Quick one-off adds/completes that aren't "picking up a backlog item to work
  through" — no need to claim something you're completing in the same breath.
- Read-only browsing of the list.
