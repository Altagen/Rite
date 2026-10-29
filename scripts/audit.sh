#!/usr/bin/env sh
# The dependency security audit, Rust and JavaScript, as one answer.
#
#   sh scripts/audit.sh          both trees
#   sh scripts/audit.sh rust     cargo only (what the CI job runs)
#   sh scripts/audit.sh js       pnpm only
#
# WHY THIS IS A SCRIPT AND NOT TWO LINES IN THE TASKFILE. `cargo audit` runs three
# checks — advisories, unmaintained crates, and whether a locked version has been
# yanked from crates.io — and it exits 0 in three different ways that all read as
# clean. All three were live through the 0.2.7 release:
#
#   1. the yanked check could not run at all, 170 times over, and said so only in
#      lines that scrolled past;
#   2. a yanked crate that IS found is a warning, not an error, so exit stays 0;
#   3. a wrapper that swallows the exit code reports success when `cargo audit`
#      never started — a missing image, a missing binary, an unreachable database.
#
# (1) IS THE INDEX CACHE, NOT THE NETWORK. `index.crates.io` answers 200 in 0.3s from
# inside the same container and the requests reuse open connections. The yanked check
# needs the sparse-index entry for every crate in the lock; a missing entry becomes an
# HTTP request, cargo-audit fires them all at once, and its per-request timeout is
# blown for most of them. A lock with 8 crates produces no errors at all; this one's
# 588 produce ~170. Each run caches what got through, so it converges — given
# somewhere to persist:
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
# (2) IS `--deny yanked`. Measured both ways on this lock: with crypto-bigint forced
# to 0.7.6 — the version CI reported yanked during 0.2.7 — the flag exits 1 and its
# absence exits 0 under "2 allowed warnings found". `--deny unmaintained` is NOT set:
# RUSTSEC-2024-0370 (proc-macro-error, no upgrade path from the GTK3 line) would fail
# every run, and a check that always fails gets ignored like one that never runs.
#
# (3) IS THE THREE GUARDS BELOW. An audit that did not answer must not report green,
# so the script proves the run happened before it believes the result.
set -e

IMAGE=rite-ci:local
VOLUME=rite-cargo-registry
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT

say() { printf '\n\033[1;36m── %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m%s\033[0m\n' "$1"; exit 1; }

audit_rust() {
  say "cargo audit — advisories, unmaintained, yanked"
  if command -v cargo >/dev/null 2>&1 && command -v cargo-audit >/dev/null 2>&1; then
    { cargo update --dry-run --workspace >/dev/null 2>&1 || true
      cargo audit --deny yanked || echo "cargo-audit exit status: $?"
      } 2>&1 | tee "$LOG"
  else
    # The host has no Rust toolchain (pnpm on the host, cargo in the container), so the
    # audit runs in the image CI mirrors.
    podman volume create "$VOLUME" >/dev/null 2>&1 || true
    podman run --rm \
      -v "$PWD":/workspace:Z \
      -v "$VOLUME":/usr/local/cargo/registry \
      -w /workspace "$IMAGE" \
      sh -c 'cargo update --dry-run --workspace >/dev/null 2>&1 || true
             cargo audit --deny yanked || echo "cargo-audit exit status: $?"' \
      2>&1 | tee "$LOG"
  fi

  # Did the audit run? A pipeline reports `tee`'s status, and a container that never
  # started writes nothing at all, so success is proven from the output or not at all.
  # The needle skips cargo's coloured status verb: "Scanning" is wrapped in escape
  # codes even through a pipe, so only the plain remainder of the line is greppable.
  grep -q "Cargo.lock for vulnerabilities" "$LOG" ||
    die "cargo audit never ran: nothing in the output says it scanned the lockfile.
Check that cargo-audit is installed, or that the $IMAGE image exists."

  # Did every check inside it run? This is the whole reason the script exists.
  BLIND=$(grep -c "couldn't check if the package is yanked" "$LOG" || true)
  [ "$BLIND" -eq 0 ] ||
    die "The yanked-crate check did not run: $BLIND crates went unasked.
This is the failure mode the script header describes. The audit above is INCOMPLETE
whatever it reported. Check that the $VOLUME volume exists and is mounted, then run
again."

  # And did it pass? The status line appears only on a non-zero exit.
  ! grep -q "^cargo-audit exit status: " "$LOG" ||
    die "cargo audit failed. A vulnerability or a yanked crate is reported above."
}

audit_js() {
  say "pnpm audit — the JavaScript tree"
  pnpm audit
}

case ${1:-all} in
  rust) audit_rust ;;
  js)   audit_js ;;
  all)  audit_rust; audit_js ;;
  *)    die "Usage: sh scripts/audit.sh [rust|js]" ;;
esac

printf '\n\033[1;32m── audit complete: every check ran\033[0m\n'
