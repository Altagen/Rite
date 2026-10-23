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
# Generated on first use, never committed — the same rule `e2e/sshd-setup.sh` follows
# for its SSH keys, and for the same reason: a private key in a public repository is a
# finding whatever it opens. This one opens a self-signed localhost listener, which is
# nothing, but it was committed while the file next door generated its own.
#
# Regenerating is free here: the suite pins this cert by TOFU, reading the fingerprint
# off the probe at run time rather than expecting a known one.
CERTS="$PWD/e2e/certs"
mkdir -p "$CERTS"
if [ ! -f "$CERTS/remote.key" ] || [ ! -f "$CERTS/remote.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' \
    -keyout "$CERTS/remote.key" -out "$CERTS/remote.crt" >/dev/null 2>&1
  echo "[tls] generated a self-signed cert for 127.0.0.1 in e2e/certs"
fi

export RITE_TLS_CERT="$CERTS/remote.crt"
export RITE_TLS_KEY="$CERTS/remote.key"
export RITE_WEB_DIR="$PWD/apps/desktop/dist"

exec "$PWD/target/debug/rite-server"
