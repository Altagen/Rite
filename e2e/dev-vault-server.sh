#!/usr/bin/env sh
# Dev helper: a LOCAL-VAULT rite-server for MANUAL testing — the counterpart of
# dev-accounts-server.sh, which serves a server context. Its own throwaway HOME, so
# it can never touch ~/.local/share/rite.
#
#   sh e2e/dev-vault-server.sh          # fresh vault, master password set for you
#   sh e2e/dev-vault-server.sh --keep   # reuse the vault from the previous run
#
# Override: RITE_DEV_PORT, RITE_DEV_HOME, RITE_DEV_PASS.
#
# --keep is what makes this useful for the bug class it was written for: set a
# password, stop, start again, and check the vault still opens. A vault that only
# works while the process that created it is alive looks fine until the next launch.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${RITE_DEV_HOME:-/tmp/rite-dev-vault}"
PORT="${RITE_DEV_PORT:-1440}"
PASS="${RITE_DEV_PASS:-Bench-Vault-Str0ng!pass}"

[ -x "$ROOT/target/debug/rite-server" ] || {
  echo "build first: cargo build -p rite-server"
  exit 1
}

[ "${1:-}" = "--keep" ] || rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR/.local/share/rite"

# Free the port first. `pkill -f` matches the command line, so a marker passed in
# the environment would never match it — that mistake left the previous server
# answering while this one failed to bind, and the test then ran against the wrong
# vault without saying so.
if command -v fuser >/dev/null 2>&1; then
  fuser -k "$PORT/tcp" 2>/dev/null || true
fi
sleep 0.5

HOME="$HOME_DIR" XDG_DATA_HOME="$HOME_DIR/.local/share" XDG_CONFIG_HOME="$HOME_DIR/.config" \
  RITE_ADDR="127.0.0.1:$PORT" RITE_WEB_DIR="$ROOT/apps/desktop/dist" \
  "$ROOT/target/debug/rite-server" > "$HOME_DIR/server.log" 2>&1 &

i=0
while ! curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "server did not start; see $HOME_DIR/server.log"; exit 1; }
  sleep 0.25
done

if [ "${1:-}" != "--keep" ]; then
  curl -sf -X POST "http://127.0.0.1:$PORT/api/auth/setup" \
    -H 'content-type: application/json' -d "{\"password\":\"$PASS\"}" >/dev/null
  echo "vault created, master password set"
fi

echo "rite-server  http://127.0.0.1:$PORT"
echo "vault        $HOME_DIR/.local/share/rite/vault.db"
echo "password     $PASS"
echo "log          $HOME_DIR/server.log"
