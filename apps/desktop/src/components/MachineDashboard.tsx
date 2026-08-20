/**
 * Machine dashboard (Wave-1 Control-Center) — a machine's own view in the main area.
 *
 * Selecting a machine opens this instead of connecting: an overview plus contextual
 * cards Rite surfaces for that host — Overview, Port forwarding, and (agentless, over
 * an SSH exec channel) Containers and Services. One machine, one place — double-click
 * still connects; card actions open a terminal pane running the command.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from '../i18n/i18n';
import { StatusPastille } from './StatusPastille';
import { useHealth } from '../store/healthStore';
import type { ConnectionInfo } from '../store/connectionsStore';
import type { RemoteCommandOutput } from '../utils/backend';
import {
  CONTAINERS_CMD,
  SERVICES_CMD,
  type ContainerRow,
  type ContainerRuntime,
  type ServiceRow,
  parseContainers,
  parseServices,
  isRunning,
  containerShellCmd,
  containerLogsCmd,
  containerRestartCmd,
  serviceJournalCmd,
  serviceRestartCmd,
  serviceToggleCmd,
} from '../utils/machineProbe';

interface Props {
  connection: ConnectionInfo;
  // All readable connections — jump hosts are referenced by id, resolved to names here.
  connections: ConnectionInfo[];
  onConnect: (c: ConnectionInfo) => void;
  onEdit: (c: ConnectionInfo) => void;
  onForward: (c: ConnectionInfo) => void;
  // Run a one-shot detection command over SSH (agentless). Absent ⇒ cards hide.
  execRemote?: (c: ConnectionInfo, command: string) => Promise<RemoteCommandOutput>;
  // Open a terminal pane and run a command in it (Shell/Logs/Restart/Journal).
  onRunInPane: (c: ConnectionInfo, command: string) => void;
}

// Pinned containers are a per-machine, per-device favourite (localStorage — like
// lastUsed, no server involvement).
const PIN_KEY = 'rite.pinnedContainers';
function readPins(connId: string): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(PIN_KEY) || '{}') as Record<string, string[]>;
    return new Set(all[connId] ?? []);
  } catch {
    return new Set();
  }
}
function writePins(connId: string, pins: Set<string>): void {
  try {
    const all = JSON.parse(localStorage.getItem(PIN_KEY) || '{}') as Record<string, string[]>;
    all[connId] = [...pins];
    localStorage.setItem(PIN_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable — pins just won't persist; not fatal.
  }
}

/** Compact relative time for last use ("2h ago"), or "—" when never used. lastUsedAt is epoch seconds. */
function relTime(ts: number | null | undefined, justNow: string, never: string): string {
  if (!ts) return never;
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return justNow;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return `${Math.floor(d / 7)}w ago`;
}

/** Resolve the ProxyJump chain (jump → jump-of-jump → …) to hop names, cycle-guarded. */
function jumpChain(conn: ConnectionInfo, connections: ConnectionInfo[]): string[] {
  const byId = new Map(connections.map((c) => [c.id, c]));
  const out: string[] = [];
  const seen = new Set<string>();
  let j = conn.jump ?? null;
  while (j && !seen.has(j)) {
    seen.add(j);
    const hop = byId.get(j);
    if (!hop) break;
    out.push(hop.name);
    j = hop.jump ?? null;
  }
  return out;
}

function JumpGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="flex-none text-muted-foreground opacity-75"
    >
      <path d="M4 17c2.5-9 13.5-9 16 0" />
      <circle cx="4" cy="17" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="20" cy="17" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

