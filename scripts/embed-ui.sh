#!/usr/bin/env sh
# The built frontend into the folder `rust-embed` reads at compile time (ADR 0004).
#
# A REPLACEMENT, not an addition. `cp -r dist/. web/` never deletes, and every bundle
# carries a content hash in its filename, so a working tree that has built the frontend a
# few dozen times keeps every bundle it ever made. Measured on the machine this was written
# on: 106 asset files and 63 MB, where the live bundle is 7 files and 2.5 MB. `index.html`
# names the current one, so the app works and nothing says anything — the binary just
# carries sixty megabytes of dead JavaScript, and a locally built release stops weighing
# what CI's weighs.
#
# CI never saw it. The folder is gitignored, so a release checkout starts empty, and the
# server image excludes it from the build context (`.containerignore`). This is the local
# build's problem alone, which is also why it went unnoticed for so long.
#
# `.gitkeep` is tracked, because the folder has to exist before anything fills it or
# rust-embed fails to compile. It is the one thing kept.
#
# One script and not four copies of three lines: `Taskfile.yaml`, `e2e/gate.sh` and
# `.github/workflows/release.yml` all call it, and `e2e/embedded-ui-check.mjs` holds the
# result.
set -e

cd "$(dirname "$0")/.."

test -d apps/desktop/dist || {
  echo "embed-ui: apps/desktop/dist is absent — run \`pnpm --filter desktop build:frontend\`" >&2
  exit 1
}

mkdir -p packages/rite-server/web
find packages/rite-server/web -mindepth 1 ! -name .gitkeep -exec rm -rf {} +
cp -r apps/desktop/dist/. packages/rite-server/web/
