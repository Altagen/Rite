#!/usr/bin/env sh
# Start a throwaway sshd in the harness container so the SSH e2e tests can prove
# a real connection (rite-server opens the SSH session to 127.0.0.1:2222).
# Password auth, PAM off, one dedicated user — deterministic, no host secrets.
#
# It creates a user account and starts a daemon, so it needs root: run it through
# `sh e2e/harness-up.sh`, which does it inside the container, not on your machine.
set -e
export PATH="/usr/sbin:/sbin:$PATH"

if ! test -x /usr/sbin/sshd; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null
fi

id riteuser >/dev/null 2>&1 || useradd -m -s /bin/bash riteuser
echo 'riteuser:ritepass123' | chpasswd

# Key-based authentication, so the suite can prove the two paths a password cannot
# reach: a key named on disk (`AuthMethod::PublicKey`, a desktop's own machine) and a
# key carried inside the record (`AuthMethod::VaultKey`, ADR 0024 — a browser has no
# filesystem the server shares). One pair has a passphrase and one does not, because
# "ask for the passphrase at connect time" and "a key with no passphrase is never
# prompted for" are two different behaviours.
#
# Generated here rather than committed: a private key in a public repository is a
# finding whatever its contents, and a scanner cannot tell a throwaway from a real one.
# They live under the mounted repo so the host-side rite-server can read the same files.
KEYS=/workspace/e2e/.keys
mkdir -p "$KEYS"
test -f "$KEYS/e2e_plain" || ssh-keygen -q -t ed25519 -N '' -C 'rite-e2e-plain' -f "$KEYS/e2e_plain"
test -f "$KEYS/e2e_locked" || ssh-keygen -q -t ed25519 -N 'rite-e2e-passphrase' -C 'rite-e2e-locked' -f "$KEYS/e2e_locked"
# root wrote them inside the container; the host runs rite-server as whoever owns the
# repository, so hand the files to that owner rather than widening their mode. 600 is not
# pedantry here: `russh` reads the file and does not care, but OpenSSH refuses a private
# key anyone else can read, so a loosened mode would quietly break `ssh -i` — which is how
# this harness gets checked by hand.
OWNER="$(stat -c '%u:%g' /workspace)"
chown "$OWNER" "$KEYS" "$KEYS"/e2e_plain "$KEYS"/e2e_plain.pub "$KEYS"/e2e_locked "$KEYS"/e2e_locked.pub
chmod 600 "$KEYS/e2e_plain" "$KEYS/e2e_locked"
chmod 644 "$KEYS/e2e_plain.pub" "$KEYS/e2e_locked.pub"

install -d -m 700 -o riteuser -g riteuser /home/riteuser/.ssh
cat "$KEYS/e2e_plain.pub" "$KEYS/e2e_locked.pub" > /home/riteuser/.ssh/authorized_keys
chown riteuser:riteuser /home/riteuser/.ssh/authorized_keys
chmod 600 /home/riteuser/.ssh/authorized_keys

mkdir -p /run/sshd
ssh-keygen -A >/dev/null 2>&1 || true

pkill -f 'sshd .*-p 2222' 2>/dev/null || true
/usr/sbin/sshd -p 2222 \
  -o UsePAM=no \
  -o PasswordAuthentication=yes \
  -o PubkeyAuthentication=yes \
  -o PermitRootLogin=no \
  -o AllowUsers=riteuser

echo "[sshd] listening on 127.0.0.1:2222 (user riteuser / ritepass123, keys in e2e/.keys)"
