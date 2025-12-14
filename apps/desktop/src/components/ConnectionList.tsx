/**
 * Connection List Component
 *
 * Displays the list of saved connections in the sidebar
 */

import { useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { type ConnectionInfo } from '../store/connectionsStore';

interface ConnectionListProps {
  connections: ConnectionInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (connection: ConnectionInfo) => void;
  onDelete: (connection: ConnectionInfo) => void;
  onConnect: (connection: ConnectionInfo) => void;
}

interface ConnectionItemProps {
  connection: ConnectionInfo;
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onConnect: () => void;
}

function ConnectionItem({
  connection,
  isSelected,
  onSelect,
  onEdit,
  onDelete,
  onConnect,
}: ConnectionItemProps) {
  const { t } = useTranslation();
  const [showMenu, setShowMenu] = useState(false);

  const handleDoubleClick = () => {
    console.log('[ConnectionList] handleDoubleClick called for:', connection.name);
    console.log('[ConnectionList] onConnect prop:', onConnect);
    onConnect();
    console.log('[ConnectionList] onConnect() executed');
  };

  const formatLastUsed = (timestamp: number | null | undefined): string => {
    if (!timestamp) {
      return t('connections.neverUsed');
    }

    // Backend stores Unix timestamp in seconds, JavaScript Date expects milliseconds
    const date = new Date(timestamp * 1000);

    // Format: "14/01/2025 15:30"
    return date.toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div
      className={`group relative cursor-pointer rounded px-3 py-2 transition-colors select-none ${
        isSelected ? 'bg-primary/20' : 'hover:bg-muted'
      }`}
      onClick={onSelect}
      onDoubleClick={() => {
        console.log('[ConnectionList] Double-click event fired on div for:', connection.name);
        handleDoubleClick();
      }}
    >
      {/* Connection Info */}
      <div className="flex items-start justify-between">
        <div className="flex-1 overflow-hidden">
          <div className="flex items-center gap-2">
            {connection.color && (
              <div
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: connection.color }}
              />
            )}
            <h3 className="truncate font-medium" title={connection.name}>{connection.name}</h3>
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {connection.username}@{connection.hostname}:{connection.port}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatLastUsed(connection.lastUsedAt)}
          </p>
        </div>

        {/* Menu Button */}
        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu(!showMenu);
            }}
            className="rounded p-1 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
            aria-label="Connection menu"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"
              />
            </svg>
          </button>

          {/* Dropdown Menu */}
          {showMenu && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setShowMenu(false)}
              />
              <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded border border-border bg-background shadow-lg">
                <button
                  onClick={(e) => {
                    console.log('[ConnectionList] Menu Connect button clicked for:', connection.name);
                    e.stopPropagation();
                    setShowMenu(false);
                    console.log('[ConnectionList] Calling onConnect from menu...');
                    onConnect();
                    console.log('[ConnectionList] onConnect from menu executed');
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
    </div>
  );
}

export function ConnectionList({
  connections,
  selectedId,
  onSelect,
  onEdit,
  onDelete,
  onConnect,
}: ConnectionListProps) {
  const { t } = useTranslation();
  const [sortMode, setSortMode] = useState<'collections' | 'recent'>('recent');

  if (connections.length === 0) {
    return (
      <div className="px-3 py-8 text-center">
        <p className="text-sm text-muted-foreground">{t('main.noConnections')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('main.noConnectionsHint')}</p>
      </div>
    );
  }

  // Render based on sort mode
  if (sortMode === 'recent') {
    // Sort by last used date (most recent first)
    const sortedConnections = [...connections].sort((a, b) => {
      const aTime = a.lastUsedAt || 0;
      const bTime = b.lastUsedAt || 0;
      return bTime - aTime; // Descending order (most recent first)
    });

    return (
      <div className="px-2 py-2">
        {/* Sort mode selector */}
        <div className="mb-3 flex items-center gap-1 rounded-md bg-muted p-1">
          <button
            onClick={() => setSortMode('recent')}
            className="flex-1 rounded bg-background px-2 py-1 text-xs font-medium shadow-sm"
          >
            Recent
          </button>
          <button
            onClick={() => setSortMode('collections')}
            className="flex-1 rounded px-2 py-1 text-xs font-medium transition-colors hover:bg-background/50"
          >
            Collections
          </button>
        </div>

        <div className="space-y-1">
          {sortedConnections.map((connection) => (
            <ConnectionItem
              key={connection.id}
              connection={connection}
              isSelected={selectedId === connection.id}
              onSelect={() => onSelect(connection.id)}
              onEdit={() => onEdit(connection)}
              onDelete={() => onDelete(connection)}
              onConnect={() => onConnect(connection)}
            />
          ))}
        </div>
      </div>
    );
  }

  // Group connections by collection (default mode)
  const grouped = connections.reduce((acc, conn) => {
    const collection = conn.folder || 'Ungrouped';
    if (!acc[collection]) {
      acc[collection] = [];
    }
    acc[collection].push(conn);
    return acc;
  }, {} as Record<string, ConnectionInfo[]>);

  const collections = Object.keys(grouped).sort();

  return (
    <div className="px-2 py-2">
      {/* Sort mode selector */}
      <div className="mb-3 flex items-center gap-1 rounded-md bg-muted p-1">
        <button
          onClick={() => setSortMode('recent')}
          className="flex-1 rounded px-2 py-1 text-xs font-medium transition-colors hover:bg-background/50"
        >
          Recent
        </button>
        <button
          onClick={() => setSortMode('collections')}
          className="flex-1 rounded bg-background px-2 py-1 text-xs font-medium shadow-sm"
        >
          Collections
        </button>
      </div>

      <div className="space-y-4">
        {collections.map((collection) => (
          <div key={collection}>
            {collection !== 'Ungrouped' && (
              <h3 className="mb-2 px-2 text-xs font-semibold uppercase text-muted-foreground">
                {collection}
              </h3>
            )}
            <div className="space-y-1">
              {grouped[collection].map((connection) => (
                <ConnectionItem
                  key={connection.id}
                  connection={connection}
                  isSelected={selectedId === connection.id}
                  onSelect={() => onSelect(connection.id)}
                  onEdit={() => onEdit(connection)}
                  onDelete={() => onDelete(connection)}
                  onConnect={() => onConnect(connection)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
