#!/usr/bin/env sh
# Bring up the SSH harness the e2e suite connects to — entirely inside a container.
#
# The suite needs a host it can really open an SSH session to (127.0.0.1:2222,
# riteuser/ritepass123), and the dashboard specs need that host to answer `docker ps`
# and `systemctl`. Both of those are root-level changes: a user account, an sshd, two
# commands on PATH. None of them belong on a developer's machine, so they all happen in
# a throwaway container (`rite-ci:local`, the ISO-CI image) that shares the host network
# and mounts the repo read-write at /workspace. Nothing is installed on the host, and
# `podman rm -f rite-sshd` undoes everything.
#
#   sh e2e/harness-up.sh     # idempotent: creates it, or tops up a running one
#   podman rm -f rite-sshd   # tear it all down
#
# The image comes from the repo's Containerfile: podman build -t rite-ci:local -f Containerfile .
set -e

NAME="${RITE_HARNESS_NAME:-rite-sshd}"
IMAGE="${RITE_HARNESS_IMAGE:-rite-ci:local}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

if ! podman image exists "$IMAGE"; then
  echo "error: image $IMAGE is missing — build it first:" >&2
  echo "  podman build -t rite-ci:local -f Containerfile ." >&2
  exit 1
fi

# A container that is already up keeps its sshd (and the sessions through it) alive;
# we only top up what may be missing. Recreating it would drop connections mid-suite.
if [ "$(podman inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]; then
  echo "[harness] $NAME is already running — topping up"
else
  podman rm -f "$NAME" >/dev/null 2>&1 || true
  # --network=host so 127.0.0.1:2222 is the same loopback rite-server dials; the repo
  # is mounted so the scripts (and any edit to them) come from the working tree.
  podman run -d --name "$NAME" --network=host -v "$REPO":/workspace:Z -w /workspace \
    "$IMAGE" bash -lc 'sh e2e/sshd-setup.sh && sleep infinity' >/dev/null
  # Wait for sshd to accept connections before anything tries to use it.
  i=0
  while [ "$i" -lt 30 ]; do
    podman exec "$NAME" sh -c 'exec 3<>/dev/tcp/127.0.0.1/2222' 2>/dev/null && break
    sleep 1
    i=$((i + 1))
  done
  echo "[harness] $NAME started — sshd on 127.0.0.1:2222 (riteuser / ritepass123)"
fi

# The dashboard's cards are agentless: they run one command per card over the SSH
# session and parse its stdout. The container has neither a container runtime nor
# systemd, so without these stubs the cards only ever render their empty state and the
# tables, row actions and wide mode go untested. wave1.spec.ts's dashboard test stays
# valid either way — it asserts a definite answer, not which answer.
podman exec "$NAME" sh -c 'cd /workspace && sh e2e/dashboard-stubs.sh'
