#!/usr/bin/env sh
# Fourth harness server: a LOCAL multiplexer (ADR 0012) on :1424. The proxy spec
# adds the remote accounts server (:1423) to its roster, switches to it, and logs
# in — proving /api/* is reverse-proxied to the remote through this local server.
set -e

export HOME="${RITE_E2E_PROXY_HOME:-/tmp/rite-e2e-proxy-home}"
rm -rf "$HOME/.local/share/rite"
mkdir -p "$HOME"

export RITE_ADDR="127.0.0.1:1424"
export RITE_WEB_DIR="$PWD/apps/desktop/dist"

exec "$PWD/target/debug/rite-server"
