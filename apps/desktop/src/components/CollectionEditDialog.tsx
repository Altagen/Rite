/**
 * Create or rename a collection (ADR 0016). Self-contained crypto: creating
 * generates a collection key sealed to myself (I become the first owner) and
 * encrypts the {name, colour} header; renaming re-encrypts the header with the
 * collection's existing key (fetched from `mine()` and unwrapped). Only rendered
 * in the accounts context, where the session keys are in memory.
 */

import { useState } from 'react';
import { Backend } from '../utils/backend';
import { useServerSession } from '../store/serverSessionStore';
import { generateCollectionKeys, sealCollectionKey, encryptCollectionField } from '../utils/collectionCrypto';
import { escrowForCreate } from '../utils/adminGroup';
import { readCollectionHeader, writeCollectionHeader } from '../utils/collectionHeader';

const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#94a3b8'];

export function CollectionEditDialog({
  collectionId,
  initialName,
  initialColor,
  onClose,
  onSaved,
}: {
  collectionId?: string; // present ⇒ rename; absent ⇒ create
  initialName?: string;
  initialColor?: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { publicKey, privateKey } = useServerSession();
  const [name, setName] = useState(initialName ?? '');
  const [color, setColor] = useState(initialColor ?? COLORS[0]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = !!collectionId;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        // Rename: re-encrypt the header (metaKey), preserving the collection's folders.
        if (!publicKey || !privateKey) throw new Error('session keys unavailable');
        const { metaKey, header } = await readCollectionHeader(collectionId!, publicKey, privateKey);
        await writeCollectionHeader(collectionId!, metaKey, { ...header, name: name.trim(), color });
      } else {
        // Create: fresh split keys sealed to myself (first owner). The name/colour is
        // encrypted with metaKey; items will use the separate itemsKey (ADR 0016).
        if (!publicKey) throw new Error('session keys unavailable');
        const { metaKey, itemsKey } = generateCollectionKeys();
        const nameEnc = await encryptCollectionField(metaKey, { name: name.trim(), color });
        await Backend.Collections.create(
          nameEnc,
          await sealCollectionKey(publicKey, metaKey),
          await sealCollectionKey(publicKey, itemsKey),
          await escrowForCreate(metaKey),
        );
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
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
        <h3 className="mb-3 text-lg font-semibold">{editing ? 'Rename collection' : 'New collection'}</h3>

        {error && (
          <div className="mb-3 rounded-md border border-red-500/20 bg-red-500/10 p-2 text-sm text-red-600">{error}</div>
        )}

        <label className="mb-1 block text-sm font-medium">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder="e.g. Production DBs"
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
            {editing ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
