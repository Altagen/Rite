#!/usr/bin/env sh
# The bench for `rite --install` (ADR 0030) — the real binary, a throwaway prefix.
#
#   sh e2e/install-smoke.sh                      # a temporary prefix, removed at the end
#   RITE_PREFIX=/opt/rite sh e2e/install-smoke.sh  # a prefix you name, left in place
#   RITE_BIN=~/.local/bin/rite sh e2e/install-smoke.sh   # a binary you name
#
# It never writes under ~/.local. That is the point of --prefix, and this script is what
# holds it true: the unit tests in install.rs call the same functions, but only the binary
# can prove that the command-line flag reaches them.
#
# What it cannot prove: that a desktop shows the entry. A launcher reads $XDG_DATA_HOME and
# XDG_DATA_DIRS, so an entry under a throwaway prefix is correct and invisible. Seeing the
# icon appear needs `rite --install` with no prefix, and a session.
set -e

BIN=${RITE_BIN:-target/release/rite}
APP_ID=io.github.altagen.rite
SIZES="512 256 128 64 48 32 24 16"

if [ ! -x "$BIN" ]; then
  echo "no binary at $BIN" >&2
  echo "  podman run --rm -v \"\$PWD\":/workspace:Z -w /workspace rite-ci:local \\" >&2
  echo "    bash -lc 'cargo build --release -p rite-desktop'" >&2
  exit 1
fi

KEEP=1
if [ -z "$RITE_PREFIX" ]; then
  RITE_PREFIX=$(mktemp -d /tmp/rite-install-bench.XXXXXX)
  KEEP=0
fi
PREFIX=$RITE_PREFIX
ENTRY="$PREFIX/share/applications/$APP_ID.desktop"

cleanup() { [ "$KEEP" = 0 ] && rm -rf "$PREFIX"; }
trap cleanup EXIT

fail=0
ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✘ $1"; fail=1; }
is()   { [ "$2" = "$3" ] && ok "$1" || bad "$1 (got '$2', want '$3')"; }

echo "— prefix: $PREFIX"
echo "— binary: $BIN"
echo

echo "install"
"$BIN" --install --prefix "$PREFIX" | sed 's/^/    /'

[ -x "$PREFIX/bin/rite" ] && ok "the binary is installed, and executable" \
                          || bad "no executable at $PREFIX/bin/rite"
[ -f "$ENTRY" ] && ok "the launcher entry is written" || bad "no entry at $ENTRY"

# Exec must name the INSTALLED copy. Pointing at the unpacked tarball is the bug that
# makes an entry stop working the moment a download directory is cleaned out.
if [ -f "$ENTRY" ]; then
  exec_line=$(sed -n 's/^Exec=//p' "$ENTRY")
  is "Exec names the installed binary" "$exec_line" "$PREFIX/bin/rite"
  is "Icon names the app id" "$(sed -n 's/^Icon=//p' "$ENTRY")" "$APP_ID"
  is "Terminal is false" "$(sed -n 's/^Terminal=//p' "$ENTRY")" "false"
  is "StartupWMClass names the app id" "$(sed -n 's/^StartupWMClass=//p' "$ENTRY")" "$APP_ID"
fi

# Optional, and genuinely useful: the freedesktop validator reads the spec we are writing
# to. Absent, the checks above still ran — a tool that may not be there cannot gate this.
if command -v desktop-file-validate >/dev/null 2>&1; then
  if desktop-file-validate "$ENTRY" 2>&1 | sed 's/^/      /'; then
    ok "desktop-file-validate accepts the entry"
  else
    bad "desktop-file-validate rejects the entry"
  fi
else
  echo "  – desktop-file-validate absent, skipped"
fi

