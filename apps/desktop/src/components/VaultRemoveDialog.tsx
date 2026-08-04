/**
 * Remove-a-local-vault confirmation (ADR 0014). Mirrors the mock's `removeVault`: forgetting
 * drops the vault from the roster but keeps the file; an explicit, irreversible opt-in also
 * deletes the `.db` (+ its SQLite sidecars, handled by the shell). Shared by every surface that
 * lists vaults — the hub, the context pill, and the locked-state picker — so the confirm text and
 * the delete opt-in stay identical everywhere.
 */

import { useState } from 'react';
import { sendVaultCommand, type NativeVault } from '../utils/nativeShell';

export function VaultRemoveDialog({
  vault,
  onClose,
}: {
  vault: Pick<NativeVault, 'path' | 'label'>;
  onClose: () => void;
}) {
  const [deleteFile, setDeleteFile] = useState(false);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold">Remove “{vault.label}”?</h3>
        <p className="mt-1 truncate text-xs text-muted-foreground">{vault.path}</p>
        <p className="mt-3 text-sm text-muted-foreground">
          Removes this vault from your list. The database file stays on disk — you can open it again
          anytime.
        </p>
        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
          <input
            type="checkbox"
            checked={deleteFile}
            onChange={(e) => setDeleteFile(e.target.checked)}
            className="mt-0.5 h-4 w-4 flex-none accent-red-500"
          />
          <span className="min-w-0 text-sm">
            <span className="font-medium text-red-500">Also delete the file permanently</span>
            <span className="block text-xs text-muted-foreground">
              Irreversible — erases the database and all its connections.
            </span>
          </span>
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-muted">
            Cancel
          </button>
          <button
            onClick={() => {
              sendVaultCommand(
                deleteFile
                  ? { type: 'vault-delete', path: vault.path }
                  : { type: 'vault-forget', path: vault.path },
              );
              onClose();
            }}
            className="rounded-md bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600"
          >
            {deleteFile ? 'Delete permanently' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  );
}
