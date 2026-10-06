#!/usr/bin/env sh
# The whole local end-to-end gate, in the order that makes it meaningful.
#
#   sh e2e/gate.sh
#
# Four steps, and the first one is not politeness. Playwright serves
# `apps/desktop/dist` and the standalone checks drive `target/debug/rite-server`;
# neither suite builds anything. A stale artefact tests the previous commit and
# reports "passed", which is worse than reporting nothing — it has happened in this
# repo, twice in one afternoon.
#
# Subsets, when you know what you are doing:
#   sh e2e/harness-up.sh                      # the SSH harness alone (container)
#   sh e2e/run-checks.sh                      # crypto parity + server policy checks
#   npx playwright test --project=mock        # the UX mock, no server
#   npx playwright test --project=chromium    # the local-vault suite
set -e

say() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

say "1/4  build what the gates run against"
pnpm --filter desktop build:frontend
if command -v cargo >/dev/null 2>&1; then
  cargo build -p rite-server
else
  # No host toolchain: build in the same image CI mirrors, so the binary matches
  # what the checks expect without installing Rust on this machine.
  echo "[gate] no local cargo — building rite-server in rite-ci:local"
  podman run --rm -v "$PWD":/workspace:Z -w /workspace rite-ci:local \
    bash -lc 'cargo build -p rite-server'
fi

say "2/4  SSH harness (container — nothing lands on this machine)"
sh e2e/harness-up.sh

say "3/4  standalone checks (crypto parity, server policies)"
sh e2e/run-checks.sh

say "4/4  Playwright (mock, local vault, accounts, proxy, TLS proxy)"
pnpm e2e

say "gate passed"
