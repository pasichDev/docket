---
name: digest-setup
description: Use when the user wants to set up or change what Docket digests read — "налаштуй дайджест", "configure the digest", "add GitHub to my digest", "change the Notion database" — or when docket:digest finds no ~/.config/docket/digest.json. Detects which CLIs and MCP servers are available, asks which sources to use, and writes the config. Never writes to any source.
---

# Docket digest setup

Writes `~/.config/docket/digest.json`, which `docket:digest` reads. It is local to this
machine on purpose — paths and CLI logins differ per device — while the digests themselves
sync. Existing file → read it first and change only what the user asked about.

## 1. Detect, don't ask what you can find out

Run in parallel, all read-only:

```sh
glab auth status 2>&1 | head -5          # GitLab host + username
gh auth status 2>&1 | head -5            # GitHub username
git config --global user.email           # default git author
```

- GitLab user: `glab api user | jq -r .username` (or parse `auth status`). Groups the user is
  active in: `glab api "groups?min_access_level=30&per_page=50" | jq -r '.[].full_path'`.
- GitHub user: `gh api user --jq .login`; owners: the user plus `gh api user/orgs --jq '.[].login'`.
- Notion: look at the MCP tools available in this session for a Notion server (tool names
  containing `notion`). Note the server name. If there is more than one, the user picks —
  different servers can see different workspaces. Find candidate databases with that
  server's search tool (query "tasks", "tickets", or the user's words), never a broad
  workspace dump.
- Obsidian: a vault is a folder with a `.obsidian/` directory in it — look in the usual
  places (`~/Documents`, `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/`) and
  ask which one when there are several.
- Other MCP servers: list the servers this session can call (the `<server>` part of every
  `mcp__<server>__*` tool name). Ones that hold work items or signals — Jira / Atlassian,
  Linear, YouTrack, GitHub Projects, Sentry, Slack, a calendar — are candidates for `extra`
  sources. Look only at tool names and descriptions here; don't call anything yet.
- Project files: docs, ADR or notes folders inside the git roots (`docs/`, `adr/`,
  `notes/`) are candidates for a `files` source.
- git roots: the directories holding the user's repos (for example `~/repo`, `~/src`);
  check with `ls`, and that subdirectories contain `.git`.

A CLI that is missing or logged out is reported, not fixed: tell the user the exact login
command (`glab auth login`, `gh auth login`) and leave that source disabled.

## 2. Ask once

One `AskUserQuestion` call (two if you need all six questions), pre-filled from what you detected:

1. **Sources** (multiSelect): GitLab · GitHub · Notion · local git · Obsidian, plus one
   option per extra MCP server or files folder you found (docket is always on). "Other"
   lets the user name a server or folder you didn't find.
2. **Scope**: which GitLab groups / GitHub owners — offer the detected ones.
3. **Notion database**: the candidates you found, by name.
4. **Groups**: how to split the digest by area — offer one built from what you found
   (the work GitLab group, personal GitHub repos, anything else), e.g. Work / Learning /
   Side projects. Each group is a name plus `match` strings checked against an item's url,
   repo and ref; `"*"` catches the rest.
5. **Presets and schedule**: suggest presets from the groups (one per group, plus "week")
   and ask whether a daily digest should run on its own, and at what time.
6. **Language** of the digest text: the language the user writes in (recommended) or English.

For each chosen extra MCP server, write the `query` in plain words from what the user
wants to see ("Jira issues assigned to me, updated since <since>") and pick the `kind`;
ask only when the server could mean several things (Slack: which channels?).

For Notion also confirm the assignee name exactly as it appears on the database's
person property — that is what the digest filters on.

## 3. Write

```json
{
  "version": 1,
  "language": "uk",
  "window": "since-last",
  "sources": {
    "gitlab": { "enabled": true, "host": "gitlab.com", "user": "<username>", "groups": ["<group>"] },
    "github": { "enabled": true, "user": "<login>", "owners": ["<login>"] },
    "notion": { "enabled": true, "server": "<mcp server name>", "databases": [{ "name": "<name>", "id": "<id or url>" }], "assignee": "<person>" },
    "git":    { "enabled": true, "roots": ["~/repo"], "author": "<email>" },
    "obsidian": { "enabled": true, "vault": "<vault path>" },
    "docket": { "enabled": true }
  },
  "extra": [
    { "name": "<jira>", "type": "mcp", "server": "<mcp server name>", "kind": "ticket", "query": "<what to read, in plain words>" },
    { "name": "<docs>", "type": "files", "paths": ["<folder>"], "glob": "*.md" }
  ],
  "presets": { "<group>": { "groups": ["<group>"] }, "week": { "window": "7d" } },
  "schedule": { "daily": "09:00" },
  "groups": [
    { "name": "<work>", "match": ["gitlab.com/<group>/", "<TICKET-PREFIX>-"] },
    { "name": "<other>", "match": ["*"] }
  ]
}
```

No tokens, passwords or API keys in this file — the CLIs and MCP servers hold credentials.
Show the user the file you wrote (it is short), then offer to run `docket:digest` now.

A daily schedule is installed by `docket:digest` ("Daily, on its own"), not here — offer to
do it right after the first digest, so the user sees one before automating it.

Mail is opt-in: offer a Gmail/Outlook MCP server only if the user picks it, and say plainly
that the digest reads sender, subject and date, not message bodies.

**Changing it later** ("додай Jira", "прибери Slack", "move kernel-notes to Learning"):
read the file, change only that part — an entry in `sources` or `extra`, or a `match`
string in `groups` — and show the diff.
