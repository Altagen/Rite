#!/usr/bin/env sh
# Third harness server: accounts mode with a NON-INTERACTIVE env admin bootstrap
# (ADR 0010). Proves the server-side Argon2id derivation matches the browser's
# hash-wasm — a browser login with these creds must verify. Port 1423.
set -e

export HOME="${RITE_E2E_ENV_HOME:-/tmp/rite-e2e-env-home}"
rm -rf "$HOME/.local/share/rite"
mkdir -p "$HOME"

export RITE_ADDR="127.0.0.1:1423"
export RITE_ACCOUNTS=1
export RITE_ADMIN_USER="envadmin"
export RITE_ADMIN_PASSWORD="EnvPass123!"
export RITE_WEB_DIR="$PWD/apps/desktop/dist"

exec "$PWD/target/debug/rite-server"
