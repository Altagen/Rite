/**
 * Machine dashboard probes — the agentless commands Rite runs over SSH to detect a
 * host's containers and services, plus the parsers for their output and the command
 * builders for the inline actions (which open a terminal pane).
 *
 * One command per refresh. Container detection prefixes its output with the runtime
 * it found (`__rt__ docker|podman|none`) so a single exec both lists and tells us
 * which runtime to drive for Shell/Logs/Restart.
 */

export type ContainerRuntime = 'docker' | 'podman' | 'none';

export interface ContainerRow {
  name: string;
  image: string;
  /** Raw docker/podman state — "running", "exited", "created", … */
  state: string;
  ports: string;
  /** Human "created/uptime" (docker `{{.RunningFor}}`), e.g. "3 days ago". */
  created: string;
}

export interface ServiceRow {
  name: string;
  /** systemd high-level state: "active", "inactive", "failed", … */
  active: string;
  /** systemd low-level sub-state: "running", "dead", "failed", "waiting", … */
  sub: string;
  description: string;
}

// List all containers (running + stopped) with a stable, delimiter-based format.
// The leading `__rt__` line names the runtime so the parser can drive actions.
export const CONTAINERS_CMD =
  "if command -v docker >/dev/null 2>&1; then echo '__rt__ docker'; " +
  "docker ps -a --format '{{.Names}}|{{.Image}}|{{.State}}|{{.Ports}}|{{.RunningFor}}'; " +
  "elif command -v podman >/dev/null 2>&1; then echo '__rt__ podman'; " +
  "podman ps -a --format '{{.Names}}|{{.Image}}|{{.State}}|{{.Ports}}|{{.RunningFor}}'; " +
  "else echo '__rt__ none'; fi";

// List all systemd service units, plain (no legend/pager/colour) so columns are stable.
export const SERVICES_CMD =
  'systemctl list-units --type=service --all --no-pager --plain --no-legend 2>/dev/null';

/** Parse container detection output → runtime + rows. Malformed lines are skipped. */
export function parseContainers(stdout: string): { runtime: ContainerRuntime; rows: ContainerRow[] } {
  let runtime: ContainerRuntime = 'none';
  const rows: ContainerRow[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith('__rt__ ')) {
      const rt = line.slice(7).trim();
      runtime = rt === 'docker' || rt === 'podman' ? rt : 'none';
      continue;
    }
    const parts = line.split('|');
    if (parts.length < 3) continue;
    rows.push({
      name: parts[0].trim(),
      image: parts[1].trim(),
      state: parts[2].trim().toLowerCase(),
      ports: (parts[3] ?? '').trim(),
      created: (parts[4] ?? '').trim(),
    });
  }
  return { runtime, rows };
}

/** Parse `systemctl list-units` plain output → service rows. */
export function parseServices(stdout: string): ServiceRow[] {
  const rows: ServiceRow[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // UNIT LOAD ACTIVE SUB DESCRIPTION…  (whitespace-separated; description has spaces)
    const m = line.split(/\s+/);
    if (m.length < 4) continue;
    const [name, , active, sub, ...rest] = m;
    if (!name.endsWith('.service')) continue;
    rows.push({ name, active, sub, description: rest.join(' ') });
  }
  return rows;
}

export const isRunning = (c: ContainerRow) => c.state === 'running' || c.state === 'up';

/**
 * One argument of a command this app builds, safe to put in front of a shell.
 *
 * Every name below is **read off a remote host** — a container name from
 * `docker ps`, a unit name from `systemctl list-units` — and the command built from
 * it is typed into a live shell on that host. Docker and systemd both restrict the
 * names they accept, which is why nothing here has ever gone wrong; but that is
 * their rule, enforced somewhere else, about data that has already left their hands
 * by the time it reaches this file. This function is this file's own rule.
 *
 * It quotes only what needs it, because these strings are also the tooltip on the
 * button: `docker logs -f --tail 200 web-01` is what the user is about to run and is
 * worth reading, and quoting every ordinary name to guard against the one that is
 * not would cost that for nothing. A name outside the conservative set below — or
 * one that does not start with a letter or a digit, so that it cannot be read as a
 * flag — is single-quoted instead.
 *
 * What it does not solve: a name that *is* a flag is still passed as one, since no
 * amount of quoting changes argv parsing. Neither docker nor systemd will produce
 * such a name, and putting `--` in every builder would be guarding the same corner
 * twice. It is named here so the next person does not have to rediscover the limit.
 */
