#!/usr/bin/env sh
# Install stub `docker` and `systemctl` INSIDE the harness container so the machine
# dashboard's agentless probes return populated output over a real SSH exec.
#
# Do not run this on your own machine: it writes two fake binaries into /usr/local/bin
# and needs root to do it. `sh e2e/harness-up.sh` runs it where it belongs — in the
# throwaway container that also carries the sshd — and nothing touches the host.
#
# The dashboard detects what a host offers by running one command per card and
# parsing its stdout (see apps/desktop/src/utils/machineProbe.ts). The harness
# container has neither runtime, so without these the cards only ever render
# their empty state and the tables, row actions and wide mode go untested.
# These reproduce the exact output formats the parsers expect — the probe, the
# SSH exec path and the parsing are all still the real thing.
set -e

cat > /usr/local/bin/docker <<'EOF'
#!/bin/sh
case "$*" in
  *stats*)
    printf '%s\n' \
      'web|0.40%|82MiB / 2GiB' \
      'api|2.10%|318MiB / 2GiB' \
      'worker|1.30%|204MiB / 2GiB' \
      'redis|0.20%|12MiB / 2GiB' \
      'migrate|0.00%|0B / 2GiB'
    ;;
  *ps*)
    # Names|Image|State|Ports|RunningFor
    printf '%s\n' \
      'web|nginx:1.27|running|0.0.0.0:80->80/tcp|3 days ago' \
      'api|acme/api:2.4.1|running|0.0.0.0:8080->8080/tcp|3 days ago' \
      'worker|acme/api:2.4.1|running||3 days ago' \
      'redis|redis:7-alpine|running|6379/tcp|3 days ago' \
      'migrate|acme/api:2.4.1|exited||2 days ago'
    ;;
esac
exit 0
EOF

cat > /usr/local/bin/systemctl <<'EOF'
#!/bin/sh
case "$*" in
  *show*)
    # Key=Value blocks separated by blank lines, one per unit.
    printf '%s\n\n' 'Id=nginx.service
MemoryCurrent=44040192
ActiveEnterTimestamp=Tue 2026-09-18 14:00:00 UTC'
    printf '%s\n\n' 'Id=app.service
MemoryCurrent=318767104
ActiveEnterTimestamp=Tue 2026-09-18 14:01:00 UTC'
    printf '%s\n\n' 'Id=postgresql.service
MemoryCurrent=1073741824
ActiveEnterTimestamp=Tue 2026-09-18 13:59:00 UTC'
    printf '%s\n\n' 'Id=backup.service
MemoryCurrent=0
ActiveEnterTimestamp='
    ;;
  *list-units*)
    # UNIT LOAD ACTIVE SUB DESCRIPTION
    printf '%s\n' \
      'nginx.service loaded active running A high performance web server' \
      'app.service loaded active running Acme API' \
      'postgresql.service loaded active running PostgreSQL RDBMS' \
      'backup.service loaded failed failed Nightly backup job'
    ;;
esac
exit 0
EOF

chmod +x /usr/local/bin/docker /usr/local/bin/systemctl
echo "[stubs] docker + systemctl installed in /usr/local/bin"
