#!/usr/bin/env sh
# The dependency security audit, Rust and JavaScript, as one answer.
#
#   sh scripts/audit.sh
#
# WHY THIS IS A SCRIPT AND NOT TWO LINES IN THE TASKFILE. `cargo audit` runs three
# checks — advisories, unmaintained crates, and whether a locked version has been
# yanked from crates.io — and until 2026-10-28 the third one had never run on this
# machine. It failed once per crate with
#
#   error: couldn't check if the package is yanked: registry: request could not be
#          completed in the allotted timeframe
#
# about 170 times, and then exited 0. A failure to CHECK is indistinguishable from a
# clean check in that exit code, so the audit reported "1 allowed warning" and meant
# "1 allowed warning, plus 170 questions I could not ask". It read as clean through
# the 0.2.7 release.
#
# MEASURED, AND IT IS NOT THE NETWORK. `index.crates.io` answers 200 in 0.3s from
# inside the same container and the requests reuse open connections. It is the INDEX
# CACHE. The yanked check needs the sparse-index entry for every crate in the lock;
# a missing entry becomes an HTTP request, cargo-audit fires them all at once, and its
# per-request timeout is blown for most of them. A lock with 8 crates produces no
# errors at all; this one's 588 produce ~170.
#
# Each run caches what did get through, so it converges — given somewhere to persist:
#
#   no volume at all            163, then 181 (every run restarts from the image)
#   fresh volume, pass 1..4     167, 23, 6, 0
#   emptied index cache         295 (so "cold is better" is wrong)
#   cargo fetch beforehand      175 (it reads the lock, not the index)
#
# Four audit passes to converge is not a procedure. `cargo update --dry-run` asks the
# index for the whole graph in ONE operation, through cargo's own client rather than
# cargo-audit's, and writes every entry into the same cache — after which the yanked
# check reads from disk and asks nothing. From a volume created seconds earlier:
# 0 errors, first pass. It does not touch Cargo.lock, and says so
# ("not updating lockfile due to dry run"); `git status` confirms it.
#
# So the warm-up is the fix and the volume is the speed: without it each run
# re-downloads the index, with it the warm-up is a no-op after the first time.
#
# This script also FAILS on a yanked-check error instead of letting it scroll past. An
# audit that cannot answer must say so — that is the half that would have caught this.
set -e

IMAGE=rite-ci:local
VOLUME=rite-cargo-registry
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT

say() { printf '\n\033[1;36m── %s\033[0m\n' "$1"; }

say "cargo audit — advisories, unmaintained, yanked"
if command -v cargo >/dev/null 2>&1 && command -v cargo-audit >/dev/null 2>&1; then
  cargo update --dry-run --workspace >/dev/null 2>&1 || true
  cargo audit 2>&1 | tee "$LOG" || true
else
  # The host has no Rust toolchain (pnpm on the host, cargo in the container), so the
  # audit runs in the image CI mirrors.
  podman volume create "$VOLUME" >/dev/null 2>&1 || true
  podman run --rm \
    -v "$PWD":/workspace:Z \
    -v "$VOLUME":/usr/local/cargo/registry \
    -w /workspace "$IMAGE" \
    sh -c 'cargo update --dry-run --workspace >/dev/null 2>&1 || true; cargo audit' \
    2>&1 | tee "$LOG" || true
fi

# Did every check actually run? This is the whole reason the script exists.
BLIND=$(grep -c "couldn't check if the package is yanked" "$LOG" || true)
if [ "$BLIND" -gt 0 ]; then
  printf '\n\033[1;31mThe yanked-crate check did not run: %s crates went unasked.\033[0m\n' "$BLIND"
  echo "This is the failure mode the script header describes. The audit above is"
  echo "INCOMPLETE whatever it reported. Check that the $VOLUME volume exists and is"
  echo "mounted, then run again."
  exit 1
fi

# A vulnerability exits non-zero; a warning on the allow-list exits 0 and is printed.
if grep -qE "^error: [0-9]+ vulnerabilit" "$LOG"; then
  printf '\n\033[1;31mcargo audit found a vulnerability.\033[0m\n'
  exit 1
fi

say "pnpm audit — the JavaScript tree"
pnpm audit

printf '\n\033[1;32m── audit complete: every check ran\033[0m\n'
