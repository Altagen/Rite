#!/usr/bin/env sh
# Sixth harness server: a LOCAL multiplexer (ADR 0012) on :1426, paired with the
# self-signed TLS remote (:1425). The tls-proxy spec adds the https remote,
# confirms + pins its cert (TOFU, phase 4), then logs in through the TLS proxy.
set -e

export HOME="${RITE_E2E_PROXY_TLS_HOME:-/tmp/rite-e2e-proxy-tls-home}"
rm -rf "$HOME/.local/share/rite"
mkdir -p "$HOME"

export RITE_ADDR="127.0.0.1:1426"
export RITE_WEB_DIR="$PWD/apps/desktop/dist"

exec "$PWD/target/debug/rite-server"
