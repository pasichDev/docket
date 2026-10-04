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
- git roots: the directories holding the user's repos (for example `~/repo`, `~/src`);
  check with `ls`, and that subdirectories contain `.git`.

A CLI that is missing or logged out is reported, not fixed: tell the user the exact login
command (`glab auth login`, `gh auth login`) and leave that source disabled.

## 2. Ask once

One `AskUserQuestion` call, up to four questions, pre-filled from what you detected:

1. **Sources** (multiSelect): GitLab · GitHub · Notion · local git (docket is always on).
2. **Scope**: which GitLab groups / GitHub owners — offer the detected ones.
3. **Notion database**: the candidates you found, by name.
4. **Language** of the digest text: the language the user writes in (recommended) or English.

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
    "docket": { "enabled": true }
  }
}
```

No tokens, passwords or API keys in this file — the CLIs and MCP servers hold credentials.
Show the user the file you wrote (it is short), then offer to run `docket:digest` now.
