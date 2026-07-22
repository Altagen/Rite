/**
 * Library sidebar (ADR 0014 — navigation skeleton, transposed from design/mock).
 *
 * A tree of the saved connections in the target model (design/mock): personal
 * folders → machines, then first-class **collection** nodes (ADR 0016) — each with
 * its own icon, colour and role badge — whose machines are folder-grouped inside.
 * Personal machines carry no `collectionId`; a machine with one is rendered under
 * its collection instead of the personal tree. Ungrouped machines sit at the root.
 * Same props as the old flat list so it drops into the workspace unchanged:
 * double-click a machine to connect, or use its menu (connect / edit / delete).
 */

import { useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { type ConnectionInfo } from '../store/connectionsStore';
import { PERSONAL_COLLECTION_ID } from '../store/accountsConnectionsSource';
import { IconPlay, IconMore, IconEdit, IconUsers } from './icons';

interface LibrarySidebarProps {
  connections: ConnectionInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (connection: ConnectionInfo) => void;
  onDelete: (connection: ConnectionInfo) => void;
  onConnect: (connection: ConnectionInfo) => void;
  // ADR 0016: open a collection in the main area (accounts context only).
  onOpenCollection?: (collectionId: string) => void;
  openCollectionId?: string | null;
  query?: string; // search text (controlled by the sidebar chrome above the tree)
  // Every readable collection (incl. empty ones) + its declared sub-folders, so a
  // just-created collection/folder shows before it has machines. Absent in local
  // context ⇒ derive nodes from connections.
  collections?: {
    id: string;
    name: string;
    color: string | null;
    role: string;
    folders: { name: string; color: string | null }[];
    memberCount: number;
  }[];
  // Collection node actions (accounts context). Rename/Delete are owner-only,
  // gated by the caller; the sidebar shows them only when a handler is provided.
  onNewMachineInCollection?: (collectionId: string) => void;
  onOpenMembers?: (collectionId: string) => void;
  onRenameCollection?: (collectionId: string, name: string, color: string | null) => void;
  onDeleteCollection?: (collectionId: string, name: string) => void;
  // Top-level personal folders that organise collections (ADR 0016 view hierarchy).
  libraryFolders?: { id: string; name: string; color: string | null }[];
  collectionPlacement?: Record<string, string>; // collectionId → folderId
  onRenameLibraryFolder?: (id: string, name: string, color: string | null) => void;
  onDeleteLibraryFolder?: (id: string, name: string) => void;
  onMoveCollection?: (collectionId: string, name: string) => void;
}

/** A top-level personal folder node that wraps the collections placed in it. */
function LibraryFolderNode({
  id,
  name,
  color,
  count,
  open,
  onToggle,
  onRename,
  onDelete,
  children,
}: {
  id: string;
  name: string;
  color: string | null;
  count: number;
  open: boolean;
  onToggle: () => void;
  onRename?: (id: string) => void;
  onDelete?: (id: string) => void;
  children: React.ReactNode;
}) {
  const [showMenu, setShowMenu] = useState(false);
  return (
    <div>
      <div className="m-tnode">
        <button onClick={onToggle} className="m-ca" aria-label={open ? 'Collapse' : 'Expand'}>
          <Chevron open={open} />
        </button>
        <FolderIcon color={color} />
        <button onClick={onToggle} className="m-nm text-left" title={name}>
          {name}
        </button>
        <div className="m-acts relative" style={showMenu ? { opacity: 1 } : undefined}>
          <button onClick={(e) => { e.stopPropagation(); setShowMenu((v) => !v); }} aria-label="Folder menu">
            <MoreIcon />
          </button>
          {showMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
              <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded border border-border bg-background shadow-lg">
                <button onClick={() => { setShowMenu(false); onRename?.(id); }} className="w-full px-3 py-2 text-left text-sm hover:bg-muted">
                  Rename…
                </button>
                <button onClick={() => { setShowMenu(false); onDelete?.(id); }} className="w-full px-3 py-2 text-left text-sm text-red-500 hover:bg-muted">
                  Delete folder
                </button>
              </div>
            </>
          )}
        </div>
        <span className="m-cnt">{count}</span>
      </div>
      {open && <div className="ml-3">{children}</div>}
    </div>
  );
}

function MoreIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** A first-class collection node with hover actions (＋ machine · ⋯ manage). */
function CollectionNode({
  cid,
  name,
  color,
  role,
  count,
  open,
  active,
  onOpen,
  onToggle,
  onNewMachine,
  onOpenMembers,
  onRename,
  onDelete,
  onMove,
  isPersonal,
  memberCount = 1,
  children,
}: {
  cid: string;
  name: string;
  color?: string | null;
  role?: string | null;
  count: number;
  open: boolean;
  active: boolean;
  memberCount?: number;
  onOpen: () => void;
  onToggle: () => void;
  onNewMachine?: (id: string) => void;
  onOpenMembers?: (id: string) => void;
  onRename?: (id: string) => void;
  onDelete?: (id: string) => void;
  onMove?: (id: string) => void;
  isPersonal?: boolean; // the synthetic vault-backed "Personal" — not shareable
  children: React.ReactNode;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const canWrite = role === 'owner' || role === 'editor';
  const canManage = role === 'owner';

  return (
    <div>
      <div onClick={onOpen} className={`m-tnode ${active ? 'sel' : ''}`}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="m-ca"
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          <Chevron open={open} />
        </button>
        <CollectionIcon color={color} />
        <span className="m-nm" title={name}>
          {name}
        </span>
        {!isPersonal && memberCount > 1 && (
          <span className="m-mc" title={`${memberCount} members`}>
            <IconUsers className="h-3 w-3" />
            {memberCount}
          </span>
        )}
        <div className="m-acts" style={showMenu ? { opacity: 1 } : undefined}>
          {canWrite && onNewMachine && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onNewMachine(cid);
              }}
              title="New machine here"
              aria-label="New machine in collection"
            >
              <PlusIcon />
            </button>
          )}
          {!isPersonal && (
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu((v) => !v);
              }}
              aria-label="Collection menu"
            >
              <MoreIcon />
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setShowMenu(false); }} />
                <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded border border-border bg-background shadow-lg">
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowMenu(false); onOpenMembers?.(cid); }}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    Members &amp; sharing…
                  </button>
                  {onMove && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowMenu(false); onMove(cid); }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                    >
                      Move to folder…
                    </button>
                  )}
                  {canManage && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowMenu(false); onRename?.(cid); }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                    >
                      Rename…
                    </button>
                  )}
                  {canManage && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowMenu(false); onDelete?.(cid); }}
                      className="w-full px-3 py-2 text-left text-sm text-red-500 hover:bg-muted"
                    >
                      Delete collection
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          )}
        </div>
        <span className="m-cnt">{count}</span>
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}

const ROOT = ' root'; // sentinel key for ungrouped machines

function FolderIcon({ color }: { color?: string | null }) {
  return (
    <svg
      className={`h-4 w-4 flex-none ${color ? '' : 'text-muted-foreground'}`}
      style={color ? { color } : undefined}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </svg>
  );
}

