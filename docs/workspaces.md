# Workspaces

Every item Docket stores is filed under a **workspace** — a stable slug naming
the project it was captured in. You never type it, and no agent has to
remember to.

Without this, one flat list fed by a work project plus two personal ones,
across several agents and many terminals, becomes unusable in about two weeks
— not because of a bug, but because you open it and can't find your own items.

It is also the single largest context saving in v3.0: an agent working in
project A stops pulling project B's items into its window on every
`todo_list`.

## Resolution order

First hit wins. Resolved once per session, at startup, and logged so a
mis-resolution is visible rather than mysterious (`~/.docket/server.log`, or
`docket hook doctor`, which prints it).

1. **`DOCKET_WORKSPACE`** — explicit, always wins.
2. **`.docket.json` at the repo root:**
   ```json
   { "workspace": "backend" }
   ```
   The escape hatch for monorepos, and for two unrelated projects whose
   directories happen to share a basename.
3. **The git remote**, normalised: scheme, credentials, host, port and `.git`
   stripped, last two path segments kept.
   `git@gitlab.com:acme/backend.git` → `acme/backend`.
4. **The git root's basename** — a repo with no remote is still a project.
5. **`cwd`'s basename.**
6. **`null`** — no project context at all (a bare Claude Desktop session, say).

Every result is slugified the same way: lowercased, with runs of anything
outside `[a-z0-9._-]` collapsed to a single dash (`/` survives, because git
remotes are naturally `owner/repo`). So "Acme Backend" typed on one machine
and `acme-backend` on another do not quietly become two workspaces. The cost
is that an explicit name isn't preserved byte-for-byte.

### Why the remote and not the path

Because sync exists. The same repo cloned to `~/src/backend` on a laptop and
`/work/backend` on a desktop has to land in **one** workspace, or you get two
half-lists that each look complete. An SSH clone and an HTTPS clone of the
same repo normalise to the same slug for the same reason.

### Where `cwd` comes from

- **MCP `roots`**, if the host offers the capability — asked once after the
  client connects, so the host's own idea of the project wins over the
  process's working directory.
- **`process.cwd()`** otherwise. Each host spawns its own `node dist/index.js`,
  so this is normally the project directory — but nothing guarantees it, which
  is why the resolved workspace is logged.

## What scoping actually does

- **`todo_add`** stamps the session's workspace. An explicit `workspace`
  argument overrides it; you should essentially never need it.
- **`todo_list`** defaults to **this project plus unfiled items**. Unfiled
  items ride along deliberately — legacy and context-free items staying
  reachable is the difference between scoping a list and hiding work in it.
  - `workspace: "*"` → every project.
  - `workspace: "acme/backend"` → that one (plus unfiled).
  - When results were narrowed, one line says so:
    `(scoped to acme/backend — pass workspace:"*" for all)`.
- **Ids stay global.** An id from another workspace still resolves — an agent
  that has an id should get the item. The item then renders with `@its-workspace`
  so the agent isn't left thinking it landed in the project it's standing in.
- **`workspace` merges per-field** across devices, like any other content
  field: moving an item between projects on one machine survives an unrelated
  concurrent edit on another.

## Surfaces

| Where | How |
|---|---|
| MCP | `todo_list(workspace: …)`, automatic on `todo_add` |
| CLI | `docket list` (current project), `docket list -w <name>`, `docket list --all` |
| CLI | `docket workspaces` — open/total counts and last activity per project |
| CLI | `docket stats` — per-project open counts when there's more than one |
| Web UI | A workspace switcher with per-project open counts; remembers the last selection; `null` items appear under **Unfiled** |

## Legacy items

Items created before v3.0 get `workspace: null` — never a guess. There is no
honest way to know which project a v7 item came from, and a wrong workspace
hides an item somewhere its author will never look, which is strictly worse
than an "Unfiled" bucket they can see.

## What this deliberately is not

One field and a default filter. No workspace-level permissions, no
per-workspace data files, no per-workspace encryption keys. Anything more is a
different product.

## Self-hosted mode

Scoping works there too. The client sends its resolved project as
`X-Docket-Workspace` alongside the agent and session it already reported, so
items file themselves on the server exactly as they do locally, and the field
travels back on the todo record.

The client also applies the scope filter to what it receives. That is belt and
braces on purpose: a server too old to understand the parameter answers with
every project's items, and telling an agent its list is "scoped to
acme/backend" over an unscoped list would be precisely the kind of quiet
overstatement this project doesn't do.

Like `agent` and `session`, the workspace is self-reported — the server has no
view of the client's filesystem. It is descriptive, not a permission boundary;
see [Explicitly not doing](#what-this-deliberately-is-not).
