#!/usr/bin/env bash
# Build a Claude Desktop bundle: build/<name>.mcpb
#
# Extra arguments bake pre-filled defaults into the installer's config form,
# so a recipient double-clicks, maybe drops in a credential, and is done:
#
#   npm run pack:mcpb                                      # generic installer
#   npm run pack:mcpb -- --name okf-dash \
#     --display-name "DASH Wiki" \
#     --git https://github.com/DashAuction/dash-wiki.git#main
#
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

node "$root/scripts/inject-defaults.mjs" "$stage/manifest.json" "$@"

(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

name="$(node -p "JSON.parse(require('fs').readFileSync('$stage/manifest.json','utf8')).name")"
npx --yes @anthropic-ai/mcpb pack "$stage" "$root/build/$name.mcpb"
echo "Bundle written to build/$name.mcpb"
