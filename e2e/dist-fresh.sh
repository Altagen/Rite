#!/usr/bin/env sh
# THE DIST HAS TO BE NEWER THAN THE SOURCE. Called by every harness server, which
# refuses to start when it is not.
#
# Playwright serves apps/desktop/dist from disk and builds nothing. A dist left over
# from before the last edit tests the previous commit and reports "passed", which is
# worse than reporting nothing — it cost real time twice in one afternoon, once hunting
# a defect in code that was already correct because the bundle under test lacked the fix.
#
# `embedded-ui-check` already guards the RELEASE path: the binary's embedded copy must
# not be older than the dist. This is the same rule one step earlier, on the path the
# tests take.
#
# NAMED, NOT SILENTLY REBUILT. A harness that quietly compiles is a harness whose
# duration nobody can predict, and the fix is one command the reader should see.
set -e

root="${1:-$PWD}"
dist="$root/apps/desktop/dist/index.html"

if [ ! -f "$dist" ]; then
  echo "no frontend on disk at $dist" >&2
  echo "run: pnpm --filter desktop build" >&2
  exit 1
fi

# -newer compares mtime, so a `git checkout` of a source file is enough to trip this —
# deliberately: that file's content is in the tree and not in the bundle either.
stale=$(find "$root/apps/desktop/src" "$root/apps/desktop/index.html" -newer "$dist" 2>/dev/null | head -n 5)
if [ -n "$stale" ]; then
  echo "the frontend on disk is older than its source — these are newer:" >&2
  echo "$stale" | sed "s|^$root/||;s|^|  |" >&2
  echo "run: pnpm --filter desktop build" >&2
  exit 1
fi

# NOT A RULE ABOUT THE FRONTEND ONLY. `e2e/run-checks.sh` drives these same servers for
# fifteen API checks that never open a page — and it still has to pass here, because the
# alternative is an escape hatch that gets set once and never unset. `e2e/gate.sh` builds
# the frontend in step 1, well before the checks in step 3, so inside the gate this costs
# nothing.
