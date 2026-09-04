#!/usr/bin/env bash
# Builds the three-project environment for the workspace demo, so recording it is a matter
# of pressing record and typing four commands rather than staging anything.
#
# The cast itself is NOT generated here, and deliberately so: the README's central claim is
# "three projects, several agents, one list, correctly scoped", and the thing that backs a
# claim like that is a recording of it actually happening. A synthetic cast would look
# identical and mean nothing.
#
#   ./docs/assets/demo-setup.sh          # build the environment, print what to type
#   ./docs/assets/demo-setup.sh --clean  # tear it down
#
# Everything lives under a temp directory and a non-default port, so your real data
# directory and your running server are never touched.

set -euo pipefail

ROOT="${TMPDIR:-/tmp}/docket-demo"
export DOCKET_DATA_DIR="$ROOT/data"
export DOCKET_WEB_PORT=8799
DOCKET="${DOCKET:-node $(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/dist/launcher.js}"

if [[ "${1:-}" == "--clean" ]]; then
  pkill -f "DOCKET_WEB_PORT=$DOCKET_WEB_PORT" 2>/dev/null || true
  pkill -f "dist/web.js" 2>/dev/null || true
  rm -rf "$ROOT"
  echo "Removed $ROOT"
  exit 0
fi

rm -rf "$ROOT"
mkdir -p "$DOCKET_DATA_DIR"

# Three projects that resolve to three different workspaces — via their git remotes, which
# is the mechanism the demo is meant to show. No git binary needed: the resolver reads
# .git/config directly.
make_project() {
  local dir="$ROOT/$1" remote="$2"
  mkdir -p "$dir/.git"
  printf '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = %s\n' "$remote" > "$dir/.git/config"
}
make_project work-backend  "git@gitlab.com:acme/backend.git"
make_project side-tracker  "https://github.com/you/tracker.git"
make_project side-notes    "https://github.com/you/notes.git"

# Seed each project with a couple of items, filed the way an agent would file them.
seed() {
  local workspace="$1"; shift
  for title in "$@"; do
    curl -sS -X POST "http://127.0.0.1:$DOCKET_WEB_PORT/api/todos" \
      -H 'Content-Type: application/json' \
      -d "$(printf '{"title":%s,"workspace":%s}' "$(printf '%s' "$title" | sed 's/"/\\"/g;s/.*/"&"/')" "\"$workspace\"")" > /dev/null
  done
}

node "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/dist/web.js" > "$ROOT/web.log" 2>&1 &
sleep 2

seed "acme/backend" "fix token refresh race" "drop the legacy auth path"
seed "you/tracker"  "ship the new nav"
seed "you/notes"    "write up the migration notes"
curl -sS -X POST "http://127.0.0.1:$DOCKET_WEB_PORT/api/todos" -H 'Content-Type: application/json' \
  -d '{"title":"a thought with no project yet"}' > /dev/null

cat <<EOF

Environment ready under $ROOT (port $DOCKET_WEB_PORT, data dir isolated).

Record with:  asciinema rec docs/assets/demo-workspaces.cast --cols 100 --rows 24
Keep it under 30 seconds, no narration, no editing. Then type, in this order:

  cd $ROOT/work-backend && docket list
  cd $ROOT/side-tracker && docket list
  cd $ROOT/side-notes   && docket list

Each shows that project's items plus the unfiled one, and says what it scoped to.
Then open http://localhost:$DOCKET_WEB_PORT and click through the workspace switcher —
the counts per project are the point.

Finally, from one project, add an item and show it landing scoped:

  cd $ROOT/work-backend && docket list          # before
  # (add one from an agent session in that directory)
  cd $ROOT/work-backend && docket list          # after

Tear down with: ./docs/assets/demo-setup.sh --clean
EOF