function MachineIcon({ color }: { color?: string | null }) {
  return (
    <svg className="h-6 w-6 flex-none" style={{ color: color || undefined }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="5" width="18" height="6" rx="1.5" />
      <rect x="3" y="13" width="18" height="6" rx="1.5" />
      <path strokeLinecap="round" d="M6.5 8h.01M6.5 16h.01M17 8h1.5M17 16h1.5" />
    </svg>
  );
}

export function MachineDashboard({
  connection,
  connections,
  onConnect,
  onEdit,
  onForward,
  execRemote,
  onRunInPane,
}: Props) {
  const { t } = useTranslation();
  const active = useHealth((s) =>
    s.checking[connection.id] ? ('checking' as const) : s.results[connection.id]?.status,
  );
  const chain = jumpChain(connection, connections);
  const forwards = connection.forwards ?? [];
  const addr = `${connection.username}@${connection.hostname}:${connection.port}`;

  const overviewRows: [string, string][] = [
    [t('dash.address'), addr],
    [t('dash.auth'), connection.authType ?? 'password'],
    ...(chain.length ? ([[t('dash.jump'), chain.join(' › ')]] as [string, string][]) : []),
    [t('dash.lastUsed'), relTime(connection.lastUsedAt, t('dash.justNow'), t('dash.never'))],
  ];

  return (
    <div className="h-full overflow-y-auto bg-background px-5 py-4">
      {/* Header — identity, status, and the primary actions. */}
      <div className="flex items-center gap-3 border-b border-border pb-4">
        <span style={{ color: connection.color || undefined }}>
          <MachineIcon color={connection.color} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-base font-semibold">
            <span className="truncate">{connection.name}</span>
            {connection.jump && chain.length > 0 && (
              <span title={`via ${chain.join(' › ')}`}>
                <JumpGlyph />
              </span>
            )}
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground">{addr}</div>
        </div>
        <StatusPastille lastUsedAt={connection.lastUsedAt} active={active} />
        <div className="flex-1" />
        <button
          onClick={() => onEdit(connection)}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          {t('dash.edit')}
        </button>
        <button
          onClick={() => onConnect(connection)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
          {t('dash.connect')}
        </button>
      </div>

      {/* Card grid — Overview + Port forwarding + detected Containers/Services. */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Overview */}
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            <MachineIcon />
            {t('dash.overview')}
          </div>
          <div className="flex flex-col gap-1.5">
            {overviewRows.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="flex-none text-muted-foreground">{k}</span>
                <span className="truncate font-mono text-right">{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Port forwarding */}
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M4 9h13l-3.5-3.5M20 15H7l3.5 3.5" />
            </svg>
            {t('dash.portForwarding')}
            <div className="flex-1" />
            <button
              onClick={() => onForward(connection)}
              className="rounded border border-border px-2.5 py-1 text-xs hover:bg-muted"
            >
              {t('dash.manage')}
            </button>
          </div>
          {forwards.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('dash.noForwards')}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {forwards.map((f, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className="flex-none rounded border border-border px-1 text-[10px] font-semibold text-muted-foreground">
                    L
                  </span>
                  <span className="truncate font-mono text-xs">
                    127.0.0.1:{f.localPort} → {f.remoteHost}:{f.remotePort}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Containers + Services — agentless detection over SSH */}
        {execRemote && (
          <>
            <ContainersCard connection={connection} execRemote={execRemote} onRunInPane={onRunInPane} />
            <ServicesCard connection={connection} execRemote={execRemote} onRunInPane={onRunInPane} />
          </>
        )}
      </div>

      <p className="mt-4 text-[11px] text-muted-foreground">{t('dash.detectNote')}</p>
    </div>
  );
}

// --- shared card chrome -----------------------------------------------------

function CardShell({
  icon,
  title,
  badge,
  actions,
  children,
}: {
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
        {badge}
        <div className="flex-1" />
        {actions}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded border border-border text-xs">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`px-2 py-0.5 ${v === value ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function RefreshBtn({ busy, onClick, label }: { busy: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={label}
      aria-label={label}
      className="rounded border border-border p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
    >
      <svg className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M20 9a8 8 0 00-14.3-3.3L4 9m0 6a8 8 0 0014.3 3.3L20 15" />
      </svg>
    </button>
  );
}

const Dot = ({ up }: { up: boolean }) => (
  <span className={`h-1.5 w-1.5 flex-none rounded-full ${up ? 'bg-green-500' : 'bg-muted-foreground/50'}`} />
);

const RowBtn = ({
  label,
  onClick,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title ?? label}
    className="flex-none rounded border border-border px-1.5 py-0.5 text-xs hover:bg-muted disabled:opacity-40"
  >
    {label}
  </button>
);

// --- Containers card --------------------------------------------------------

function ContainersCard({
  connection,
  execRemote,
  onRunInPane,
}: {
  connection: ConnectionInfo;
  execRemote: (c: ConnectionInfo, command: string) => Promise<RemoteCommandOutput>;
  onRunInPane: (c: ConnectionInfo, command: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ContainerRow[]>([]);
  const [runtime, setRuntime] = useState<ContainerRuntime>('none');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<'live' | 'pinned'>('live');
  const [pins, setPins] = useState<Set<string>>(() => readPins(connection.id));

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const out = await execRemote(connection, CONTAINERS_CMD);
      const parsed = parseContainers(out.stdout);
      setRuntime(parsed.runtime);
      setRows(parsed.rows);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setLoaded(true);
    }
  }, [connection, execRemote]);

  useEffect(() => {
    // Defer out of the effect body so the initial load's setState isn't synchronous.
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);

  const togglePin = (name: string) => {
    setPins((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      writePins(connection.id, next);
      return next;
    });
  };

  const visible = rows.filter((c) => mode === 'live' || pins.has(c.name));

  return (
    <CardShell
      icon={
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <rect x="3" y="10" width="4" height="4" rx="0.5" />
          <rect x="8" y="10" width="4" height="4" rx="0.5" />
          <rect x="13" y="10" width="4" height="4" rx="0.5" />
          <rect x="8" y="6" width="4" height="3.5" rx="0.5" />
          <path strokeLinecap="round" d="M3 16c3 2 12 2 15-1.5" />
        </svg>
      }
      title={t('dash.containers')}
      badge={runtime !== 'none' ? <span className="rounded border border-border px-1 text-[10px] uppercase text-muted-foreground">{runtime}</span> : undefined}
      actions={
        <div className="flex items-center gap-1.5">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[['live', t('dash.modeLive')], ['pinned', t('dash.modePinned')]]}
          />
          <RefreshBtn busy={busy} onClick={() => void refresh()} label={t('dash.refresh')} />
        </div>
      }
    >
      {err ? (
        <p className="text-xs text-red-500">{t('dash.probeError', { err })}</p>
      ) : !loaded ? (
        <p className="text-xs text-muted-foreground">{t('dash.detecting')}</p>
      ) : runtime === 'none' ? (
        <p className="text-xs text-muted-foreground">{t('dash.noRuntime')}</p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">{mode === 'live' ? t('dash.noContainers') : t('dash.noPinned')}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {visible.map((c) => {
            const up = isRunning(c);
            return (
              <div key={c.name} className="flex items-center gap-2">
                <Dot up={up} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 text-sm font-medium">
                    <span className="truncate">{c.name}</span>
                    <button
                      onClick={() => togglePin(c.name)}
                      title={pins.has(c.name) ? t('dash.unpin') : t('dash.pin')}
                      className={`flex-none ${pins.has(c.name) ? 'text-yellow-500' : 'text-muted-foreground/40 hover:text-muted-foreground'}`}
                    >
                      ★
                    </button>
                  </div>
                  <code className="block truncate text-[11px] text-muted-foreground">
                    {c.image}
                    {c.ports ? ` · ${c.ports}` : ''}
                  </code>
                </div>
                <RowBtn label={t('dash.shell')} disabled={!up} title={containerShellCmd(runtime, c.name)} onClick={() => onRunInPane(connection, containerShellCmd(runtime, c.name))} />
                <RowBtn label={t('dash.logs')} title={containerLogsCmd(runtime, c.name)} onClick={() => onRunInPane(connection, containerLogsCmd(runtime, c.name))} />
                <RowBtn label="↻" title={containerRestartCmd(runtime, c.name)} onClick={() => onRunInPane(connection, containerRestartCmd(runtime, c.name))} />
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">{t('dash.containersHint')}</p>
    </CardShell>
  );
}

// --- Services card ----------------------------------------------------------

function ServicesCard({
  connection,
  execRemote,
  onRunInPane,
}: {
  connection: ConnectionInfo;
  execRemote: (c: ConnectionInfo, command: string) => Promise<RemoteCommandOutput>;
  onRunInPane: (c: ConnectionInfo, command: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<'all' | 'active' | 'failed'>('all');

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const out = await execRemote(connection, SERVICES_CMD);
      setRows(parseServices(out.stdout));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setLoaded(true);
    }
  }, [connection, execRemote]);

  useEffect(() => {
    // Defer out of the effect body so the initial load's setState isn't synchronous.
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);

  const failed = rows.filter((s) => s.active === 'failed').length;
  const visible = rows.filter(
    (s) => filter === 'all' || (filter === 'failed' && s.active === 'failed') || (filter === 'active' && s.active === 'active'),
  );

  return (
    <CardShell
      icon={
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      }
      title={t('dash.services')}
      badge={failed > 0 ? <span className="rounded border border-red-500 px-1 text-[10px] text-red-500">{t('dash.nFailed', { n: failed })}</span> : undefined}
      actions={
        <div className="flex items-center gap-1.5">
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[['all', t('dash.filterAll')], ['active', t('dash.filterActive')], ['failed', t('dash.filterFailed')]]}
          />
          <RefreshBtn busy={busy} onClick={() => void refresh()} label={t('dash.refresh')} />
        </div>
      }
    >
      {err ? (
        <p className="text-xs text-red-500">{t('dash.probeError', { err })}</p>
      ) : !loaded ? (
        <p className="text-xs text-muted-foreground">{t('dash.detecting')}</p>
      ) : loaded && rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('dash.noSystemd')}</p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('dash.noServices')}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {visible.map((s) => {
            const on = s.active === 'active';
            return (
              <div key={s.name} className="flex items-center gap-2">
                <Dot up={on} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{s.name}</div>
                  <code className="block truncate text-[11px] text-muted-foreground">
                    {s.description} · <span className={s.active === 'failed' ? 'text-red-500' : ''}>{s.active} ({s.sub})</span>
                  </code>
                </div>
                <RowBtn label="↻" title={serviceRestartCmd(s.name)} onClick={() => onRunInPane(connection, serviceRestartCmd(s.name))} />
                <RowBtn label={on ? t('dash.stop') : t('dash.start')} title={serviceToggleCmd(s.name, on)} onClick={() => onRunInPane(connection, serviceToggleCmd(s.name, on))} />
                <RowBtn label={t('dash.journal')} title={serviceJournalCmd(s.name)} onClick={() => onRunInPane(connection, serviceJournalCmd(s.name))} />
              </div>
            );
          })}
        </div>
      )}
    </CardShell>
  );
}