/** Collection node icon — stacked layers, distinct from a folder and a machine. */
function CollectionIcon({ color }: { color?: string | null }) {
  return (
    <svg className="h-4 w-4 flex-none" style={{ color: color || undefined }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 5-9 5-9-5 9-5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9 5 9-5M3 16.5l9 5 9-5" />
    </svg>
  );
}

/** A collection member's role, as a small pill. */
function MachineIcon({ color }: { color?: string | null }) {
  return (
    <svg className="h-4 w-4 flex-none" style={{ color: color || undefined }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="5" width="18" height="6" rx="1.5" />
      <rect x="3" y="13" width="18" height="6" rx="1.5" />
      <path strokeLinecap="round" d="M6.5 8h.01M6.5 16h.01M17 8h1.5M17 16h1.5" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`h-3.5 w-3.5 flex-none text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
    </svg>
  );
}

function MachineRow({
  connection,
  isSelected,
  depth,
  onSelect,
  onEdit,
  onDelete,
  onConnect,
}: {
  connection: ConnectionInfo;
  isSelected: boolean;
  depth: number;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onConnect: () => void;
}) {
  const { t } = useTranslation();
  const [showMenu, setShowMenu] = useState(false);

  return (
    <div
      className={`m-tnode leaf select-none ${isSelected ? 'sel' : ''}`}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      onClick={onSelect}
      onDoubleClick={onConnect}
    >
      <span className="m-ca" />
      <MachineIcon color={connection.color} />
      <div className="min-w-0 flex-1">
        <div className="m-nm" title={connection.name}>
          {connection.name}
        </div>
        <div className="m-lsub">
          {connection.username}@{connection.hostname}:{connection.port}
        </div>
      </div>

      <div className="m-acts relative" style={showMenu ? { opacity: 1 } : undefined}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onConnect();
          }}
          aria-label="Connect"
          title={t('connections.connect')}
        >
          <IconPlay className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          aria-label="Edit"
          title={t('connections.edit')}
        >
          <IconEdit className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowMenu((v) => !v);
          }}
          aria-label="Connection menu"
        >
          <IconMore className="h-3.5 w-3.5" />
        </button>
        {showMenu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
            <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded border border-border bg-background shadow-lg">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(false);
                  onConnect();
                }}
                className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
              >
                {t('connections.connect')}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(false);
                  onEdit();
                }}
                className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
              >
                {t('connections.edit')}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(false);
                  onDelete();
                }}
                className="w-full px-4 py-2 text-left text-sm text-red-500 hover:bg-muted"
              >
                {t('connections.delete')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function LibrarySidebar({
  connections,
  selectedId,
  onSelect,
  onEdit,
  onDelete,
  onConnect,
  onOpenCollection,
  openCollectionId,
  query = '',
  collections,
  onNewMachineInCollection,
  onOpenMembers,
  onRenameCollection,
  onDeleteCollection,
  libraryFolders,
  collectionPlacement,
  onRenameLibraryFolder,
  onDeleteLibraryFolder,
  onMoveCollection,
}: LibrarySidebarProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const isOpen = (key: string) => !collapsed.has(key);
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const machineRow = (c: ConnectionInfo, depth: number) => (
    <MachineRow
      key={c.id}
      connection={c}
      isSelected={selectedId === c.id}
      depth={depth}
      onSelect={() => onSelect(c.id)}
      onEdit={() => onEdit(c)}
      onDelete={() => onDelete(c)}
      onConnect={() => onConnect(c)}
    />
  );

  /** Render a set of machines grouped by their `folder`; ungrouped ones at baseDepth. */
  const renderFolderGroups = (
    machines: ConnectionInfo[],
    keyPrefix: string,
    baseDepth: number,
    declaredFolders?: { name: string }[],
  ) => {
    const groups = new Map<string, ConnectionInfo[]>();
    // Seed declared (possibly empty) folders so a just-created one shows.
    for (const f of declaredFolders ?? []) if (!groups.has(f.name)) groups.set(f.name, []);
    for (const c of machines) {
      const key = c.folder || ROOT;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
    }
    const folders = [...groups.keys()].filter((k) => k !== ROOT).sort((a, b) => a.localeCompare(b));
    const root = groups.get(ROOT) ?? [];
    return (
      <>
        {folders.map((folder) => {
          const key = `${keyPrefix}/folder/${folder}`;
          const open = isOpen(key);
          return (
            <div key={key}>
              <button
                onClick={() => toggle(key)}
                className="m-tnode w-full text-left"
                style={{ paddingLeft: `${8 + baseDepth * 16}px` }}
              >
                <span className="m-ca">
                  <Chevron open={open} />
                </span>
                <FolderIcon />
                <span className="m-nm">{folder}</span>
                <span className="m-cnt">{groups.get(folder)!.length}</span>
              </button>
              {open && <div>{groups.get(folder)!.map((c) => machineRow(c, baseDepth + 1))}</div>}
            </div>
          );
        })}
        {root.map((c) => machineRow(c, baseDepth))}
      </>
    );
  };

  // Client-side search across name / target / folder / collection.
  const q = query.trim().toLowerCase();
  const matches = (c: ConnectionInfo) =>
    !q ||
    c.name.toLowerCase().includes(q) ||
    c.hostname.toLowerCase().includes(q) ||
    c.username.toLowerCase().includes(q) ||
    (c.folder ?? '').toLowerCase().includes(q) ||
    (c.collectionName ?? '').toLowerCase().includes(q);
  const shown = connections.filter(matches);

  // Personal machines (no collection) vs collection-scoped machines (ADR 0016).
  const personal = shown.filter((c) => !c.collectionId);
  const byCollection = new Map<string, ConnectionInfo[]>();
  for (const c of shown) {
    if (!c.collectionId) continue;
    (byCollection.get(c.collectionId) ?? byCollection.set(c.collectionId, []).get(c.collectionId)!).push(c);
  }
  // Node list: prefer the full collection list (shows empty collections too); fall
  // back to deriving from the connections when the source doesn't provide one.
  const derived = () =>
    [...byCollection.keys()].map((id) => {
      const m = byCollection.get(id)![0];
      return {
        id,
        name: m.collectionName ?? 'Collection',
        color: m.collectionColor ?? null,
        role: m.collectionRole ?? 'owner',
        folders: [] as { name: string; color: string | null }[],
        memberCount: 1,
      };
    });
  const collectionNodes = (collections ?? derived())
    // When searching, hide collections with no matching machine.
    .filter((c) => !q || byCollection.has(c.id))
    .sort((a, b) => {
      if (a.id === PERSONAL_COLLECTION_ID) return -1;
      if (b.id === PERSONAL_COLLECTION_ID) return 1;
      return a.name.localeCompare(b.name);
    });

  const renderCollectionNode = (node: { id: string; name: string; color: string | null; role: string; folders: { name: string; color: string | null }[]; memberCount: number }) => {
    const cid = node.id;
    const machines = byCollection.get(cid) ?? [];
    const key = `col/${cid}`;
    const isPersonal = cid === PERSONAL_COLLECTION_ID;
    const canMove = !isPersonal && onMoveCollection && (libraryFolders?.length ?? 0) > 0;
    return (
      <CollectionNode
        key={key}
        cid={cid}
        name={node.name}
        color={node.color}
        role={node.role}
        count={machines.length}
        open={isOpen(key)}
        active={openCollectionId === cid}
        isPersonal={isPersonal}
        memberCount={node.memberCount}
        onOpen={() => onOpenCollection?.(cid)}
        onToggle={() => toggle(key)}
        onNewMachine={onNewMachineInCollection}
        onOpenMembers={isPersonal ? undefined : onOpenMembers}
        onRename={!isPersonal && onRenameCollection ? () => onRenameCollection(cid, node.name, node.color) : undefined}
        onDelete={!isPersonal && onDeleteCollection ? () => onDeleteCollection(cid, node.name) : undefined}
        onMove={canMove ? () => onMoveCollection!(cid, node.name) : undefined}
      >
        {renderFolderGroups(machines, key, 1, node.folders)}
      </CollectionNode>
    );
  };

  // Group collections by their library-folder placement (ADR 0016 view hierarchy).
  const placement = collectionPlacement ?? {};
  const libFolders = libraryFolders ?? [];
  const folderIds = new Set(libFolders.map((f) => f.id));
  const rootNodes = collectionNodes.filter((n) => !placement[n.id] || !folderIds.has(placement[n.id]));

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {personal.length === 0 && collectionNodes.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              {q ? 'No connections match your search.' : t('main.noConnections')}
            </p>
            {!q && <p className="mt-1 text-xs text-muted-foreground">{t('main.noConnectionsHint')}</p>}
          </div>
        ) : (
          <>
            {/* Loose personal machines (local context only) */}
            {renderFolderGroups(personal, 'personal', 0)}

            {/* Top-level personal folders → the collections placed in them */}
            {libFolders.map((f) => {
              const fkey = `lf/${f.id}`;
              const placed = collectionNodes.filter((n) => placement[n.id] === f.id);
              if (q && placed.length === 0) return null; // hide empty folders while searching
              return (
                <LibraryFolderNode
                  key={fkey}
                  id={f.id}
                  name={f.name}
                  color={f.color}
                  count={placed.length}
                  open={isOpen(fkey)}
                  onToggle={() => toggle(fkey)}
                  onRename={onRenameLibraryFolder ? (id) => onRenameLibraryFolder(id, f.name, f.color) : undefined}
                  onDelete={onDeleteLibraryFolder ? (id) => onDeleteLibraryFolder(id, f.name) : undefined}
                >
                  {placed.map(renderCollectionNode)}
                </LibraryFolderNode>
              );
            })}

            {/* Collections not in any folder — at the root */}
            {rootNodes.map(renderCollectionNode)}
          </>
        )}
      </div>
    </div>
  );
}
