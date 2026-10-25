#!/usr/bin/env sh
# Install Rite's desktop client (ADR 0030).
#
#   sh scripts/install.sh                      # latest release, into ~/.local
#   sh scripts/install.sh --prefix /usr/local  # somewhere else (DIR/bin, DIR/share)
#   sh scripts/install.sh --bin ./rite         # a binary you already have
#   sh scripts/install.sh --version 0.2.4      # a release you name
#   sh scripts/install.sh --uninstall          # remove what this wrote
#
# Reading it before running it is the point, so it is short. It can be piped —
# `curl -fsSL <raw-url> | sh -s -- --prefix /opt/rite` works, nothing here reads stdin —
# but the documented form downloads it first, because a product whose premise is that a
# server is not trusted with a secret should not ask anyone to execute an unread script.
#
# WHY A SCRIPT AND NOT THE BINARY. The binary owns what only it can know: the app-id a
# Wayland compositor matches on, the entry's text, and the icon bytes. It emits them
# (`--print-app-id`, `--print-desktop-entry`, `--print-icon`) and writes nothing. Where
# those bytes go is policy, and policy belongs here — so changing it never needs a new
# binary. The script never spells the app-id itself: it asks.
set -e

REPO=Altagen/Rite
PREFIX=""
VERSION=""
LOCAL_BIN=""
MODE=install

# Held here and not read back out of the file: piped through `sh`, this script has no
# path to read — `$0` is `sh` — and --help is most needed exactly then.
usage() {
  cat <<'USAGE'
Install Rite's desktop client.

  install.sh                    latest release, into ~/.local
  install.sh --prefix DIR       under DIR/bin and DIR/share instead
  install.sh --version TAG      a release you name
  install.sh --bin PATH         a binary you already have
  install.sh --uninstall        remove what this wrote; the vault is untouched

A launcher reads XDG_DATA_HOME and XDG_DATA_DIRS only, so --prefix outside them
writes a correct entry that no menu will show. --prefix /usr/local is in them.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX=${2:?--prefix needs a directory}; shift 2 ;;
    --version) VERSION=${2:?--version needs a release tag}; shift 2 ;;
    --bin) LOCAL_BIN=${2:?--bin needs a path}; shift 2 ;;
    --uninstall) MODE=uninstall; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# The two roots. FHS under a prefix, XDG otherwise — and XDG means the variables, not a
