#!/usr/bin/env bash
# Mutate one file, rebuild, run a spec, restore. Reports killed / SURVIVED / BUILD FAILED.
#
#   sh e2e/mutate.sh <file> <spec-filter> <expected-pass-line> <old> <new>
#
# WHY THIS EXISTS AS A SCRIPT. A mutant that does not compile is never shipped, so the
# suite runs against the ORIGINAL bundle and comes back green — which reads as a surviving
# mutant and would have a sound test thrown away as hollow. It happened three times in one
# session before this was written. The build result is checked here so it cannot be
# forgotten at the call site.
#
# And the restore rebuilds too: `RITE_WEB_DIR` serves the frontend from disk, so putting
# the source back without rebuilding leaves the mutant live for whatever runs next.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
FILE=$1; FILTER=$2; EXPECT=$3; OLD=$4; NEW=$5
cd "$REPO"
BACKUP=$(mktemp)
cp "$FILE" "$BACKUP"

restore() { cp "$BACKUP" "$FILE"; pnpm --filter desktop build >/dev/null 2>&1; rm -f "$BACKUP"; }

python3 -I -c "
import sys
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
n = s.count(old)
assert n == 1, f'anchor appears {n} times, expected 1'
open(p, 'w').write(s.replace(old, new))
" "$FILE" "$OLD" "$NEW" || { echo "ANCHOR MISSED"; restore; exit 1; }

if ! pnpm --filter desktop build 2>&1 | grep -q 'built in'; then
  # Not a verdict either way: the mutant never reached the bundle.
  echo "BUILD FAILED — the mutant never shipped, so this says nothing"
  restore
  exit 1
fi

if npx playwright test --project=chromium "$FILTER" 2>&1 | grep -q "$EXPECT"; then
  echo "SURVIVED"
else
  echo "killed"
fi
restore
