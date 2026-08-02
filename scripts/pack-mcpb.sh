#!/usr/bin/env bash
# Build the Claude Desktop bundle: build/okf-mcp.mcpb
# Stages compiled output + production deps in build/mcpb so the archive
# carries no sources, tests, or dev dependencies.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$root/build/mcpb"

rm -rf "$stage"
mkdir -p "$stage"

npm --prefix "$root" run build

cp -R "$root/dist" "$stage/dist"
cp "$root/manifest.json" "$root/package.json" "$root/package-lock.json" "$stage/"
[ -f "$root/icon.png" ] && cp "$root/icon.png" "$stage/"

(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

npx --yes @anthropic-ai/mcpb pack "$stage" "$root/build/okf-mcp.mcpb"
echo "Bundle written to build/okf-mcp.mcpb"
