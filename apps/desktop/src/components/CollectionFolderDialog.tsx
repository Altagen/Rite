/**
 * Create or rename a folder inside a collection (ADR 0016). Folders are stored in
 * the collection's encrypted header (path names for nesting), so every member sees
 * them, owners/editors can change them (re-encrypts), and empty ones survive.
 * Machines join a folder by setting their `folder` field to its path. In a vault the
 * header is the same, only rite-core rewrites it — see `onPersist`.
 *
 * Modes: create a top-level folder (no `parentPath`, no `renamePath`); create a
 * sub-folder under `parentPath`; or rename the folder at `renamePath`.
 */

import { useState } from 'react';
import { useServerSession } from '../store/serverSessionStore';
import { addCollectionFolder, renameCollectionFolder } from '../utils/collectionHeader';
import { useTranslation } from '../i18n/i18n';

const COLORS = [
  '#7c9cf5',
  '#9ece6a',
  '#e5b567',
  '#f0a35e',
  '#f7768e',
  '#bb9af7',
  '#56c7c0',
  '#94a3b8',
];

/** The parent path of a folder path, or null at the top level. */
function parentOf(path: string): string | null {
  const i = path.lastIndexOf('/');
  return i === -1 ? null : path.slice(0, i);
}

export function CollectionFolderDialog({
  collectionId,
  collectionName,
  parentPath,
  renamePath,
  initialName,
  initialColor,
  onClose,
  onSaved,
  onPersist,
}: {
  collectionId: string;
  collectionName?: string;
  parentPath?: string | null;
  renamePath?: string; // present ⇒ rename that folder
  initialName?: string;
  initialColor?: string | null;
  onClose: () => void;
  onSaved: () => void;
  /**
   * How to persist. A local vault passes this so the core rewrites the header
   * with the master key; a server context leaves it out and the folder is sealed
   * with the session keys below. The form is identical either way.
   */
  onPersist?: (args: {
    collectionId: string;
    path: string;
    color: string | null;
    from?: string;
  }) => Promise<void>;
}) {
  const { publicKey, privateKey } = useServerSession();
  const { t } = useTranslation();
  const editing = !!renamePath;
  const [name, setName] = useState(initialName ?? '');
  const [color, setColor] = useState(initialColor ?? COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim().replace(/\//g, ' '); // no slashes in a single segment
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const path = editing
        ? (() => {
            const parent = parentOf(renamePath!);
            return parent ? `${parent}/${trimmed}` : trimmed;
          })()
        : parentPath
          ? `${parentPath}/${trimmed}`
          : trimmed;

      if (onPersist) {
        await onPersist({ collectionId, path, color, from: editing ? renamePath! : undefined });
      } else {
        if (!publicKey || !privateKey) throw new Error('session keys unavailable');
        if (editing) {
          await renameCollectionFolder(
            collectionId,
            publicKey,
            privateKey,
            renamePath!,
            path,
            color,
          );
        } else {
          await addCollectionFolder(collectionId, publicKey, privateKey, { name: path, color });
        }
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('fold.errSave'));
    } finally {
      setBusy(false);
    }
  };

  const subtitle = editing
    ? t('fold.renamingIn', { name: collectionName ?? '' })
    : parentPath
      ? t('fold.subOf', { path: parentPath })
      : collectionName
        ? t('fold.sharedIn', { name: collectionName })
        : undefined;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={save}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-lg font-semibold">{editing ? t('fold.rename') : t('fold.new')}</h3>
        {subtitle && <p className="mb-3 text-xs text-muted-foreground">{subtitle}</p>}

        {error && (
          <div className="mb-3 rounded-md border border-red-500/20 bg-red-500/10 p-2 text-sm text-red-600">
            {error}
          </div>
        )}

        <label className="mb-1 block text-sm font-medium">{t('dlg.name')}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder={t('fold.phCollection')}
          className="mb-4 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          disabled={busy}
        />

        <label className="mb-1 block text-sm font-medium">{t('dlg.colour')}</label>
        <div className="mb-5 flex flex-wrap gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`h-7 w-7 rounded-full ${color === c ? 'ring-2 ring-foreground ring-offset-2 ring-offset-card' : ''}`}
              style={{ backgroundColor: c }}
              aria-label={t('dlg.colourAria', { hex: c })}
            />
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
          >
            {t('dlg.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {editing ? t('dlg.save') : t('dlg.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
