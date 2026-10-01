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

mkdir -p /run/sshd
ssh-keygen -A >/dev/null 2>&1 || true

pkill -f 'sshd .*-p 2222' 2>/dev/null || true
/usr/sbin/sshd -p 2222 \
  -o UsePAM=no \
  -o PasswordAuthentication=yes \
  -o PermitRootLogin=no \
  -o AllowUsers=riteuser

echo "[sshd] listening on 127.0.0.1:2222 (user riteuser / ritepass123)"
