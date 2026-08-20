/**
 * Machine dashboard (Wave-1 Control-Center) — a machine's own view in the main area.
 *
 * Selecting a machine opens this instead of connecting: an overview plus contextual
 * cards Rite surfaces for that host. This shell ships the Overview and Port-forwarding
 * cards; Containers and Services (agentless, over the SSH session) land next. One
 * machine, one place — double-click still connects.
 */

import { useTranslation } from '../i18n/i18n';
import { StatusPastille } from './StatusPastille';
import { useHealth } from '../store/healthStore';
import type { ConnectionInfo } from '../store/connectionsStore';

interface Props {
  connection: ConnectionInfo;
  // All readable connections — jump hosts are referenced by id, resolved to names here.
  connections: ConnectionInfo[];
  onConnect: (c: ConnectionInfo) => void;
  onEdit: (c: ConnectionInfo) => void;
  onForward: (c: ConnectionInfo) => void;
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

export function MachineDashboard({ connection, connections, onConnect, onEdit, onForward }: Props) {
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

      {/* Card grid — Overview + Port forwarding (containers/services land next). */}
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
      </div>

      <p className="mt-4 text-[11px] text-muted-foreground">{t('dash.detectNote')}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{t('dash.soonNote')}</p>
    </div>
  );
}
