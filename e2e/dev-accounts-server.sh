#!/usr/bin/env sh
# Dev helper: a LOCAL Rite accounts server (ADR 0010) for MANUAL end-to-end testing with the
# graphical desktop client. Loopback + plaintext HTTP is allowed for accounts (127.0.0.1), so no
# TLS needed. An admin is created from the env on first run; the DB PERSISTS across restarts under
# $HOME below (delete it to start fresh).
#
#   sh e2e/dev-accounts-server.sh            # → http://127.0.0.1:1422, admin / ChangeMe-Admin1!
# Override: RITE_DEV_PORT, RITE_DEV_ADMIN, RITE_DEV_ADMIN_PW, RITE_DEV_HOME.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export HOME="${RITE_DEV_HOME:-/tmp/rite-dev-server}"
mkdir -p "$HOME/.local/share/rite"
export RITE_ADDR="127.0.0.1:${RITE_DEV_PORT:-1422}"
export RITE_ACCOUNTS=1
export RITE_ADMIN_USER="${RITE_DEV_ADMIN:-admin}"
export RITE_ADMIN_PASSWORD="${RITE_DEV_ADMIN_PW:-ChangeMe-Admin1!}"   # >= 12 chars (strength gate)
export RITE_WEB_DIR="$ROOT/apps/desktop/dist"

[ -x "$ROOT/target/debug/rite-server" ] || { echo "build first: cargo build -p rite-server"; exit 1; }
echo "Rite dev accounts server"
echo "  URL:   http://$RITE_ADDR"
echo "  admin: $RITE_ADMIN_USER / $RITE_ADMIN_PASSWORD"
echo "  data:  $HOME/.local/share/rite   (persists; rm -rf to reset)"
echo "In the desktop client: pill → 'Add a server…' → http://$RITE_ADDR → sign in with the above."
echo
exec "$ROOT/target/debug/rite-server"
