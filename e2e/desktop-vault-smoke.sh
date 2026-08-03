#!/usr/bin/env sh
# Desktop multi-vault management smoke (ADR 0014). Drives the REAL wry shell's vault commands
# end to end via the RITE_TEST_IPC hook (which makes the first window post an IPC message, since
# the webview has no webdriver), and asserts the on-disk effects: new creates a vault + roster
# entry + a second window; rename relabels the roster; forget drops it but KEEPS the file.
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

# --- new: creates a vault, adds it to the roster, opens a second window ---
H="$(mktemp -d /tmp/rite-vault-smoke.XXXXXX)"; mkdir -p "$H/.local/share/rite"
NEW="$H/.local/share/rite/beta.db"
run "{\"type\":\"vault-new\",\"path\":\"$NEW\"}" "$H"
ROSTER="$H/.local/share/rite/vaults.json"
grep -q '"label": "beta"' "$ROSTER" || die "new: roster missing beta" "$ROSTER"
[ -f "$NEW" ] || die "new: vault file not created"
[ "$(grep -c 'window serving on' "$H/app.log")" -ge 2 ] || die "new: second window not opened" "$H/app.log"
ok "new → roster entry + .db created + second window"
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

# --- set-icon: stores the chosen emoji on the roster entry ---
H="$(mktemp -d /tmp/rite-vault-smoke.XXXXXX)"; mkdir -p "$H/.local/share/rite"
VD="$H/.local/share/rite/vault.db"
run "{\"type\":\"vault-set-icon\",\"path\":\"$VD\",\"icon\":\"🚀\"}" "$H"
grep -q '"icon"' "$H/.local/share/rite/vaults.json" || die "set-icon: emoji not stored" "$H/.local/share/rite/vaults.json"
ok "set-icon → emoji stored on the roster entry"
rm -rf "$H"

printf '\n\342\234\205 desktop-vault-smoke passed\n'
