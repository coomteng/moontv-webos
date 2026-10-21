#!/usr/bin/env bash
# Package the TV app with the real bridge address substituted for the BRIDGE_HOST placeholder.
# Reads BRIDGE_BASE from local.env (git-ignored). The source tree is left untouched.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$PATH"
[ -f local.env ] && . ./local.env
: "${BRIDGE_BASE:?set BRIDGE_BASE=http://<bridge-host>:8788 in local.env}"
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
cp -r app "$STAGE/app"
sed -i "s#http://BRIDGE_HOST:8788#${BRIDGE_BASE}#" "$STAGE/app/js/api.js"
grep -q "BRIDGE_HOST" "$STAGE/app/js/api.js" && { echo "placeholder still present" >&2; exit 1; }
rm -rf dist && ares-package "$STAGE/app" -o dist | tail -1
echo "BASE in ipk: $(grep -o "var BASE = .*" "$STAGE/app/js/api.js" | head -1)"
ls dist
