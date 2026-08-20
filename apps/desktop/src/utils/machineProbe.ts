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

/** A shell-quoted-safe unit/name is assumed (systemd/container names have no spaces). */
export const containerShellCmd = (rt: ContainerRuntime, name: string) =>
  `${rt === 'none' ? 'docker' : rt} exec -it ${name} sh`;
export const containerLogsCmd = (rt: ContainerRuntime, name: string) =>
  `${rt === 'none' ? 'docker' : rt} logs -f --tail 200 ${name}`;
export const containerRestartCmd = (rt: ContainerRuntime, name: string) =>
  `${rt === 'none' ? 'docker' : rt} restart ${name}`;

export const serviceJournalCmd = (name: string) => `journalctl -u ${name} -f -n 200`;
export const serviceRestartCmd = (name: string) => `sudo systemctl restart ${name}`;
export const serviceToggleCmd = (name: string, active: boolean) =>
  `sudo systemctl ${active ? 'stop' : 'start'} ${name}`;