# guess at what they usually hold.
if [ -n "$PREFIX" ]; then
  # Absolute, or `Exec=` ends up relative and the entry launches nothing. The directory
  # may not exist yet, so this resolves it by hand rather than with `realpath -e`.
  case "$PREFIX" in
    /*) ;;
    *) PREFIX="$(pwd)/$PREFIX" ;;
  esac
  BIN_DIR="$PREFIX/bin"
  DATA_DIR="$PREFIX/share"
  XDG=0
else
  BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
  DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
  XDG=1
fi
TARGET="$BIN_DIR/rite"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "$1 is required and was not found" >&2; exit 1; }
}

# ── uninstall ────────────────────────────────────────────────────────────────────
# The binary is asked for the app-id and the sizes BEFORE it is removed: it is the only
# thing that knows them, and a script that hardcoded them could delete the wrong files.
if [ "$MODE" = uninstall ]; then
  if [ ! -x "$TARGET" ]; then
    echo "no binary at $TARGET — nothing to ask for the app-id" >&2
    exit 1
  fi
  app_id=$("$TARGET" --print-app-id)
  sizes=$("$TARGET" --print-icon-sizes)

  rm -f "$DATA_DIR/applications/$app_id.desktop"
  echo "removed    $DATA_DIR/applications/$app_id.desktop"
  for s in $sizes; do
    rm -f "$DATA_DIR/icons/hicolor/${s}x${s}/apps/$app_id.png"
  done
  echo "removed    $(echo "$sizes" | wc -w | tr -d ' ') icons"
  rm -f "$TARGET"
  echo "removed    $TARGET"
  echo
  echo "The vault is untouched: ${XDG_DATA_HOME:-$HOME/.local/share}/rite"
  exit 0
fi

# ── acquire ──────────────────────────────────────────────────────────────────────
if [ -n "$LOCAL_BIN" ]; then
  [ -x "$LOCAL_BIN" ] || { echo "$LOCAL_BIN is not executable" >&2; exit 1; }
  SOURCE=$LOCAL_BIN
else
  need curl
  need tar

  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=macos ;;
    *) echo "unsupported system: $(uname -s)" >&2; exit 1 ;;
  esac
  # 4. sha256sum is coreutils; macOS ships shasum. Resolved once, used once.
  if command -v sha256sum >/dev/null 2>&1; then
    SHA="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    SHA="shasum -a 256"
  else
    echo "neither sha256sum nor shasum was found; cannot verify the download" >&2
    exit 1
  fi
  case "$(uname -m)" in
    x86_64|amd64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  if [ -z "$VERSION" ]; then
    # `releases/latest` redirects to `releases/tag/<tag>`, so the final URL carries the
    # answer. No JSON parser, and no API: an unauthenticated API call is rate limited to
    # sixty an hour per address, and the failure says nothing about why.
    VERSION=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
      "https://github.com/$REPO/releases/latest" | sed -n 's|.*/tag/||p')
    [ -n "$VERSION" ] || { echo "could not resolve the latest release" >&2; exit 1; }
  fi

  work=$(mktemp -d "${TMPDIR:-/tmp}/rite-install.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  base="https://github.com/$REPO/releases/download/$VERSION"
  tarball="rite-$VERSION-$os-$arch.tar.gz"

  echo "— $VERSION, $os-$arch"
  curl -fsSL -o "$work/$tarball" "$base/$tarball"
  curl -fsSL -o "$work/checksums.txt" "$base/rite-$VERSION-checksums.txt"

  # --ignore-missing is what makes the file usable: it lists every platform's tarball and
  # only one was downloaded. Without it the three absent ones count as failures.
  ( cd "$work" && $SHA -c --ignore-missing checksums.txt >/dev/null ) \
    || { echo "checksum verification failed" >&2; exit 1; }
  echo "verified   $tarball"

  tar -xzf "$work/$tarball" -C "$work"
  SOURCE="$work/rite"
fi

# ── place ────────────────────────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
# Not `cp` onto a running binary: install(1) replaces the inode, so a Rite that is open
# keeps running on the old one instead of having its executable rewritten underneath it.
install -m755 "$SOURCE" "$TARGET"
echo "installed  $TARGET"

# A `.desktop` file and a hicolor theme are freedesktop, so on macOS the binary is the
# whole install — a .app bundle is a different piece of work (ADR 0030 scope).
if [ "$(uname -s)" != Linux ]; then
  echo
  echo "Desktop integration is Linux only: no launcher entry or icons were written."
  exit 0
fi

# From here on the INSTALLED copy answers, so what is placed comes from the binary that
# will actually run.
app_id=$("$TARGET" --print-app-id)

mkdir -p "$DATA_DIR/applications"
"$TARGET" --print-desktop-entry "$TARGET" > "$DATA_DIR/applications/$app_id.desktop"
echo "installed  $DATA_DIR/applications/$app_id.desktop"

count=0
for s in $("$TARGET" --print-icon-sizes); do
  dir="$DATA_DIR/icons/hicolor/${s}x${s}/apps"
  mkdir -p "$dir"
  "$TARGET" --print-icon "$s" > "$dir/$app_id.png"
  count=$((count + 1))
done
echo "installed  $count icons under $DATA_DIR/icons/hicolor"

# Only where a desktop reads. Under a prefix these helpers would create caches nobody
# consults, and an uninstall would leave them behind — the bench caught exactly that.
if [ "$XDG" = 1 ]; then
  command -v update-desktop-database >/dev/null 2>&1 \
    && update-desktop-database "$DATA_DIR/applications" 2>/dev/null \
    && echo "refreshed  update-desktop-database" || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 \
    && gtk-update-icon-cache --quiet --ignore-theme-index "$DATA_DIR/icons/hicolor" 2>/dev/null \
    && echo "refreshed  gtk-update-icon-cache" || true
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "$BIN_DIR is not on PATH. Add:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

if [ "$XDG" = 0 ]; then
  echo
  echo "A launcher reads XDG_DATA_HOME and XDG_DATA_DIRS. $DATA_DIR is in neither,"
  echo "so the entry is written and will not appear in a menu."
fi
