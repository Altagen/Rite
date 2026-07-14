#!/usr/bin/env sh
# Second harness server, in server mode (accounts + sessions, ADR 0010), for the
# server-login e2e. Its own throwaway vault (separate HOME) on port 1422.
set -e

export HOME="${RITE_E2E_ACCOUNTS_HOME:-/tmp/rite-e2e-accounts-home}"
rm -rf "$HOME/.local/share/rite"
mkdir -p "$HOME"

export RITE_ADDR="127.0.0.1:1422"
export RITE_ACCOUNTS=1
export RITE_WEB_DIR="$PWD/apps/desktop/dist"

exec "$PWD/target/debug/rite-server"
