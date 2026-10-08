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

compose() { podman compose -f deploy/compose.yml "$@"; }
cleanup() {
  compose down -v >/dev/null 2>&1 || true
  rm -f deploy/admin_password.txt
}
trap cleanup EXIT

echo "— starting from deploy/compose.yml, with nothing but a file and a secret"
echo -n 'Turnkey-Acceptance-P4ss!' > deploy/admin_password.txt
compose up -d >/dev/null 2>&1

i=0
while [ $i -lt 40 ]; do
  curl -sf http://127.0.0.1:1421/api/health >/dev/null 2>&1 && break
  sleep 1
  i=$((i + 1))
done

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
  echo "✅ turnkey acceptance passed — configured, not merely administrable"
else
  echo
  echo "❌ turnkey acceptance failed"
  exit 1
fi
