#!/usr/bin/env sh
# Desktop multi-vault management smoke (ADR 0014). Drives the REAL wry shell's vault commands
# end to end via the RITE_TEST_IPC hook (which makes the first window post an IPC message, since
# the webview has no webdriver), and asserts the effects: new creates the .db and switches the
# window onto it WITHOUT registering (register-after-password); ready registers it; switch reloads
# the window in place and stops the old server (locking the previous vault); rename/forget/delete
# mutate the roster; forget keeps the file, delete erases it.
#
# Build in the container, run on a machine with a display:
#   podman run ... cargo build -p rite-desktop         # binary → target/debug/rite
#   (cd apps/desktop && pnpm build)                     # frontend dist
#   sh e2e/desktop-vault-smoke.sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/debug/rite"
DIST="$ROOT/apps/desktop/dist"

[ -x "$BIN" ] || { echo "FAIL: build the shell first (cargo build -p rite-desktop)"; exit 1; }
[ -f "$DIST/index.html" ] || { echo "FAIL: build the frontend first (pnpm --dir apps/desktop build)"; exit 1; }
[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || { echo "FAIL: no display — run on the desktop host"; exit 1; }

ok() { printf '  \342\234\223 %s\n' "$1"; }
die() { echo "FAIL: $1"; [ -n "${2:-}" ] && cat "$2"; exit 1; }

# Launch the shell with a vault command, against a throwaway home, for a few seconds.
# $1 = RITE_TEST_IPC json, $2 = home dir (already has .local/share/rite).
run() {
  HOME="$2" XDG_DATA_HOME="$2/.local/share" XDG_CONFIG_HOME="$2/.config" \
    RITE_WEB_DIR="$DIST" RITE_TEST_IPC="$1" \
    timeout -k 2 6 "$BIN" >"$2/app.log" 2>&1 || true
}

# --- new: creates the .db and switches THIS window onto it, but does NOT register it yet
#     (register-after-password, ADR 0014) — the roster keeps only the seeded default vault. ---
H="$(mktemp -d /tmp/rite-vault-smoke.XXXXXX)"; mkdir -p "$H/.local/share/rite"
NEW="$H/.local/share/rite/beta.db"
run "{\"type\":\"vault-new\",\"path\":\"$NEW\"}" "$H"
ROSTER="$H/.local/share/rite/vaults.json"
[ -f "$NEW" ] || die "new: vault file not created"
grep -q 'beta' "$ROSTER" && die "new: beta registered before its master password (should not be)" "$ROSTER"
# One window, switched in place: the launch server + the switch-target server both bind.
[ "$(grep -c 'window serving on' "$H/app.log")" -ge 2 ] || die "new: window did not switch onto the vault" "$H/app.log"
ok "new → .db created + window switched onto it, NOT yet in the roster"
rm -rf "$H"

# --- ready: the frontend registers a new vault once its master password is set ---
H="$(mktemp -d /tmp/rite-vault-smoke.XXXXXX)"; mkdir -p "$H/.local/share/rite"
run "{\"type\":\"vault-ready\",\"path\":\"/vaults/beta.db\",\"label\":\"Client Beta\"}" "$H"
grep -q '"label": "Client Beta"' "$H/.local/share/rite/vaults.json" || die "ready: vault not registered" "$H/.local/share/rite/vaults.json"
ok "ready → vault registered after its password is set"
rm -rf "$H"

# --- switch: switch-context reloads THIS window onto another vault (one window = one vault);
#     the previous server stops (so the previous vault locks) — the old loopback port is freed. ---
H="$(mktemp -d /tmp/rite-vault-smoke.XXXXXX)"; mkdir -p "$H/.local/share/rite"
TARGET="$H/.local/share/rite/other.db"
HOME="$H" XDG_DATA_HOME="$H/.local/share" XDG_CONFIG_HOME="$H/.config" RITE_WEB_DIR="$DIST" \
  RITE_TEST_IPC="{\"type\":\"switch-context\",\"kind\":\"local\",\"path\":\"$TARGET\"}" RUST_LOG=info "$BIN" >"$H/app.log" 2>&1 &
SW_PID=$!
i=0; while [ "$(grep -c 'window serving on' "$H/app.log" 2>/dev/null)" -lt 2 ]; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { kill "$SW_PID" 2>/dev/null; die "switch: window never switched" "$H/app.log"; }; sleep 0.1
done
sleep 0.4
OLD="$(grep -oE '127.0.0.1:[0-9]+' "$H/app.log" | head -1)"
NEW_PORT="$(grep -oE '127.0.0.1:[0-9]+' "$H/app.log" | tail -1)"
[ -f "$TARGET" ] || { kill "$SW_PID" 2>/dev/null; die "switch: target vault not opened"; }
curl -s -o /dev/null --max-time 2 "http://$OLD/" && { kill "$SW_PID" 2>/dev/null; die "switch: old server still up (previous vault not locked)"; }
[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://$NEW_PORT/")" = "200" ] || { kill "$SW_PID" 2>/dev/null; die "switch: new server not serving"; }
kill "$SW_PID" 2>/dev/null
ok "switch → same window, old server stopped (vault locked), new server serving"
rm -rf "$H"

# --- rename: relabels the seeded default vault in the roster ---
H="$(mktemp -d /tmp/rite-vault-smoke.XXXXXX)"; mkdir -p "$H/.local/share/rite"
VD="$H/.local/share/rite/vault.db"
run "{\"type\":\"vault-rename\",\"path\":\"$VD\",\"label\":\"Renamed!\"}" "$H"
grep -q '"label": "Renamed!"' "$H/.local/share/rite/vaults.json" || die "rename: label not updated" "$H/.local/share/rite/vaults.json"
ok "rename → roster label updated"
rm -rf "$H"

# --- forget: drops from the roster but keeps the .db file ---
H="$(mktemp -d /tmp/rite-vault-smoke.XXXXXX)"; mkdir -p "$H/.local/share/rite"
VD="$H/.local/share/rite/vault.db"
run "{\"type\":\"vault-forget\",\"path\":\"$VD\"}" "$H"
grep -q '\[\]' "$H/.local/share/rite/vaults.json" || die "forget: roster not emptied" "$H/.local/share/rite/vaults.json"
[ -f "$VD" ] || die "forget: vault file was deleted (should be kept)"
ok "forget → roster emptied, .db file kept"
rm -rf "$H"

# --- delete: drops from the roster AND erases the .db file (irreversible opt-in) ---
H="$(mktemp -d /tmp/rite-vault-smoke.XXXXXX)"; mkdir -p "$H/.local/share/rite"
VD="$H/.local/share/rite/vault.db"
run "{\"type\":\"vault-delete\",\"path\":\"$VD\"}" "$H"
grep -q '\[\]' "$H/.local/share/rite/vaults.json" || die "delete: roster not emptied" "$H/.local/share/rite/vaults.json"
[ ! -f "$VD" ] || die "delete: vault file still on disk (should be erased)"
ok "delete → roster emptied, .db file erased"
rm -rf "$H"

# --- set-icon: stores the chosen emoji on the roster entry ---
H="$(mktemp -d /tmp/rite-vault-smoke.XXXXXX)"; mkdir -p "$H/.local/share/rite"
VD="$H/.local/share/rite/vault.db"
run "{\"type\":\"vault-set-icon\",\"path\":\"$VD\",\"icon\":\"🚀\"}" "$H"
grep -q '"icon"' "$H/.local/share/rite/vaults.json" || die "set-icon: emoji not stored" "$H/.local/share/rite/vaults.json"
ok "set-icon → emoji stored on the roster entry"
rm -rf "$H"

printf '\n\342\234\205 desktop-vault-smoke passed\n'
