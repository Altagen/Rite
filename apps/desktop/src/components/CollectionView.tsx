/**
 * Collection view (ADR 0016, transposed from design/mock) — a collection opened
 * in the main area as cards/list. Header (icon, name, role, member/share button),
 * a toolbar (filter, sort, grid/list, + Machine), and the machines grouped by the
 * collection's shared sub-folders. Purely presentational over the connections the
 * source already decrypted; actions bubble up to the workspace.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { type ConnectionInfo } from '../store/connectionsStore';

const ROOT = ' root';

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
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9 5 9-5M3 16.5l9 5 9-5" />
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
  onNewMachine: () => void;
  onNewFolder?: () => void; // absent when the viewer can't write the collection header
  onImport: () => void;
  onOpenMembers?: () => void; // absent when membership isn't editable from here
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'name' | 'host' | 'lastUsed'>('name');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
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

  // Group the shown machines by their shared sub-folder; loose ones at the root.
  // Declared folders are included even when empty (so a just-created one shows).
  const groups = useMemo(() => {
    const map = new Map<string, ConnectionInfo[]>();
    for (const f of folders ?? []) if (!map.has(f.name)) map.set(f.name, []);
    for (const m of shown) {
      const key = m.folder || ROOT;
      (map.get(key) ?? map.set(key, []).get(key)!).push(m);
    }
    const folderKeys = [...map.keys()].filter((k) => k !== ROOT).sort((a, b) => a.localeCompare(b));
    return { folders: folderKeys, map, root: map.get(ROOT) ?? [] };
  }, [shown, folders]);

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
        <span className="flex-1" />
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

  const sectionHead = (label: string, n: number, key?: string) => {
    const c = key ? folderColor.get(key) : null;
    return (
      <div className="mb-2 mt-3 flex items-center gap-2">
        <svg className="h-4 w-4 text-muted-foreground" style={{ color: c || undefined }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
        </svg>
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{n}</span>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col p-3">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 pb-2">
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
            onClick={onNewFolder}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            title="New shared folder"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            </svg>
            Folder
          </button>
        )}
        {canWrite && (
          <button
            onClick={onNewMachine}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
            {t('connections.newConnection') !== 'connections.newConnection' ? t('connections.newConnection') : 'Machine'}
          </button>
        )}
      </div>

      {/* Machines */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {machines.length === 0 ? 'No machines in this collection yet.' : 'No machines match your filter.'}
          </div>
        ) : groups.folders.length > 0 ? (
          <>
            {groups.folders.map((f) => (
              <div key={f}>
                {sectionHead(f, groups.map.get(f)!.length, f)}
                {grid(groups.map.get(f)!)}
              </div>
            ))}
            {groups.root.length > 0 && (
              <>
                {sectionHead('(root)', groups.root.length)}
                {grid(groups.root)}
              </>
            )}
          </>
        ) : (
          grid(shown)
        )}
      </div>
    </div>
  );
}
