#!/usr/bin/env sh
# Run every standalone cross-impl / RBAC / policy check.
#
# Two groups, because they have different needs:
#
#  * pure logic — no server and no browser, just a module and its data structure;
#  * crypto parity — no server, just Rust-vs-browser vectors;
#  * server checks — each drives the accounts server on :1422 through a full
#    bootstrap, so each needs a FRESH one. Several of them assume they are the
#    first to create the admin, and reusing a server across them fails at setup
#    with a 401 that looks like a bug and is not one.
#
# Run from the repo root: `sh e2e/run-checks.sh`
set -u
pass=0; fail=0; failed=''

run() {
  name="$1"; shift
  if out=$("$@" 2>&1); then
    echo "  PASS  $name"; pass=$((pass + 1))
  else
    echo "  FAIL  $name"; echo "$out" | tail -6 | sed 's/^/          /'
    fail=$((fail + 1)); failed="$failed $name"
  fi
}

# A FRESH SERVER, AND NOTHING ELSE ANSWERING ON ITS PORT.
#
# Two failures this replaces, both of them a check reporting on something other than what
# it was pointed at:
#
#  * the wait gave up SILENTLY after thirty seconds and ran the check anyway, against a
#    dead port — so a server that refused to start (a stale frontend, a migration that
#    will not apply) became fifteen checks failing for a reason none of them could name,
#    each after a thirty-second pause, with the real message in a log nobody printed;
#
#  * a server left behind by an INTERRUPTED run kept :1422, the new one could not bind,
#    and the health check answered — from the old one. Two checks then failed on a vault
#    that already had an admin, which reads exactly like a bug in the bootstrap.
#
# So: kill, wait for the port to actually free, start, and fail loudly either way.
fresh_server() {
  script="$1"; port="$2"; log="$3"
  pkill -f 'target/debug/rite-server' 2>/dev/null
  i=0
  while [ $i -lt 10 ]; do
    ss -ltn 2>/dev/null | grep -q ":$port " || break
    sleep 1; i=$((i + 1))
  done
  if ss -ltn 2>/dev/null | grep -q ":$port "; then
    echo
    echo "  :$port is held by something this script did not start and cannot stop:"
    ss -ltnp 2>/dev/null | grep ":$port " | sed 's/^/          /'
    echo
    exit 1
  fi
  sh "$script" >"$log" 2>&1 &
  i=0
  while [ $i -lt 30 ]; do
    curl -sf "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && return 0
    sleep 1; i=$((i + 1))
  done
  echo
  echo "  the server on :$port never answered /api/health. Its last words:"
  tail -12 "$log" 2>/dev/null | sed 's/^/          /'
  echo
  exit 1
}

# Each loads a module from apps/desktop/src directly: Node strips the types, and
# none of them imports anything at runtime, so these test the shipped code rather
# than a copy of it.
run "pane-tree-check" node "e2e/pane-tree-check.mjs"
run "pane-dispose-check" node "e2e/pane-dispose-check.mjs"
run "split-format-check" node "e2e/split-format-check.mjs"
run "layout-file-check" node "e2e/layout-file-check.mjs"
run "place-menu-check" node "e2e/place-menu-check.mjs"
run "shortcut-binding-check" node "e2e/shortcut-binding-check.mjs"
run "machine-command-check" node "e2e/machine-command-check.mjs"
run "agent-probe-check" node "e2e/agent-probe-check.mjs"
run "agent-adapters-check" node "e2e/agent-adapters-check.mjs"
run "agent-answers-check" node "e2e/agent-answers-check.mjs"
run "agent-context-check" node "e2e/agent-context-check.mjs"
run "marks-check" node "e2e/marks-check.mjs"
run "label-offers-check" node "e2e/label-offers-check.mjs"
run "label-caps-check" node "e2e/label-caps-check.mjs"
run "migrations-registered-check" node "e2e/migrations-registered-check.mjs"
run "vocab-parity-check" node "e2e/vocab-parity-check.mjs"
run "dead-props-check" node "e2e/dead-props-check.mjs"
run "harness-dist-check" node "e2e/harness-dist-check.mjs"
run "i18n-check" node "e2e/i18n-check.mjs"
run "board-markup-check" node "e2e/board-markup-check.mjs"
run "device-prefs-check" node "e2e/device-prefs-check.mjs"
run "version-check" node "e2e/version-check.mjs"
run "advisory-floor-check" node "e2e/advisory-floor-check.mjs"
run "ci-image-check" node "e2e/ci-image-check.mjs"
run "server-image-check" node "e2e/server-image-check.mjs"
run "audit-script-check" node "e2e/audit-script-check.mjs"
run "swatch-palette-check" node "e2e/swatch-palette-check.mjs"
run "local-shell-source-check" node "e2e/local-shell-source-check.mjs"
run "new-tab-cwd-check" node "e2e/new-tab-cwd-check.mjs"
run "mode-nudge-check" node "e2e/mode-nudge-check.mjs"
run "dead-end-check" node "e2e/dead-end-check.mjs"
run "mock-register-check" node "e2e/mock-register-check.mjs"
run "server-errors-check" node "e2e/server-errors-check.mjs"
run "layouts-source-check" node "e2e/layouts-source-check.mjs"
run "kdf-floor-check" node "e2e/kdf-floor-check.mjs"
run "rel-time-check" node "e2e/rel-time-check.mjs"
run "settings-rail-check" node "e2e/settings-rail-check.mjs"
run "inline-style-inventory-check" node "e2e/inline-style-inventory-check.mjs"
run "key-identity-check" node "e2e/key-identity-check.mjs"
run "key-support-check" node "e2e/key-support-check.mjs"
run "embedded-ui-check" node "e2e/embedded-ui-check.mjs"
run "install-entry-check" node "e2e/install-entry-check.mjs"
run "clipboard-decision-check" node "e2e/clipboard-decision-check.mjs"
run "palette-filter-check" node "e2e/palette-filter-check.mjs"
run "tab-plan-check" node "e2e/tab-plan-check.mjs"
run "clipboard-mode-file-check" node "e2e/clipboard-mode-file-check.mjs"
run "docs-check" node "e2e/docs-check.mjs"

echo
echo "crypto parity (Rust ↔ browser):"
for c in argon-check sealbox-check vault-check collection-crypto-check; do
  run "$c" node "e2e/$c.mjs"
done

echo
echo "server checks (fresh accounts server each):"
for c in discovery-check first-login-check reset-check manager-role-check \
         rbac-hierarchy-check enrollment-token-check enrollment-scoping-check \
         invitations-switch-check self-register-check collection-policy-check \
         healthcheck-check dashboard-policy-check agent-policy-check \
         layouts-policy-check \
         server-authz-check; do
  fresh_server e2e/serve-accounts.sh 1422 /tmp/rite-checks-server.log
  run "$c" node "e2e/$c.mjs"
done
pkill -f 'target/debug/rite-server' 2>/dev/null

echo
echo "configured instance (ADR 0020 — its own server, started from a TOML file):"
fresh_server e2e/serve-accounts-config.sh 1427 /tmp/rite-checks-config-server.log
run "instance-config-check" node "e2e/instance-config-check.mjs"
pkill -f 'target/debug/rite-server' 2>/dev/null

echo
echo "checks: $pass passed, $fail failed$([ -n "$failed" ] && echo " —$failed")"
[ "$fail" -eq 0 ]
