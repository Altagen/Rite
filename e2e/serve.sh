#!/usr/bin/env sh
# Launch a fresh rite-server for the e2e harness:
#   - frontend served from disk (RITE_WEB_DIR) so no server recompile per UI change
#   - a throwaway vault under an isolated HOME, wiped each run for a first-run start
#   - no token (dev mode); the guard is exercised separately
set -e

export HOME="${RITE_E2E_HOME:-/tmp/rite-e2e-home}"
rm -rf "$HOME/.local/share/rite"
mkdir -p "$HOME"

export RITE_ADDR="127.0.0.1:${RITE_E2E_PORT:-1421}"
export RITE_WEB_DIR="$PWD/apps/desktop/dist"

exec "$PWD/target/debug/rite-server"
