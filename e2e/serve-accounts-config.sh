#!/usr/bin/env sh
# Accounts server on :1427, started from an instance configuration file (ADR 0020).
#
# Its own throwaway vault and its own port so it never collides with the plain
# accounts harness on :1422. The configuration is written here rather than kept in
# the repo: the point of the check is that a file governs the instance, and a file
# that lives beside the check is easier to read than one three directories away.
set -e

export HOME="${RITE_E2E_CONFIG_HOME:-/tmp/rite-e2e-config-home}"
rm -rf "$HOME/.local/share/rite"
mkdir -p "$HOME"

cat > "$HOME/rite.toml" <<'TOML'
instance_name     = "Configured by file"
open_registration = true    # NOT the default: the check can only discriminate on a flip
allow_quick_ssh   = true

[dashboard_policy]
webui = false

[collection_policy]
maxMembers = 7
TOML

export RITE_ADDR="127.0.0.1:1427"
export RITE_ACCOUNTS=1
export RITE_CONFIG="$HOME/rite.toml"
# One field set from the environment, over a policy the file already declares — the
# precedence has to hold end to end, not only in the unit tests.
export RITE__dashboard_policy__minInterval=90
export RITE_WEB_DIR="$PWD/apps/desktop/dist"

exec "$PWD/target/debug/rite-server"
