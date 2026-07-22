/**
 * Create a shared sub-folder inside a collection (ADR 0016). The folder is stored
 * in the collection's encrypted header, so every member sees it (owners/editors can
 * add it — it re-encrypts the header) and it survives while empty. Machines join a
 * folder by setting their `folder` field to its name.
 */

import { useState } from 'react';
import { useServerSession } from '../store/serverSessionStore';
import { addCollectionFolder } from '../utils/collectionHeader';

const COLORS = ['#7c9cf5', '#9ece6a', '#e5b567', '#f0a35e', '#f7768e', '#bb9af7', '#56c7c0', '#94a3b8'];

export function CollectionFolderDialog({
  collectionId,
  collectionName,
  onClose,
  onSaved,
}: {
  collectionId: string;
  collectionName?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { publicKey, privateKey } = useServerSession();
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!publicKey || !privateKey) throw new Error('session keys unavailable');
      await addCollectionFolder(collectionId, publicKey, privateKey, { name: name.trim(), color });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <form
        onSubmit={save}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-lg font-semibold">New folder</h3>
        {collectionName && <p className="mb-3 text-xs text-muted-foreground">Shared in “{collectionName}”</p>}

        {error && (
          <div className="mb-3 rounded-md border border-red-500/20 bg-red-500/10 p-2 text-sm text-red-600">{error}</div>
        )}

        <label className="mb-1 block text-sm font-medium">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder="e.g. Web servers"
          className="mb-4 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          disabled={busy}
        />

        <label className="mb-1 block text-sm font-medium">Colour</label>
        <div className="mb-5 flex flex-wrap gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`h-7 w-7 rounded-full ${color === c ? 'ring-2 ring-foreground ring-offset-2 ring-offset-card' : ''}`}
              style={{ backgroundColor: c }}
              aria-label={`colour ${c}`}
            />
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
