#!/usr/bin/env sh
# Client↔server multiplexer smoke (ADR 0012), headless (curl only, no browser). Proves the desktop
# client can connect to a remote Rite accounts server: a LOCAL mux server (the role each desktop
# window's server plays) adds the remote to its roster, switches its active context to it, and from
# then on reverse-proxies /api to the remote — login goes through the mux, and the mux forwards the
# remote session token it captured from the login on authenticated calls.
#
# The browser-driven end-to-end (incl. the WS terminal proxy + client-execute + zero-knowledge) is
# e2e/tests/proxy.spec.ts; this is the fast pre-release smoke. Needs target/debug/rite-server built.
#
#   sh e2e/proxy-smoke.sh
#
# Runs wherever the standalone rite-server can run (your machine / CI). In a sandbox that blocks a
# long-lived standalone server binary, run it inside the ISO-CI container (server + curl + node all
# work there), which is how it's verified in this repo:
#   podman run --rm -v "$PWD":/workspace:Z -w /workspace localhost/rite-ci:local \
#     bash -lc 'cd /workspace && sh e2e/proxy-smoke.sh'
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/debug/rite-server"
WEB="$ROOT/apps/desktop/dist"
REMOTE="http://127.0.0.1:18443"
MUX="http://127.0.0.1:18444"

[ -x "$BIN" ] || { echo "FAIL: build rite-server first (cargo build -p rite-server)"; exit 1; }
command -v node >/dev/null || { echo "FAIL: node needed for the login auth-hash"; exit 1; }

RHOME="$(mktemp -d /tmp/rite-proxy-remote.XXXXXX)"; mkdir -p "$RHOME/.local/share/rite"
CHOME="$(mktemp -d /tmp/rite-proxy-mux.XXXXXX)"; mkdir -p "$CHOME/.local/share/rite"
ok() { printf '  \342\234\223 %s\n' "$1"; }
die() { echo "FAIL: $1"; [ -n "${2:-}" ] && cat "$2" 2>/dev/null; exit 1; }
json() { grep -oE "\"$2\":\"[^\"]*\"" "$1" | head -1 | sed 's/.*:"//;s/"$//'; }

cleanup() { kill "${RPID:-}" "${CPID:-}" 2>/dev/null || true; rm -rf "$RHOME" "$CHOME"; }
trap cleanup EXIT

# 1. Remote (accounts, env-bootstrapped admin) + mux (local).
HOME="$RHOME" RITE_ADDR="127.0.0.1:18443" RITE_ACCOUNTS=1 RITE_ADMIN_USER=envadmin \
  RITE_ADMIN_PASSWORD='EnvPass123!' RITE_WEB_DIR="$WEB" RUST_LOG=warn "$BIN" >"$RHOME/log" 2>&1 &
RPID=$!
HOME="$CHOME" RITE_ADDR="127.0.0.1:18444" RITE_WEB_DIR="$WEB" RUST_LOG=warn "$BIN" >"$CHOME/log" 2>&1 &
CPID=$!

wait_up() { i=0; until curl -s -o /dev/null --max-time 2 "$1/api/server/mode"; do
  i=$((i+1)); [ "$i" -gt 100 ] && die "server never came up: $1" "$2"; sleep 0.1; done; }
wait_up "$REMOTE" "$RHOME/log"
wait_up "$MUX" "$CHOME/log"
curl -s "$REMOTE/api/server/mode" | grep -q '"accounts":true' || die "remote not in accounts mode" "$RHOME/log"
curl -s "$MUX/api/server/mode" | grep -q '"accounts":true' && die "mux should start local, not accounts"
ok "remote (accounts, env admin) + mux (local) both up"

# 2. The desktop "Add a server" + open it: roster + switch active context (local control plane).
curl -s -X POST "$MUX/api/context/servers" -H 'content-type: application/json' \
  -d "{\"url\":\"$REMOTE\",\"label\":\"TeamServer\"}" > "$CHOME/add.json"
SID="$(json "$CHOME/add.json" id)"
[ -n "$SID" ] || die "server not added to the roster" "$CHOME/add.json"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$MUX/api/context/active" -H 'content-type: application/json' -d "{\"server\":\"$SID\"}")"
[ "$CODE" = "204" ] || die "switch to remote failed (got $CODE)"
ok "mux added the remote + switched its active context to it"

# 3. From now on /api is reverse-proxied to the remote.
curl -s "$MUX/api/server/mode" | grep -q '"accounts":true' || die "mux does not proxy the remote mode"
ok "a GET through the mux is proxied to the remote (accounts:true)"

# 4. Log in THROUGH the mux (prelogin + login both proxied; the password never hits the wire).
curl -s -X POST "$MUX/api/server/prelogin" -H 'content-type: application/json' -d '{"username":"envadmin"}' > "$CHOME/pre.json"
SALT="$(json "$CHOME/pre.json" salt)"
[ -n "$SALT" ] || die "prelogin through the mux returned no salt" "$CHOME/pre.json"
HASH="$(node "$ROOT/e2e/argon-hash.mjs" 'EnvPass123!' "$SALT")"
curl -s -X POST "$MUX/api/server/login" -H 'content-type: application/json' -d "{\"username\":\"envadmin\",\"authHash\":\"$HASH\"}" > "$CHOME/login.json"
TOKEN="$(json "$CHOME/login.json" token)"
[ -n "$TOKEN" ] || die "login through the mux returned no token" "$CHOME/login.json"
ok "login through the mux authenticated against the remote"

# 5. Authenticated proxying: the mux forwards the remote token it captured — an authed call needs
#    NO client token (before the login it would 401).
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$MUX/api/vault/connections")"
[ "$CODE" = "200" ] || die "authenticated call not proxied with the mux-held token (got $CODE)"
ok "an authenticated call is proxied with the mux-held remote token"

# 6. A wrong password is rejected through the mux.
BADHASH="$(node "$ROOT/e2e/argon-hash.mjs" 'WrongPass!' "$SALT")"
curl -s -X POST "$MUX/api/server/login" -H 'content-type: application/json' -d "{\"username\":\"envadmin\",\"authHash\":\"$BADHASH\"}" > "$CHOME/bad.json"
grep -q '"error"' "$CHOME/bad.json" || die "wrong password not rejected" "$CHOME/bad.json"
ok "a wrong password is rejected through the mux"

printf '\n\342\234\205 proxy-smoke passed — the desktop mux connects to a remote accounts server (ADR 0012)\n'
