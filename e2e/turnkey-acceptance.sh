#!/usr/bin/env sh
# ADR 0020's acceptance test, as a command rather than a sentence.
#
#   sh e2e/turnkey-acceptance.sh
#
# The claim: a container started with a configuration file and a secret produces a
# usable, CONFORMANT instance — administrator created, policies the ones in the
# repository — without anyone opening a browser.
#
# Before ADR 0020 this stopped halfway: the administrator was provisioned, the
# policies were not, and an operator still had to go clicking. The check exists so
# that gap cannot quietly reopen.
#
# By default it builds the server under test and wraps it in a throwaway image, so the
# check runs on the code in front of you rather than on the last release. Set RITE_IMAGE
# to point it somewhere else — at the published image, say, which predates ADR 0020 and
# therefore fails, correctly:
#
#   RITE_IMAGE=ghcr.io/altagen/rite-server:latest sh e2e/turnkey-acceptance.sh
#
# The image it builds is not distributable: it wraps the release binary straight from
# `target/`, so whatever frontend was embedded at compile time comes along unchanged.
# That is fine here — every assertion below is an API call. `Containerfile.server` is the
# real recipe, and the release pipeline exercises it on four architectures every version.
set -e

IMAGE="${RITE_IMAGE:-}"

# Build the server under test, then wrap it. Both steps reuse the repo's `target/`, so
# this is seconds of work and not the twenty-five minutes a cold release build inside a
# container costs.
if [ -z "$IMAGE" ]; then
  IMAGE=localhost/rite-server:acceptance
  echo "— building the server under test (incremental, in the ISO-CI image)"
  podman run --rm -v "$PWD":/workspace:Z -w /workspace rite-ci:local \
    bash -lc 'cargo build --release -p rite-server' >/dev/null 2>&1
  # A context holding the binary and nothing else: the repo's .dockerignore excludes
  # `target/` (rightly — it keeps Containerfile.server's context small), and a 15 MB
  # context beats shipping the working tree to the build daemon anyway.
  ctx=$(mktemp -d)
  cp target/release/rite-server "$ctx/"
  # Ubuntu 24.04, matching the ISO-CI image that compiled the binary: it links against
  # that glibc, and dropping it into bookworm (2.36) fails at load with GLIBC_2.39 not
  # found. Containerfile.server never meets this because it builds and runs on the same
  # distribution — which is the reason it is the real recipe and this is a test fixture.
  cat > "$ctx/Containerfile" <<'CONTAINERFILE'
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /home/rite --shell /usr/sbin/nologin rite
COPY rite-server /usr/local/bin/rite-server
USER rite
EXPOSE 1421
ENTRYPOINT ["/usr/local/bin/rite-server"]
CONTAINERFILE
  echo "— wrapping target/release/rite-server in $IMAGE"
  podman build -q -t "$IMAGE" "$ctx" >/dev/null
  rm -rf "$ctx"
fi
export RITE_IMAGE="$IMAGE"

# Both files: the bootstrap is an OVERRIDE now, so the acceptance exercises the
# composition an operator actually types rather than a file that no longer carries the
# secret. The base file on its own has no administrator to find — which is phase 1.
plain() { podman compose -f deploy/compose.yml "$@"; }
compose() { podman compose -f deploy/compose.yml -f deploy/compose.bootstrap.yml "$@"; }
# The data volume, by name. `podman compose down -v` removes it only while tearing down a
# container that exists: with nothing running it errors, the `|| true` swallows that, and
# the volume survives — a four-day-old one is what made phase 1 read as a regression. So
# the volume is removed explicitly. The name is how compose derives it: the project is the
# directory holding the file (`deploy`), plus the declared volume.
DATA_VOLUME=deploy_rite-data

wipe() {
  compose down -v >/dev/null 2>&1 || true
  plain down -v >/dev/null 2>&1 || true
  podman volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
}

cleanup() {
  wipe
  rm -f deploy/admin_password.txt
}
trap cleanup EXIT

await_health() {
  i=0
  while [ $i -lt 40 ]; do
    curl -sf http://127.0.0.1:1421/api/health >/dev/null 2>&1 && return 0
    sleep 1
    i=$((i + 1))
  done
  echo "  ✘ the server never answered /api/health" >&2
  return 1
}

# ───────────────────────────────────────────────────────────────────────────────
# Phase 1 — the DEFAULT path: nothing to prepare.
#
# The deployment files used to wire the bootstrap secret, which made
# `deploy/admin_password.txt` a condition of starting at all: compose refuses to start
# when a secret's source is missing. So the documented way to decline the feature was to
# create the file empty, which is not a thing anyone does. The files ask for nothing now,
# and this phase is what keeps that true — it starts with NO password file on disk, and a
# file left behind by a previous run would hide a regression here.
# ───────────────────────────────────────────────────────────────────────────────
echo "— phase 1: deploy/compose.yml alone, with nothing prepared"
# From an EMPTY data volume, not merely from a stopped container. Both phases publish on
# the same compose project, so the volume survives between runs — and phase 2 leaves an
# administrator in it. Starting phase 1 on top of that found `needsBootstrap: false` and
# read as "the default path needs something prepared", which is the opposite of the truth.
# The claim here is about a FRESH instance, so the freshness is made, not hoped for.
wipe
rm -f deploy/admin_password.txt
# Not `>/dev/null` and out: this is the one command the phase is about. The regression it
# guards — the bootstrap secret wired back into a deployment file — shows up here as
# compose refusing to start, and `set -e` would end the script with a bare exit 125 and no
# line saying why. So it says why.
if ! plain up -d >/dev/null 2>&1; then
  echo "  ✘ deploy/compose.yml did not start with nothing prepared:"
  plain up -d 2>&1 | sed 's/^/      /' | tail -4
  echo
  echo "    A \`statfs … admin_password.txt\` here means the bootstrap secret has been wired"
  echo "    back into the deployment file. It belongs in deploy/compose.bootstrap.yml, so"
  echo "    that starting Rite needs nothing prepared."
  exit 1
