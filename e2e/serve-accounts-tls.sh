#!/usr/bin/env sh
# Fifth harness server: accounts mode over TLS with a self-signed cert (ADR 0012
# phase 4). The multiplexer probes this remote, gets `trusted:false` + a
# fingerprint, and pins it (TOFU) before proxying login/WS over TLS. Port 1425.
set -e

export HOME="${RITE_E2E_TLS_HOME:-/tmp/rite-e2e-tls-home}"
rm -rf "$HOME/.local/share/rite"
mkdir -p "$HOME"

export RITE_ADDR="127.0.0.1:1425"
export RITE_ACCOUNTS=1
export RITE_ADMIN_USER="envadmin"
export RITE_ADMIN_PASSWORD="EnvPass123!"
export RITE_TLS_CERT="$PWD/e2e/certs/remote.crt"
export RITE_TLS_KEY="$PWD/e2e/certs/remote.key"
export RITE_WEB_DIR="$PWD/apps/desktop/dist"

exec "$PWD/target/debug/rite-server"
