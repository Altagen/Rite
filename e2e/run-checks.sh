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
run "i18n-check" node "e2e/i18n-check.mjs"
run "board-markup-check" node "e2e/board-markup-check.mjs"
run "device-prefs-check" node "e2e/device-prefs-check.mjs"
run "version-check" node "e2e/version-check.mjs"
run "advisory-floor-check" node "e2e/advisory-floor-check.mjs"
run "mode-nudge-check" node "e2e/mode-nudge-check.mjs"
run "dead-end-check" node "e2e/dead-end-check.mjs"
run "mock-register-check" node "e2e/mock-register-check.mjs"
run "server-errors-check" node "e2e/server-errors-check.mjs"
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
         healthcheck-check dashboard-policy-check server-authz-check; do
  pkill -f 'target/debug/rite-server' 2>/dev/null
  sleep 1
  sh e2e/serve-accounts.sh >/tmp/rite-checks-server.log 2>&1 &
  i=0
  while [ $i -lt 30 ]; do
    curl -sf http://127.0.0.1:1422/api/health >/dev/null 2>&1 && break
    sleep 1; i=$((i + 1))
  done
  run "$c" node "e2e/$c.mjs"
done
pkill -f 'target/debug/rite-server' 2>/dev/null

echo
echo "configured instance (ADR 0020 — its own server, started from a TOML file):"
pkill -f 'target/debug/rite-server' 2>/dev/null
sleep 1
sh e2e/serve-accounts-config.sh >/tmp/rite-checks-config-server.log 2>&1 &
i=0
while [ $i -lt 30 ]; do
  curl -sf http://127.0.0.1:1427/api/health >/dev/null 2>&1 && break
  sleep 1; i=$((i + 1))
done
run "instance-config-check" node "e2e/instance-config-check.mjs"
pkill -f 'target/debug/rite-server' 2>/dev/null

echo
echo "checks: $pass passed, $fail failed$([ -n "$failed" ] && echo " —$failed")"
[ "$fail" -eq 0 ]