const PLAIN_ARG = /^[A-Za-z0-9][A-Za-z0-9._@:+-]*$/;

export function shellArg(value: string): string {
  if (PLAIN_ARG.test(value)) return value;
  // POSIX single quotes: everything is literal inside them, and a literal quote is
  // written by leaving, escaping it, and coming back.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// --- lazy enrichments (fetched only when a card is expanded) -----------------

/** Live container CPU%/memory (`docker/podman stats --no-stream`). */
export function statsCmd(rt: ContainerRuntime): string {
  const r = rt === 'none' ? 'docker' : rt;
  return `${r} stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' 2>/dev/null`;
}
/** name → {cpu, mem}. `MemUsage` is "used / limit"; we keep the used part. */
export function parseStats(stdout: string): Record<string, { cpu: string; mem: string }> {
  const out: Record<string, { cpu: string; mem: string }> = {};
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [name, cpu, mem] = line.split('|');
    if (!name) continue;
    out[name.trim()] = {
      cpu: (cpu ?? '').trim() || '—',
      mem: (mem ?? '').split('/')[0].trim() || '—',
    };
  }
  return out;
}

/** Per-unit memory + active-since for systemd services (`systemctl show`). */
export function servicesShowCmd(units: string[]): string {
  // Quoted, not stripped. Stripping used to drop whatever it did not like, which
  // turns `a;b.service` into `ab.service` — a real unit, possibly someone else's,
  // silently asked about instead of the one in hand. Quoting keeps the name.
  const list = units.map(shellArg).join(' ');
  return `systemctl show ${list} -p Id,MemoryCurrent,ActiveEnterTimestamp --no-pager 2>/dev/null`;
}
/** unit → {mem, since}. Blocks are `Key=Value` groups separated by blank lines. */
export function parseServicesShow(stdout: string): Record<string, { mem: string; since: string }> {
  const out: Record<string, { mem: string; since: string }> = {};
  for (const block of stdout.split(/\n\s*\n/)) {
    const props: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1).trim();
    }
    if (props.Id) out[props.Id] = { mem: fmtBytes(props.MemoryCurrent), since: fmtSince(props.ActiveEnterTimestamp) };
  }
  return out;
}
function fmtBytes(v?: string): string {
  const n = Number(v);
  if (!v || !Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'K', 'M', 'G', 'T'];
  let x = n;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(i > 0 && x < 10 ? 1 : 0)} ${units[i]}`;
}
function fmtSince(v?: string): string {
  if (!v) return '—';
  // ActiveEnterTimestamp e.g. "Tue 2026-08-18 14:00:00 UTC" → "2026-08-18 14:00".
  const m = v.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  return m ? m[0] : '—';
}

export const containerShellCmd = (rt: ContainerRuntime, name: string) =>
  `${rt === 'none' ? 'docker' : rt} exec -it ${shellArg(name)} sh`;
export const containerLogsCmd = (rt: ContainerRuntime, name: string) =>
  `${rt === 'none' ? 'docker' : rt} logs -f --tail 200 ${shellArg(name)}`;
export const containerRestartCmd = (rt: ContainerRuntime, name: string) =>
  `${rt === 'none' ? 'docker' : rt} restart ${shellArg(name)}`;

export const serviceJournalCmd = (name: string) => `journalctl -u ${shellArg(name)} -f -n 200`;
export const serviceRestartCmd = (name: string) => `sudo systemctl restart ${shellArg(name)}`;
export const serviceToggleCmd = (name: string, active: boolean) =>
  `sudo systemctl ${active ? 'stop' : 'start'} ${shellArg(name)}`;
