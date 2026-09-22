# Installing Docket (for AI agents)

Docket is an MCP server over stdio. It needs Node.js 18 or newer and nothing else: no
account, no API key, no network service.

## Recommended: let Docket configure the host

```sh
npx -y @pasichdev/docket setup
```

It detects Claude Code, Codex, Cursor and Windsurf, adds itself to each, and prints which
ones it configured. Non-interactive runs (no TTY) accept every default.

## Manual: add it to one host's MCP config

```json
{
  "mcpServers": {
    "docket": {
      "command": "npx",
      "args": ["-y", "@pasichdev/docket"]
    }
  }
}
```

Optional: `"env": { "DOCKET_DATA_DIR": "/absolute/path" }` to choose where the list is stored
(default `~/.docket`). Every host that should share one list must use the same directory.

## Verify

Restart the host, then call `todo_add` with `{"title": "try docket"}` and `todo_list` with no
arguments; the new item should be listed. A dashboard is served at http://localhost:8787 as
soon as the first client connects.

No other configuration is required.
