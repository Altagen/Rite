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
#   sh e2e/turnkey-acceptance.sh              # the ADR 0020 criterion alone
#
# RITE_SKIP_ACCEPTANCE=1 drops the last step for a tight edit-test loop; it costs the
# slowest minutes here, and nothing else depends on it.
#
# RITE_SKIP_NODE_CHECK=1 runs anyway on a Node that does not match .node-version.
# The gate then validates a frontend built by a different Node than CI builds, so
# this is for getting work done before installing the pinned version, not a setting
# to keep.
set -e

say() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

# Node has to match .node-version before anything else runs.
#
# Rust needs no equivalent: rustup reads rust-toolchain.toml wherever cargo is
# invoked, so the pin binds itself. .node-version binds nothing on its own — it
# needs a version manager configured to read it — so a pin that nobody enforces is
# not a pin, and the failure it causes does not look like a version problem.
#
# What it looks like instead: the container mounts this repository, so host and
# container share node_modules but not the Node version. A pnpm command run under
# the other Node rebuilds the tree, and the next pnpm on this side decides to purge
# it and refuses without a TTY — ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, at
# step 1, reading as if the change under test broke the build.
want="$(tr -d '[:space:]' < .node-version)"
have="$(node --version 2>/dev/null | sed 's/^v//')"
if [ "$want" != "$have" ] && [ "${RITE_SKIP_NODE_CHECK:-0}" != "1" ]; then
  printf '\n\033[1;31m── node %s, but .node-version pins %s\033[0m\n' "${have:-<none>}" "$want" >&2
  echo "The gate runs pnpm on the host; a mismatch here breaks it at step 1 with a" >&2
  echo "pnpm purge error that looks like a build failure." >&2
  if command -v fnm >/dev/null 2>&1; then
    echo >&2
    echo "  fnm use            # reads .node-version in this directory" >&2
    echo "  fnm env --use-on-cd  # add to your shell config so it is automatic" >&2
  elif command -v nvm >/dev/null 2>&1; then
    echo >&2; echo "  nvm use" >&2
  else
    echo >&2; echo "Install a version manager that reads .node-version (fnm, nvm, asdf)." >&2
  fi
  echo >&2
  echo "RITE_SKIP_NODE_CHECK=1 runs anyway — the gate then tests a frontend built by" >&2
  echo "a different Node than CI builds, which is a trade, not a fix." >&2
  exit 1
fi
if [ "$want" != "$have" ]; then
  printf '\n\033[1;33m── node %s, pin is %s — running anyway (RITE_SKIP_NODE_CHECK=1)\033[0m\n' \
    "${have:-<none>}" "$want"
fi

say "1/5  build what the gates run against"
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

say "2/5  SSH harness (container — nothing lands on this machine)"
sh e2e/harness-up.sh

say "3/5  standalone checks (crypto parity, server policies)"
sh e2e/run-checks.sh

say "4/5  Playwright (mock, local vault, accounts, proxy, TLS proxy)"
pnpm e2e

# ADR 0020's acceptance criterion. It builds an image and starts a container, so it is
# the slowest step here — two to six minutes depending on what the layer cache holds.
# Default on all the same: a check nobody runs is a check that rots, and this one is the
# only thing standing between "the headless promise works" and "it used to".
if [ "${RITE_SKIP_ACCEPTANCE:-}" = "1" ]; then
  say "5/5  turnkey acceptance — SKIPPED (RITE_SKIP_ACCEPTANCE=1)"
else
  say "5/5  turnkey acceptance (configured instance, no browser)"
  sh e2e/turnkey-acceptance.sh
fi

say "gate passed"
