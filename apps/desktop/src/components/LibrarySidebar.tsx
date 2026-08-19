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
import { StatusPastille } from './StatusPastille';
import { useHealth } from '../store/healthStore';
import { IconPlay, IconEdit, IconUsers, IconTrash, IconFolder, IconImport } from './icons';
import { useDisplayPrefs } from '../store/displayPrefs';

interface LibrarySidebarProps {
  connections: ConnectionInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (connection: ConnectionInfo) => void;
  onDelete: (connection: ConnectionInfo) => void;
  onConnect: (connection: ConnectionInfo) => void;
  onForward?: (connection: ConnectionInfo) => void; // open the port-forwarding panel
  onMoveMachine?: (connection: ConnectionInfo) => void; // move to another folder (collection ctx)
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
    isPersonal: boolean;
  }[];
  // Collection node actions (accounts context). Rename/Delete are owner-only,
  // gated by the caller; the sidebar shows them only when a handler is provided.
  onNewMachineInCollection?: (collectionId: string) => void;
  onNewFolderInCollection?: (collectionId: string) => void;
  onImportToCollection?: (collectionId: string) => void;
  // Sub-folder actions inside a collection (path-based nesting).
  onNewSubfolder?: (collectionId: string, parentPath: string) => void;
  onNewMachineInFolder?: (collectionId: string, folderPath: string) => void;
  onRenameFolder?: (collectionId: string, path: string, color: string | null) => void;
  onDeleteFolder?: (collectionId: string, path: string) => void;
  onOpenMembers?: (collectionId: string) => void;
  onRenameCollection?: (collectionId: string, name: string, color: string | null) => void;
  onDeleteCollection?: (collectionId: string, name: string) => void;
  // Top-level personal folders that organise collections (ADR 0016 view hierarchy).
  // Folders may nest via `parent`; a root folder can also hold a new collection.
  libraryFolders?: { id: string; name: string; color: string | null; parent?: string | null }[];
  collectionPlacement?: Record<string, string>; // collectionId → folderId
  onNewLibrarySubfolder?: (parentId: string) => void;
  onNewCollectionInFolder?: (folderId: string) => void;
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
  onNewSubfolder,
  onNewCollection,
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
  onNewSubfolder?: (id: string) => void;
  onNewCollection?: (id: string) => void;
  onRename?: (id: string) => void;
  onDelete?: (id: string) => void;
  children: React.ReactNode;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const hasAdd = !!(onNewSubfolder || onNewCollection);
  return (
    <div>
      <div className="m-tnode" style={{ paddingLeft: '6px' }}>
        <button onClick={onToggle} className="m-ca" aria-label={open ? 'Collapse' : 'Expand'}>
          <Chevron open={open} />
        </button>
        <FolderIcon color={color} />
        <button onClick={onToggle} className="m-nm text-left" title={name}>
          {name}
        </button>
        <div className="m-acts" style={showMenu || showAdd ? { opacity: 1 } : undefined}>
          {/* A root folder isn't owned by a collection, so its ＋ can create a
              sub-folder or a brand-new collection placed inside it. */}
          {hasAdd && (
            <div className="relative">
              <button onClick={(e) => { e.stopPropagation(); setShowAdd((v) => !v); }} title="New here" aria-label="New here">
                <PlusIcon />
              </button>
              {showAdd && (
                <>
                  <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setShowAdd(false); }} />
                  <div className="m-menu absolute right-0 top-full z-20 mt-1">
                    {onNewSubfolder && (
                      <button onClick={(e) => { e.stopPropagation(); setShowAdd(false); onNewSubfolder(id); }}>
                        <IconFolder className="h-4 w-4 flex-none" />
                        New sub-folder
                      </button>
                    )}
                    {onNewCollection && (
                      <button onClick={(e) => { e.stopPropagation(); setShowAdd(false); onNewCollection(id); }}>
                        <CollectionIcon color={null} />
                        New collection here…
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="relative">
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
        </div>
        <span className="m-cnt">{count}</span>
      </div>
      {open && <div className="ml-[15px]">{children}</div>}
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
  onNewFolder,
  onImport,
  onOpenMembers,
  onRename,
  onDelete,
  onMove,
  memberCount = 1,
  isPersonal = false,
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
  isPersonal?: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onNewMachine?: (id: string) => void;
  onNewFolder?: (id: string) => void;
  onImport?: (id: string) => void;
  onOpenMembers?: (id: string) => void;
  onRename?: (id: string) => void;
  onDelete?: (id: string) => void;
  onMove?: (id: string) => void;
  children: React.ReactNode;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const showMemberCount = useDisplayPrefs((s) => s.showMemberCount);
  const canWrite = role === 'owner' || role === 'editor';
  const canManage = role === 'owner';

  return (
    <div>
      <div onClick={onOpen} className={`m-tnode ${active ? 'sel' : ''}`} style={{ paddingLeft: '6px' }}>
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
        {memberCount > 1 && (
          <span className="m-mc" title={`${memberCount} members`}>
            <IconUsers className="h-4 w-4" />
            {showMemberCount ? memberCount : null}
          </span>
        )}
        <div className="m-acts" style={showMenu || showAdd ? { opacity: 1 } : undefined}>
          {canWrite && onNewMachine && (
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAdd((v) => !v);
                }}
                title="Add to collection"
                aria-label="Add to collection"
              >
                <PlusIcon />
              </button>
              {showAdd && (
                <>
                  <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setShowAdd(false); }} />
                  <div className="m-menu absolute right-0 top-full z-20 mt-1">
                    <button onClick={(e) => { e.stopPropagation(); setShowAdd(false); onNewMachine(cid); }}>
                      <IconPlay className="h-4 w-4 flex-none" />
                      New machine here
                    </button>
                    {onNewFolder && (
                      <button onClick={(e) => { e.stopPropagation(); setShowAdd(false); onNewFolder(cid); }}>
                        <IconFolder className="h-4 w-4 flex-none" />
                        New folder
                      </button>
                    )}
                    {onImport && (
                      <button onClick={(e) => { e.stopPropagation(); setShowAdd(false); onImport(cid); }}>
                        <IconImport className="h-4 w-4 flex-none" />
                        Import from ~/.ssh/config…
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
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
                  {/* Personal can't be shared, moved or deleted — rename only. */}
                  {!isPersonal && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowMenu(false); onOpenMembers?.(cid); }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                    >
                      Members &amp; sharing…
                    </button>
                  )}
                  {!isPersonal && onMove && (
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
                  {!isPersonal && canManage && (
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
        </div>
        <span className="m-cnt">{count}</span>
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}


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
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 12L12 17l8.5-5M3.5 16L12 21l8.5-5" />
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
    <svg className={`h-4 w-4 flex-none text-foreground transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
  onMove,
  onDelete,
  onConnect,
  onForward,
}: {
  connection: ConnectionInfo;
  isSelected: boolean;
  depth: number;
  onSelect: () => void;
  onEdit: () => void;
  onMove?: () => void;
  onDelete: () => void;
  onConnect: () => void;
  onForward?: () => void;
}) {
  const { t } = useTranslation();
  const active = useHealth((s) =>
    s.checking[connection.id] ? ('checking' as const) : s.results[connection.id]?.status,
  );

  return (
    <div
      className={`m-tnode leaf select-none ${isSelected ? 'sel' : ''}`}
      style={{ paddingLeft: `${6 + depth * 15}px` }}
      onClick={onSelect}
      onDoubleClick={onConnect}
    >
      <span className="m-ca" />
      <MachineIcon color={connection.color} />
      <div className="min-w-0 flex-1">
        <div className="m-nm flex items-center gap-1.5" title={connection.name}>
          <span className="truncate">{connection.name}</span>
          {connection.jump && (
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="flex-none text-muted-foreground opacity-75"
              aria-label="Reached through a jump host"
            >
              <title>Reached through a jump host (ProxyJump)</title>
              <path d="M4 17c2.5-9 13.5-9 16 0" />
              <circle cx="4" cy="17" r="1.7" fill="currentColor" stroke="none" />
              <circle cx="20" cy="17" r="1.7" fill="currentColor" stroke="none" />
            </svg>
          )}
          <StatusPastille lastUsedAt={connection.lastUsedAt} active={active} />
        </div>
        <div className="m-lsub">
          {connection.username}@{connection.hostname}:{connection.port}
        </div>
      </div>

      <div className="m-acts relative">
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
        {onForward && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onForward();
            }}
            aria-label="Port forwarding"
            title={t('pf.title')}
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M4 9h13l-3.5-3.5M20 15H7l3.5 3.5" />
            </svg>
          </button>
        )}
        {onMove && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMove();
            }}
            aria-label="Move to folder"
            title="Move to folder…"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v2M3 7v11a2 2 0 002 2h6M16 16l3 3m0 0l-3 3m3-3h-8" />
            </svg>
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete"
          title={t('connections.delete')}
        >
          <IconTrash className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** A folder row inside a collection (path-based nesting) with hover ＋/⋯ actions. */
function FolderNode({
  path,
  name,
  color,
  count,
  open,
  depth,
  canWrite,
  onToggle,
  onNewSubfolder,
  onNewMachine,
  onRename,
  onDelete,
  children,
}: {
  path: string;
  name: string;
  color: string | null;
  count: number;
  open: boolean;
  depth: number;
  canWrite: boolean;
  onToggle: () => void;
  onNewSubfolder?: (path: string) => void;
  onNewMachine?: (path: string) => void;
  onRename?: (path: string) => void;
  onDelete?: (path: string) => void;
  children: React.ReactNode;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const hasMenu = !!(onRename || onDelete);
  const hasAdd = !!(onNewSubfolder || onNewMachine);
  return (
    <div>
      <div className="m-tnode" style={{ paddingLeft: `${6 + depth * 15}px` }} onClick={onToggle}>
        <span className="m-ca">
          <Chevron open={open} />
        </span>
        <FolderIcon color={color} />
        <span className="m-nm">{name}</span>
        {canWrite && (hasAdd || hasMenu) && (
          <div className="m-acts" style={showMenu || showAdd ? { opacity: 1 } : undefined}>
            {hasAdd && (
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setShowAdd((v) => !v); }}
                  title="New here"
                  aria-label="New here"
                >
                  <PlusIcon />
                </button>
                {showAdd && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setShowAdd(false); }} />
                    <div className="m-menu absolute right-0 top-full z-20 mt-1">
                      {onNewSubfolder && (
                        <button onClick={(e) => { e.stopPropagation(); setShowAdd(false); onNewSubfolder(path); }}>
                          <IconFolder className="h-4 w-4 flex-none" />
                          New sub-folder
                        </button>
                      )}
                      {onNewMachine && (
                        <button onClick={(e) => { e.stopPropagation(); setShowAdd(false); onNewMachine(path); }}>
                          <IconPlay className="h-4 w-4 flex-none" />
                          New connection…
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            {hasMenu && (
              <div className="relative">
                <button onClick={(e) => { e.stopPropagation(); setShowMenu((v) => !v); }} aria-label="Folder menu">
                  <MoreIcon />
                </button>
                {showMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setShowMenu(false); }} />
                    <div className="m-menu absolute right-0 top-full z-20 mt-1">
                      {onRename && (
                        <button onClick={(e) => { e.stopPropagation(); setShowMenu(false); onRename(path); }}>
                          Rename…
                        </button>
                      )}
                      {onDelete && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setShowMenu(false); onDelete(path); }}
                          style={{ color: '#f7768e' }}
                        >
                          Delete folder
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        <span className="m-cnt">{count}</span>
      </div>
      {open && <div>{children}</div>}
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
  onForward,
  onMoveMachine,
  onOpenCollection,
  openCollectionId,
  query = '',
  collections,
  onNewMachineInCollection,
  onNewFolderInCollection,
  onImportToCollection,
  onNewSubfolder,
  onNewMachineInFolder,
  onRenameFolder,
  onDeleteFolder,
  onOpenMembers,
  onRenameCollection,
  onDeleteCollection,
  libraryFolders,
  collectionPlacement,
  onNewLibrarySubfolder,
  onNewCollectionInFolder,
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
      onMove={onMoveMachine ? () => onMoveMachine(c) : undefined}
      onDelete={() => onDelete(c)}
      onConnect={() => onConnect(c)}
      onForward={onForward ? () => onForward(c) : undefined}
    />
  );

  /** Render a set of machines grouped by their `folder`; ungrouped ones at baseDepth. */
  // Render a collection's machines as a nested folder tree. Folder names are paths
  // ("Web/Prod"); declared (possibly empty) folders come from the collection header.
  const renderFolderGroups = (
    machines: ConnectionInfo[],
    keyPrefix: string,
    baseDepth: number,
    declaredFolders?: { name: string; color: string | null }[],
    opts?: { collectionId?: string; canWrite?: boolean },
  ) => {
    interface Node {
      name: string;
      path: string;
      color: string | null;
      children: Map<string, Node>;
      machines: ConnectionInfo[];
    }
    const colorOf = new Map<string, string | null>();
    for (const f of declaredFolders ?? []) colorOf.set(f.name, f.color);
    const roots = new Map<string, Node>();
    const rootMachines: ConnectionInfo[] = [];
    const ensure = (path: string): Node => {
      let level = roots;
      let node: Node | null = null;
      let cur = '';
      for (const seg of path.split('/')) {
        cur = cur ? `${cur}/${seg}` : seg;
        let n = level.get(seg);
        if (!n) {
          n = { name: seg, path: cur, color: colorOf.get(cur) ?? null, children: new Map(), machines: [] };
          level.set(seg, n);
        }
        node = n;
        level = n.children;
      }
      return node!;
    };
    for (const f of declaredFolders ?? []) if (f.name) ensure(f.name);
    for (const c of machines) {
      if (c.folder) ensure(c.folder).machines.push(c);
      else rootMachines.push(c);
    }
    const countMachines = (n: Node): number =>
      n.machines.length + [...n.children.values()].reduce((s, c) => s + countMachines(c), 0);

    const renderLevel = (level: Map<string, Node>, depth: number): React.ReactNode => {
      const collectionId = opts?.collectionId;
      const canWrite = opts?.canWrite ?? false;
      return [...level.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((n) => {
          const key = `${keyPrefix}/folder/${n.path}`;
          return (
            <FolderNode
              key={key}
              path={n.path}
              name={n.name}
              color={n.color}
              count={countMachines(n)}
              open={isOpen(key)}
              depth={depth}
              canWrite={canWrite}
              onToggle={() => toggle(key)}
              onNewSubfolder={collectionId && onNewSubfolder ? (p) => onNewSubfolder(collectionId, p) : undefined}
              onNewMachine={collectionId && onNewMachineInFolder ? (p) => onNewMachineInFolder(collectionId, p) : undefined}
              onRename={collectionId && onRenameFolder ? (p) => onRenameFolder(collectionId, p, n.color) : undefined}
              onDelete={collectionId && onDeleteFolder ? (p) => onDeleteFolder(collectionId, p) : undefined}
            >
              {renderLevel(n.children, depth + 1)}
              {n.machines.map((c) => machineRow(c, depth + 1))}
            </FolderNode>
          );
        });
    };

    return (
      <>
        {renderLevel(roots, baseDepth)}
        {rootMachines.map((c) => machineRow(c, baseDepth))}
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
        isPersonal: false,
      };
    });
  const collectionNodes = (collections ?? derived())
    // When searching, hide collections with no matching machine.
    .filter((c) => !q || byCollection.has(c.id))
    // Personal first, then by name.
    .sort((a, b) => (a.isPersonal ? -1 : b.isPersonal ? 1 : a.name.localeCompare(b.name)));

  const renderCollectionNode = (node: { id: string; name: string; color: string | null; role: string; folders: { name: string; color: string | null }[]; memberCount: number; isPersonal: boolean }) => {
    const cid = node.id;
    const machines = byCollection.get(cid) ?? [];
    const key = `col/${cid}`;
    const canMove = onMoveCollection && (libraryFolders?.length ?? 0) > 0;
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
        memberCount={node.memberCount}
        isPersonal={node.isPersonal}
        onOpen={() => onOpenCollection?.(cid)}
        onToggle={() => toggle(key)}
        onNewMachine={onNewMachineInCollection}
        onNewFolder={onNewFolderInCollection}
        onImport={onImportToCollection}
        onOpenMembers={onOpenMembers}
        onRename={onRenameCollection ? () => onRenameCollection(cid, node.name, node.color) : undefined}
        onDelete={onDeleteCollection ? () => onDeleteCollection(cid, node.name) : undefined}
        onMove={canMove ? () => onMoveCollection!(cid, node.name) : undefined}
      >
        {renderFolderGroups(machines, key, 1, node.folders, {
          collectionId: cid,
          canWrite: node.role === 'owner' || node.role === 'editor',
        })}
      </CollectionNode>
    );
  };

  // Group collections by their library-folder placement (ADR 0016 view hierarchy).
  const placement = collectionPlacement ?? {};
  const libFolders = libraryFolders ?? [];
  const folderIds = new Set(libFolders.map((f) => f.id));
  const rootNodes = collectionNodes.filter((n) => !placement[n.id] || !folderIds.has(placement[n.id]));

  // Personal organiser folders nest via `parent`; render them as a tree.
  const childFoldersOf = (parentId: string | null) =>
    libFolders.filter((f) => (f.parent ?? null) === parentId);
  const subtreePlaced = (fid: string): number =>
    collectionNodes.filter((n) => placement[n.id] === fid).length +
    childFoldersOf(fid).reduce((s, c) => s + subtreePlaced(c.id), 0);
  const renderLibraryFolder = (f: { id: string; name: string; color: string | null; parent?: string | null }): React.ReactNode => {
    const fkey = `lf/${f.id}`;
    const placed = collectionNodes.filter((n) => placement[n.id] === f.id);
    const subs = childFoldersOf(f.id);
    if (q && subtreePlaced(f.id) === 0) return null; // hide empty folders while searching
    return (
      <LibraryFolderNode
        key={fkey}
        id={f.id}
        name={f.name}
        color={f.color}
        count={placed.length + subs.length}
        open={isOpen(fkey)}
        onToggle={() => toggle(fkey)}
        onNewSubfolder={onNewLibrarySubfolder}
        onNewCollection={onNewCollectionInFolder}
        onRename={onRenameLibraryFolder ? (id) => onRenameLibraryFolder(id, f.name, f.color) : undefined}
        onDelete={onDeleteLibraryFolder ? (id) => onDeleteLibraryFolder(id, f.name) : undefined}
      >
        {subs.map(renderLibraryFolder)}
        {placed.map(renderCollectionNode)}
      </LibraryFolderNode>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-2 pb-3">
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

            {/* Personal organiser folders (nested) → the collections placed in them */}
            {childFoldersOf(null).map(renderLibraryFolder)}

            {/* Collections not in any folder — at the root */}
            {rootNodes.map(renderCollectionNode)}
          </>
        )}
      </div>
    </div>
  );
}
