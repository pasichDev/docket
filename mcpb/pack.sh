#!/usr/bin/env bash
# Builds docket-<version>.mcpb — the one-click bundle for Claude Desktop and Smithery.
#
# It packs the PUBLISHED npm tarball, not this working tree, so the bundle is byte-for-byte
# the release its version number claims to be. Run it after `npm publish`.
#
#   ./mcpb/pack.sh            # -> mcpb/docket-<version>.mcpb
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="$(node -p "require('$here/manifest.json').version")"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

(cd "$stage" && npm pack --silent "@pasichdev/docket@$version" >/dev/null && tar -xzf ./*.tgz)
cd "$stage/package"
npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent
cp "$here/manifest.json" manifest.json
cp "$here/../docs/assets/logo.png" icon.png
npx -y @anthropic-ai/mcpb validate manifest.json
npx -y @anthropic-ai/mcpb pack . "$here/docket-$version.mcpb"