fi
await_health

plain_mode=$(curl -sf http://127.0.0.1:1421/api/server/mode)
p1=0
pcheck() {
  if printf '%s' "$plain_mode" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if ($2) else 1)" 2>/dev/null; then
    echo "  ✓ $1"
  else
    echo "  ✘ $1"
    p1=1
  fi
}
pcheck "it starts with no password file at all"      "d['accounts'] is True"
# Said before the claim below, because the two failures look identical and are not: an
# instance that already has accounts says `needsBootstrap: false` for a reason that has
# nothing to do with what this phase is about.
if printf '%s' "$plain_mode" | grep -q '"needsBootstrap":false'; then
  echo "  ⚠ this instance already has accounts — the $DATA_VOLUME volume was not empty,"
  echo "    so what follows measures a leftover deployment and not the default path."
fi
# The claim that matters: the first visit is asked to create the administrator, so no
# credential had to exist anywhere for this instance to be usable.
pcheck "and asks the first visitor to create the administrator" "d['needsBootstrap'] is True"
# Configured all the same — the TOML is not where secrets live, so the two are
# independent. An instance can be fully declared and still have no account.
pcheck "while still being configured from the file" "d['instanceName'] == 'Rite'"
pcheck "with its settings published as managed"     "len(d['managed']) >= 4"

# And the administrator can then be created, which is the whole point of the path: this is
# the API call the first-run screen makes, under the name it fixes (utils/adminUsername.ts).
created=$(curl -sf -o /dev/null -w '%{http_code}' -X POST \
  http://127.0.0.1:1421/api/server/bootstrap \
  -H 'content-type: application/json' \
  -d '{"username":"admin","salt":"00112233445566778899aabbccddeeff","params":{"mem":19456,"iter":2,"par":1},"authHash":"3c9a1f5e7d2b48c6a0e5f1d3b7c92a4e6f8d0b2c4a6e8f1d3b5c7a9e1f3d5b7c","masterSalt":"ffeeddccbbaa99887766554433221100","protectedUserKey":"v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","publicKey":"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff","protectedPrivateKey":"v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' || true)
if [ "$created" = "200" ] || [ "$created" = "201" ]; then
  echo "  ✓ and the browser's own bootstrap call is accepted"
else
  echo "  ✘ the browser's bootstrap call was refused ($created)"
  p1=1
fi

plain down -v >/dev/null 2>&1

if [ "$p1" -ne 0 ]; then
  echo
  echo "❌ the default path needs something prepared — that is the regression this phase exists for"
  exit 1
fi
echo

# ───────────────────────────────────────────────────────────────────────────────
# Phase 2 — the OPT-IN: ADR 0020's turnkey claim.
# ───────────────────────────────────────────────────────────────────────────────

echo "— phase 2: + deploy/compose.bootstrap.yml, with a file and a secret"
# Same reason: the bootstrap only acts while no account exists, so phase 1's own
# administrator would make this phase pass without the secret doing anything.
wipe
echo -n 'Turnkey-Acceptance-P4ss!' > deploy/admin_password.txt
compose up -d >/dev/null 2>&1
await_health

mode=$(curl -sf http://127.0.0.1:1421/api/server/mode)

# The most likely reason this check fails is the most boring one: the image under test
# predates ADR 0020 and has never heard of a configuration file. Say so, rather than
# printing six crosses and letting the reader guess.
if ! printf '%s' "$mode" | grep -q '"managed"'; then
  echo
  echo "This image does not publish \`managed\`, so it predates the instance configuration"
  echo "(ADR 0020) and cannot honour deploy/rite.toml. Build the server under test first:"
  echo
  echo "    podman build -t localhost/rite-server:dev -f Containerfile.server ."
  echo "    RITE_IMAGE=localhost/rite-server:dev sh e2e/turnkey-acceptance.sh"
  echo
  exit 1
fi

fail=0
check() {
  if printf '%s' "$mode" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if ($2) else 1)" 2>/dev/null; then
    echo "  ✓ $1"
  else
    echo "  ✘ $1"
    fail=1
  fi
}

# Administrable: the administrator exists, so nobody is asked to create one.
check "the administrator was created from the secret"  "d['needsBootstrap'] is False"

# Conformant. The instance name is the discriminating one — its default is null, so only
# the file can produce it. The two booleans below agree with the shipped defaults, which
# means they corroborate rather than prove: keep them for the readout, do not lean on them.
check "the instance name comes from the file"          "d['instanceName'] == 'Rite'"
check "Quick SSH matches the file"                     "d['allowQuickSsh'] is False"
check "self-registration matches the file"             "d['openRegistration'] is False"
# And the console will say which settings it cannot change.
check "the declared settings are published as managed" \
  "sorted(d['managed']) == ['allow_quick_ssh', 'dashboard_policy', 'instance_name', 'open_registration']"
check "each one names where it was set"                "all(v.endswith('rite.toml') for v in d['managed'].values())"

if [ "$fail" -eq 0 ]; then
  echo
  echo "✅ both paths pass — nothing to prepare, and turnkey when asked for"
else
  echo
  echo "❌ turnkey acceptance failed"
  exit 1
fi