# Each icon at the size its directory claims. Read with node, which this repository pins,
# rather than ImageMagick, which it does not require.
for s in $SIZES; do
  p="$PREFIX/share/icons/hicolor/${s}x${s}/apps/$APP_ID.png"
  if [ ! -f "$p" ]; then bad "icon ${s}x${s} missing"; continue; fi
  got=$(node -e '
    const fs = require("fs");
    const b = fs.readFileSync(process.argv[1]);
    if (b.toString("ascii", 1, 4) !== "PNG") { console.log("not-a-png"); process.exit(0); }
    console.log(`${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`);
  ' "$p")
  is "icon ${s}x${s} is a PNG of that size" "$got" "${s}x${s}"
done

# Nothing outside the four paths: an installer that scatters is one nobody can undo.
strays=$(find "$PREFIX" -type f \
  ! -path "$PREFIX/bin/rite" \
  ! -path "$ENTRY" \
  ! -name "$APP_ID.png" | head -5)
[ -z "$strays" ] && ok "nothing written outside the four paths" \
                 || bad "unexpected files: $(echo "$strays" | tr '\n' ' ')"

echo
echo "uninstall"
"$BIN" --uninstall --prefix "$PREFIX" | sed 's/^/    /'

[ ! -e "$PREFIX/bin/rite" ] && ok "the binary is gone" || bad "the binary survived"
[ ! -e "$ENTRY" ] && ok "the entry is gone" || bad "the entry survived"
left=0
for s in $SIZES; do
  [ -e "$PREFIX/share/icons/hicolor/${s}x${s}/apps/$APP_ID.png" ] && left=$((left + 1))
done
is "every icon is gone" "$left" "0"

# ── the script, which is the path most people take ───────────────────────────────
# The binary above placed its own files. Here the helper decides the paths and places
# bytes the binary emits (ADR 0030 §1), so this is where the emitters are exercised.
SCRIPT=scripts/install.sh
echo
echo "the installer script"

# --help must work when the script is piped: `$0` is then `sh`, and reading its own file
# was how this was written first — broken in the one mode where the reader has no copy.
if cat "$SCRIPT" | sh -s -- --help 2>/dev/null | grep -q "Install Rite's desktop client"; then
  ok "--help works when the script is piped"
else
  bad "--help prints nothing when piped"
fi

# A relative prefix must still produce an absolute Exec=, or the entry launches nothing.
rel=$(mktemp -d /tmp/rite-script-bench.XXXXXX)
( cd "$rel" && sh "$OLDPWD/$SCRIPT" --bin "$OLDPWD/$BIN" --prefix relative >/dev/null 2>&1 )
rel_entry="$rel/relative/share/applications/$APP_ID.desktop"
if [ -f "$rel_entry" ]; then
  is "a relative prefix yields an absolute Exec" \
    "$(sed -n 's/^Exec=//p' "$rel_entry")" "$rel/relative/bin/rite"
else
  bad "the script wrote no entry under a relative prefix"
fi

# The same four paths, placed by the script this time.
sh "$SCRIPT" --bin "$BIN" --prefix "$rel/named" >/dev/null 2>&1
for p in "$rel/named/bin/rite" "$rel/named/share/applications/$APP_ID.desktop"; do
  [ -f "$p" ] && ok "the script placed ${p##*/}" || bad "the script did not place $p"
done
icons=$(find "$rel/named/share/icons" -name "$APP_ID.png" | wc -l | tr -d ' ')
is "the script placed every icon" "$icons" "8"

sh "$SCRIPT" --uninstall --prefix "$rel/named" >/dev/null 2>&1
left=$(find "$rel/named" -type f 2>/dev/null | wc -l | tr -d ' ')
is "the script's uninstall leaves nothing" "$left" "0"
rm -rf "$rel"

echo
if [ "$fail" = 0 ]; then
  echo "✅ install and uninstall hold, from the binary and from the script"
  [ "$KEEP" = 1 ] && echo "   ($PREFIX kept — it was named, not invented)"
else
  echo "❌ the install does not hold"
fi
exit "$fail"
