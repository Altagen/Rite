#!/usr/bin/env sh
# Desktop-shell boot smoke (ADR 0014). Launches the REAL wry shell against a throwaway
# data dir and the freshly-built frontend, then asserts — over the shell's own loopback
# server — that it booted a window+server, seeded the multi-vault roster, serves the live
# frontend, and enforces the ADR 0009 token guard. Then it kills the app.
#
# The wry webview can't be driven headless (no webdriver), so this verifies everything up
# to and including "the shell serves the right frontend" — the integration seam unit tests
# can't reach. Requires a display (host, not the CI container) + a pre-built binary and dist:
#   podman run ... cargo build -p rite-desktop      # build the binary (needs cargo)
#   (cd apps/desktop && pnpm build)                 # build the frontend dist
#   sh e2e/desktop-boot-smoke.sh                     # run on a machine with a display
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/debug/rite"
DIST="$ROOT/apps/desktop/dist"
HOME_DIR="$(mktemp -d /tmp/rite-desktop-smoke.XXXXXX)"
LOG="$HOME_DIR/app.log"

[ -x "$BIN" ] || { echo "FAIL: build the shell first (cargo build -p rite-desktop)"; exit 1; }
[ -f "$DIST/index.html" ] || { echo "FAIL: build the frontend first (pnpm --dir apps/desktop build)"; exit 1; }
[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || { echo "FAIL: no display — run on the desktop host, not the CI container"; exit 1; }

cleanup() { kill "$APP_PID" 2>/dev/null || true; rm -rf "$HOME_DIR"; }
trap cleanup EXIT

HOME="$HOME_DIR" XDG_DATA_HOME="$HOME_DIR/.local/share" XDG_CONFIG_HOME="$HOME_DIR/.config" \
  RITE_WEB_DIR="$DIST" RUST_LOG=info "$BIN" >"$LOG" 2>&1 &
APP_PID=$!

# Wait (up to ~10s) for the window's server to bind — a fresh vault runs all migrations first.
i=0
while ! grep -qE "window serving on" "$LOG" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 100 ] && { echo "FAIL: shell never bound a server"; tail -5 "$LOG"; exit 1; }
  sleep 0.1
done
PORT="$(grep -oE '127.0.0.1:[0-9]+' "$LOG" | head -1 | cut -d: -f2)"
ok() { printf '  \342\234\223 %s\n' "$1"; }

# 1) The default vault is NOT pre-registered on a fresh boot (register-after-password, ADR 0014):
#    the roster only gains it once its master password is set, so a fresh install has no vault.
ROSTER="$HOME_DIR/.local/share/rite/vaults.json"
grep -q '"label"' "$ROSTER" 2>/dev/null && { echo "FAIL: roster pre-seeded a vault before setup"; cat "$ROSTER"; exit 1; }
ok "no vault pre-registered before its master password (fresh install)"

# 2) The loopback server serves the live frontend (not the embedded "frontend not built").
INDEX="$(curl -s "http://127.0.0.1:$PORT/")"
printf '%s' "$INDEX" | grep -q "<title>RITE</title>" || { echo "FAIL: frontend not served"; printf '%s' "$INDEX" | head -c 200; exit 1; }
BUNDLE="$(printf '%s' "$INDEX" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1)"
curl -s "http://127.0.0.1:$PORT/$BUNDLE" | grep -q "__RITE_VAULTS__" || { echo "FAIL: served bundle lacks the multi-vault hub code"; exit 1; }
ok "serves the live frontend incl. the multi-vault hub ($BUNDLE)"

# 3) The ADR 0009 loopback token guard rejects /api without a token.
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/server/mode")"
[ "$CODE" = "401" ] || { echo "FAIL: /api not token-guarded (got $CODE)"; exit 1; }
ok "loopback token guard enforced (/api → 401 without a token)"

echo "\n\342\234\205 desktop-boot-smoke passed"
