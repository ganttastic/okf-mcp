#!/usr/bin/env bash
# Generate a double-clickable installer for a handed-out deploy key:
#
#   scripts/make-key-installer.sh <private-key-file> [output.command]
#
# The output (default: build/Install OKF Deploy Key.command) embeds the key
# and, when double-clicked on macOS (or run with sh anywhere), writes it to
# ~/.config/okf-mcp/deploy-key with the permissions ssh requires. The OKF
# server picks up a key at that location automatically, so the recipient
# flow is: double-click this, double-click the .mcpb, Install.
set -euo pipefail

key_file="${1:-}"
out="${2:-build/Install OKF Deploy Key.command}"

if [ -z "$key_file" ] || [ ! -f "$key_file" ]; then
  echo "usage: $0 <private-key-file> [output.command]" >&2
  exit 1
fi
if ! grep -q "PRIVATE KEY" "$key_file"; then
  echo "error: $key_file does not look like a private key" >&2
  exit 1
fi
if grep -q "OKF_KEY_EOF" "$key_file"; then
  echo "error: $key_file contains the embedding delimiter" >&2
  exit 1
fi

mkdir -p "$(dirname "$out")"
{
  cat <<'HEADER'
#!/bin/sh
# Installs the OKF read-only deploy key for the OKF connector.
# Double-click on macOS, or run: sh "Install OKF Deploy Key.command"
set -eu
dest="$HOME/.config/okf-mcp"
mkdir -p "$dest"
chmod 700 "$dest"
umask 177
cat > "$dest/deploy-key" <<'OKF_KEY_EOF'
HEADER
  cat "$key_file"
  cat <<'FOOTER'
OKF_KEY_EOF
chmod 600 "$dest/deploy-key"
echo ""
echo "Deploy key installed at $dest/deploy-key."
echo "Now double-click the OKF connector bundle (.mcpb) to finish installing."
FOOTER
} > "$out"
chmod +x "$out"

echo "Key installer written to: $out"
echo "Send it alongside the .mcpb. Recipients double-click it first."
