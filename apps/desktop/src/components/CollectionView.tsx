/**
 * Collection view (ADR 0016, transposed from design/mock) — a collection opened
 * in the main area as cards/list. Header (icon, name, role, member/share button),
 * a toolbar (filter, sort, grid/list, + Machine), and the machines grouped by the
 * collection's shared sub-folders. Purely presentational over the connections the
 * source already decrypted; actions bubble up to the workspace.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { type ConnectionInfo } from '../store/connectionsStore';
import { useServerSession } from '../store/serverSessionStore';
import { useHealth } from '../store/healthStore';
import { StatusPastille } from './StatusPastille';

/** Compact relative time for a machine's last use ("2h ago"), or "—" when never used. */
function relTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return `${Math.floor(d / 7)}w ago`;
}

function CollectionIcon({ color }: { color?: string | null }) {
  return (
    <svg className="h-5 w-5 flex-none" style={{ color: color || undefined }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 5-9 5-9-5 9-5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 12L12 17l8.5-5M3.5 16L12 21l8.5-5" />
    </svg>
  );
}

function MachineIcon({ color }: { color?: string | null }) {
  return (
    <svg className="h-4 w-4 flex-none" style={{ color: color || undefined }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="5" width="18" height="6" rx="1.5" />
      <rect x="3" y="13" width="18" height="6" rx="1.5" />
      <path strokeLinecap="round" d="M6.5 8h.01M6.5 16h.01M17 8h1.5M17 16h1.5" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
    </svg>
  );
}

export function CollectionView({
  name,
  color,
  role,
  machines,
  folders,
  canWrite,
  isPersonal,
  onConnect,
  onEdit,
  onMove,
  onNewMachine,
  onNewFolder,
  onImport,
  onOpenMembers,
}: {
  name: string;
  color?: string | null;
  role?: string | null;
  machines: ConnectionInfo[];
  folders?: { name: string; color: string | null }[]; // declared sub-folders (show empty)
  canWrite: boolean;
  isPersonal?: boolean; // the personal collection can't be shared
  onConnect: (c: ConnectionInfo) => void;
  onEdit: (c: ConnectionInfo) => void;
  onMove?: (c: ConnectionInfo) => void; // move the machine to another folder
  onNewMachine: (folderPath?: string) => void; // creates in the folder you're browsing
  onNewFolder?: (parentPath?: string) => void; // creates a sub-folder of the current path
  onImport: () => void;
  onOpenMembers?: () => void; // absent when membership isn't editable from here
}) {
  const { t } = useTranslation();
  const { mode } = useServerSession();
  // Granular store slices (stable action ref; subscribe only to what we render).
  const checkNow = useHealth((s) => s.checkNow);
  const checking = useHealth((s) => s.checking);
  const results = useHealth((s) => s.results);
  const notice = useHealth((s) => s.notice);
  const clearNotice = useHealth((s) => s.clearNotice);
  // Active probing is governed (ADR 0017): the Check button appears only when the server
  // allows on-demand/full/client-choice active checks.
  const activeMode = mode?.healthcheck?.active ?? 'off';
  const minInterval = mode?.healthcheck?.minInterval ?? 60;
  const canProbe = activeMode === 'on-demand' || activeMode === 'full' || activeMode === 'client-choice';
  const activeFor = (id: string) =>
    checking[id] ? ('checking' as const) : results[id]?.status;
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'name' | 'host' | 'lastUsed'>('name');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [path, setPath] = useState(''); // the folder currently being browsed ('' = root)
  const folderColor = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const f of folders ?? []) m.set(f.name, f.color);
    return m;
  }, [folders]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? machines.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.hostname.toLowerCase().includes(q) ||
            m.username.toLowerCase().includes(q),
        )
      : machines;
    return [...filtered].sort((a, b) => {
      if (sort === 'host') return a.hostname.localeCompare(b.hostname);
      if (sort === 'lastUsed') return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
      return a.name.localeCompare(b.name);
    });
  }, [machines, filter, sort]);

  const filtering = filter.trim() !== '';

  // Every folder path in the collection (declared + inferred from machines + every
  // ancestor), so we can walk the tree one level at a time.
  const allPaths = useMemo(() => {
    const s = new Set<string>();
    const add = (p: string) => {
      const segs = p.split('/');
      for (let i = 1; i <= segs.length; i++) s.add(segs.slice(0, i).join('/'));
    };
    for (const f of folders ?? []) if (f.name) add(f.name);
    for (const m of machines) if (m.folder) add(m.folder);
    return s;
  }, [folders, machines]);

  const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  // Guard against a stale path (e.g. the folder was deleted) — fall back to root.
  const cur = path && allPaths.has(path) ? path : '';

  // Drill-in: the direct sub-folders and the machines that live at `cur`.
  const subfolders = useMemo(
    () => [...allPaths].filter((p) => parentOf(p) === cur).sort((a, b) => a.localeCompare(b)),
    [allPaths, cur],
  );
  const here = useMemo(() => shown.filter((m) => (m.folder || '') === cur), [shown, cur]);
  // Machines that opt out of active probing (ADR 0017, hc===false) are never probed.
  const probeHere = useMemo(() => here.filter((m) => m.hc !== false), [here]);
  const checkingHere = probeHere.some((m) => checking[m.id]);

  // Background polling (ADR 0017 "full"): auto-check the (probeable) machines in view on a
  // floor-bounded cadence. On-demand/off don't poll — only an explicit Check probes. The
  // server also enforces its own cooldown, so this stays within the min-interval guardrail.
  const probeKey = probeHere.map((m) => m.id).join(',');
  useEffect(() => {
    if (activeMode !== 'full' || probeHere.length === 0) return;
    const targets = probeHere.slice(0, 64).map((m) => ({ id: m.id, host: m.hostname, port: m.port }));
    void checkNow(targets);
    const id = setInterval(() => void checkNow(targets), Math.max(15, minInterval) * 1000);
    return () => clearInterval(id);
    // probeKey captures the visible probeable set; checkNow is a stable store action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMode, minInterval, probeKey, checkNow]);
  const countUnder = (p: string) =>
    machines.filter((m) => m.folder === p || (m.folder || '').startsWith(`${p}/`)).length;

  const card = (c: ConnectionInfo) => (
    <div
      key={c.id}
      onDoubleClick={() => onConnect(c)}
      className={`group cursor-pointer rounded-xl border border-border bg-card p-3.5 transition hover:-translate-y-0.5 hover:border-primary ${
        layout === 'list' ? 'flex items-center gap-3' : ''
      }`}
    >
      <div className={`flex items-center gap-2 ${layout === 'list' ? 'flex-1 min-w-0' : 'mb-2'}`}>
        <MachineIcon color={c.color} />
        <span className="truncate font-semibold" title={c.name}>
          {c.name}
        </span>
        <StatusPastille lastUsedAt={c.lastUsedAt} active={activeFor(c.id)} />
        <span className="flex-1" />
        {onMove && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMove(c);
            }}
            className="rounded p-1 opacity-0 hover:bg-muted group-hover:opacity-100"
            title="Move to folder…"
            aria-label="Move to folder"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v2M3 7v11a2 2 0 002 2h6M16 16l3 3m0 0l-3 3m3-3h-8" />
            </svg>
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit(c);
          }}
          className="rounded p-1 opacity-0 hover:bg-muted group-hover:opacity-100"
          title={t('connections.edit')}
          aria-label="Edit machine"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
          </svg>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onConnect(c);
          }}
          className="rounded p-1 text-primary hover:bg-primary/10"
          title={t('connections.connect')}
          aria-label="Connect"
        >
          <PlayIcon />
        </button>
      </div>
      <div className="truncate font-mono text-xs text-muted-foreground">
        {c.username}@{c.hostname}:{c.port}
      </div>
      <div className={`flex items-center gap-1 text-[11px] text-muted-foreground ${layout === 'list' ? '' : 'mt-1'}`}>
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>{relTime(c.lastUsedAt)} · ssh</span>
      </div>
    </div>
  );

  const grid = (list: ConnectionInfo[]) => (
    <div
      className={
        layout === 'grid'
          ? 'grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(215px,1fr))]'
          : 'flex flex-col gap-2'
      }
    >
      {list.map(card)}
    </div>
  );

  const eyebrow = (label: string) => (
    <div className="mb-2 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground first:mt-0">{label}</div>
  );

  const emptyNote = (msg: string) => (
    <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">{msg}</div>
  );

  // A clickable folder tile — enters the folder on click.
  const folderTile = (p: string) => {
    const nm = p.split('/').pop() ?? p;
    const c = folderColor.get(p) ?? null;
    return (
      <button
        key={p}
        onClick={() => setPath(p)}
        className="group flex items-center gap-2 rounded-xl border border-border bg-card p-3.5 text-left transition hover:-translate-y-0.5 hover:border-primary"
        title={`Open “${nm}”`}
      >
        <svg className={`h-4 w-4 flex-none ${c ? '' : 'text-muted-foreground'}`} style={c ? { color: c } : undefined} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
        </svg>
        <span className="truncate font-semibold" title={nm}>{nm}</span>
        <span className="flex-1" />
        <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{countUnder(p)}</span>
        <svg className="h-4 w-4 flex-none text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
        </svg>
      </button>
    );
  };

  // Breadcrumb: collection root ▸ each ancestor of the current folder.
  const breadcrumb = () => {
    const segs = cur ? cur.split('/') : [];
    return (
      <div className="mb-1 flex flex-wrap items-center gap-0.5 text-sm">
        <button
          onClick={() => setPath('')}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted ${cur ? 'text-muted-foreground' : 'font-semibold'}`}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9-9 9 9M5 10v10h14V10" />
          </svg>
          {name}
        </button>
        {segs.map((s, i) => {
          const prefix = segs.slice(0, i + 1).join('/');
          const last = i === segs.length - 1;
          return (
            <span key={prefix} className="flex items-center gap-0.5">
              <span className="text-muted-foreground">▸</span>
              <button
                onClick={() => setPath(prefix)}
                disabled={last}
                className={`rounded px-1.5 py-0.5 ${last ? 'font-semibold' : 'text-muted-foreground hover:bg-muted'}`}
              >
                {s}
              </button>
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col p-3">
      {/* Header — fixed min-height so the toolbar sits at the same place whether or
          not the right-hand Members button is present (e.g. the Personal view). */}
      <div className="flex min-h-[38px] flex-wrap items-center gap-3 pb-2">
        <CollectionIcon color={color} />
        <h2 className="text-lg font-semibold">{name}</h2>
        {isPersonal ? (
          <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Personal
          </span>
        ) : (
          role && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {role}
            </span>
          )
        )}
        <span className="text-sm text-muted-foreground">
          {machines.length} {machines.length === 1 ? 'machine' : 'machines'}
        </span>
        <span className="flex-1" />
        {canProbe && probeHere.length > 0 && (
          <button
            onClick={() =>
              void checkNow(
                probeHere.slice(0, 64).map((m) => ({ id: m.id, host: m.hostname, port: m.port })),
              )
            }
            disabled={checkingHere}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
            title="Check machine status now"
          >
            <svg
              className={`h-4 w-4 ${checkingHere ? 'animate-spin' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 9a8 8 0 00-14.3-3.3L4 9m0 6a8 8 0 0014.3 3.3L20 15" />
            </svg>
            {checkingHere ? 'Checking…' : 'Check'}
          </button>
        )}
        {onOpenMembers && (
          <button
            onClick={onOpenMembers}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zm6 0a4 4 0 00-1-7.75" />
            </svg>
            Members
          </button>
        )}
      </div>

      {/* Governed-probing notice (probing disabled / rate-limited) — calm, dismissable. */}
      {notice && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          <span className="flex-1">{notice}</span>
          <button onClick={clearNotice} className="font-medium hover:underline" aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <div className="flex min-w-0 flex-1 max-w-[240px] items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5">
          <svg className="h-4 w-4 flex-none text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" />
          </svg>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('common.filter') !== 'common.filter' ? t('common.filter') : 'Filter…'}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as 'name' | 'host' | 'lastUsed')}
          className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
        >
          <option value="name">Name</option>
          <option value="host">Host</option>
          <option value="lastUsed">Last used</option>
        </select>
        <button
          onClick={() => setLayout('grid')}
          className={`rounded-md border border-border p-1.5 ${layout === 'grid' ? 'text-primary' : 'text-muted-foreground'}`}
          title="Grid"
          aria-label="Grid view"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <rect x="4" y="4" width="7" height="7" rx="1.5" />
            <rect x="13" y="4" width="7" height="7" rx="1.5" />
            <rect x="4" y="13" width="7" height="7" rx="1.5" />
            <rect x="13" y="13" width="7" height="7" rx="1.5" />
          </svg>
        </button>
        <button
          onClick={() => setLayout('list')}
          className={`rounded-md border border-border p-1.5 ${layout === 'list' ? 'text-primary' : 'text-muted-foreground'}`}
          title="List"
          aria-label="List view"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
          </svg>
        </button>
        <span className="flex-1" />
        {canWrite && (
          <button
            onClick={onImport}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            title="Import from SSH config"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12M8 11l4 4 4-4M5 21h14" />
            </svg>
            Import
          </button>
        )}
        {canWrite && onNewFolder && (
          <button
            onClick={() => onNewFolder(cur || undefined)}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            title={cur ? `New sub-folder in “${cur.split('/').pop()}”` : 'New shared folder'}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            </svg>
            Folder
          </button>
        )}
        {canWrite && (
          <button
            onClick={() => onNewMachine(cur || undefined)}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            title={cur ? `New machine in “${cur.split('/').pop()}”` : 'New machine'}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
            {t('connections.newConnection') !== 'connections.newConnection' ? t('connections.newConnection') : 'Machine'}
          </button>
        )}
      </div>

      {/* Machines. While filtering, results are flat across every folder. Otherwise
          we drill in one folder at a time: sub-folder tiles + the machines here. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtering ? (
          shown.length > 0 ? (
            <>
              {eyebrow(`Results · ${shown.length}`)}
              {grid(shown)}
            </>
          ) : (
            emptyNote('No machines match your filter.')
          )
        ) : (
          <>
            {breadcrumb()}
            {subfolders.length === 0 && here.length === 0 ? (
              emptyNote(cur ? 'This folder is empty.' : 'No machines in this collection yet.')
            ) : (
              <>
                {subfolders.length > 0 && (
                  <>
                    {eyebrow('Folders')}
                    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(215px,1fr))]">
                      {subfolders.map(folderTile)}
                    </div>
                  </>
                )}
                {here.length > 0 && (
                  <>
                    {subfolders.length > 0 && eyebrow('Machines')}
                    {grid(here)}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
