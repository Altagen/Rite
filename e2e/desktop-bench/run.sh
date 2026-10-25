#!/usr/bin/env bash
# The desktop bench: a real Rite window, in a throwaway X server, driven end to end.
#
#   sh e2e/desktop-bench/run.sh probe            what the page offers
#   sh e2e/desktop-bench/run.sh size accents     the scenarios
#
# WHY THIS EXISTS. Playwright drives Chromium, and the desktop client is WebKitGTK. The two
# engines disagree about input: a dead-key accent arrives in Chromium as one `insertText`
# and in WebKitGTK as three keydowns carrying 229, two `compositionend`s, and an
# `insertFromComposition`. A bug that lives in that gap cannot be reproduced, or prevented
# from returning, by the browser suite. This runs the actual binary and presses actual keys.
#
# Three channels observe, and none of them is a screenshot read by eye:
#   - the bytes that reach the PTY        (RITE_TRACE_INPUT=1, the client's own log)
#   - the grid xterm paints               (the page agent, by geometry not by text)
#   - the size the shell actually has     (the winsize of its tty, out of /proc)
# A screenshot is taken too, into e2e/desktop-bench/out, because some failures are visual.
#
# Another shell than the image's bash: build the fish image (Containerfile.fish) and name it
# plus the shell to pick from the toolbar. Completion is the shell's, so a scenario about it
# has to say whose it tested — `tab` prints the shell the client's own log names.
#
#   RITE_BENCH_IMAGE=localhost/rite-ime-fish4:local RITE_BENCH_PICK_SHELL=fish \
#     sh e2e/desktop-bench/run.sh tab
#
# Not part of `gate.sh`: it needs the harness image and a few minutes. Run it when touching
# terminal input or sizing.
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BENCH=$REPO/e2e/desktop-bench
IMAGE=${RITE_BENCH_IMAGE:-localhost/rite-ime:local}

[ -x "$REPO/target/release/rite" ] || {
  echo "no binary at target/release/rite" >&2
  echo "  podman run --rm -v \"\$PWD\":/workspace:Z -w /workspace rite-ci:local \\" >&2
  echo "    bash -lc 'cargo build --release -p rite-desktop'" >&2
  exit 1
}
[ -f "$REPO/apps/desktop/dist/index.html" ] || {
  echo "no frontend at apps/desktop/dist — run: pnpm --filter desktop build" >&2
  exit 1
}
podman image exists "$IMAGE" || {
  echo "no image $IMAGE — see e2e/harness-up.sh" >&2
  exit 1
}

# The agent goes into a COPY of the build. The shipped bundle never carries it, and the
# binary is not rebuilt: the server serves the frontend from disk when RITE_WEB_DIR is set.
DIST=$BENCH/.dist
rm -rf "$DIST" "$BENCH/.home"
cp -r "$REPO/apps/desktop/dist" "$DIST"
cp "$BENCH/agent.js" "$DIST/agent.js"
# Last in the body, so the application has defined its globals before it runs.
sed -i 's#</body>#<script src="/agent.js"></script></body>#' "$DIST/index.html"
grep -q 'agent.js' "$DIST/index.html" || { echo "the agent was not injected" >&2; exit 1; }
mkdir -p "$BENCH/.home" "$BENCH/out"

exec podman run --rm \
  -v "$REPO":/workspace:Z \
  -v "$DIST":/dist:Z \
  -v "$BENCH/.home":/bench:Z \
  -v "$BENCH/out":/out:Z \
  -v "$BENCH/bench.py":/bench.py:Z \
  -w /workspace \
  -e HOME=/bench \
  -e XDG_DATA_HOME=/bench/.local/share \
  -e XDG_CONFIG_HOME=/bench/.config \
  -e RITE_WEB_DIR=/dist \
  -e RITE_TRACE_INPUT=1 \
  -e RUST_LOG="${RITE_BENCH_LOG:-info}" \
  -e RITE_APP_ID=io.github.altagen.rite.bench \
  -e GTK_IM_MODULE=gtk-im-context-simple \
  -e SHELL="${RITE_BENCH_SHELL:-/usr/bin/bash}" \
  -e RITE_BENCH_PICK_SHELL="${RITE_BENCH_PICK_SHELL:-}" \
  "$IMAGE" \
  bash -lc 'mkdir -p $XDG_DATA_HOME $XDG_CONFIG_HOME && python3 -I /bench.py '"$*"
