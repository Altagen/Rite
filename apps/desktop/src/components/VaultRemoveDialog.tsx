/**
 * Remove a local vault from the roster (ADR 0014). Forgetting drops it from the list and
 * keeps the file; an explicit, irreversible opt-in also deletes the `.db` (+ sidecars, via
 * the shell) and asks for the vault's name first.
 *
 * It does NOT reset the vault you are in. It used to: the same trash icon meant "forget
 * this one" on any other vault and "erase this one's master password and contents" on the
 * current one — same glyph, same place in the row, opposite consequences, and the guard
 * for the destructive reading was retyping a name printed two lines above it. A user
 * reaching for "take this off my list" could wipe the vault instead, and only find out at
 * the next unlock, because after a reset the app sets a new password and holds the key in
 * memory: the session carries on as if nothing happened.
 *
 * Resetting a vault lives where a destructive action belongs — Settings ▸ danger zone, and
 * the unlock screen for when you are locked out — both behind typing DELETE ALL DATA.
 *
 * Shared by every surface that lists vaults — the hub, the context pill, and the locked-state picker.
 */

import { useState } from 'react';
import {
  isNativeShell,
  nativeContext,
  sendVaultCommand,
  type NativeVault,
} from '../utils/nativeShell';

export function VaultRemoveDialog({
  vault,
  onClose,
}: {
  vault: Pick<NativeVault, 'path' | 'label'>;
  onClose: () => void;
}) {
  const [deleteFile, setDeleteFile] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  // The vault this window is on: it can't be forgotten/switched-away here, so reset it instead.
  const isCurrent = isNativeShell() && nativeContext()?.path === vault.path;
  const nameOk = confirmName.trim() === vault.label;

  const nameConfirmField = (
    <div className="mt-4">
      <label className="text-xs text-muted-foreground">
        Type <span className="font-mono font-medium text-foreground">{vault.label}</span> to confirm
      </label>
      <input
        autoFocus
        value={confirmName}
        onChange={(e) => setConfirmName(e.target.value)}
        placeholder={vault.label}
        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
    </div>
  );

  // The vault this window is on cannot be forgotten — you are in it. It used to offer a
  // reset here instead; that is the trap this dialog no longer sets. Settings ▸ danger zone
  // resets it, behind the DELETE ALL DATA phrase.
  if (isCurrent) {
    return (
      <Shell onClose={onClose}>
        <h3 className="font-semibold">“{vault.label}” is the vault you are in</h3>
        <p className="mt-1 truncate text-xs text-muted-foreground">{vault.path}</p>
        <p className="mt-3 text-sm text-muted-foreground">
          It can't be removed from the list while this window holds it. Switch to another
          context first, or open <strong>Settings ▸ Reset vault</strong> to erase this one and
          start from scratch.
        </p>
        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
            Close
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell onClose={onClose}>
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
          onChange={(e) => {
            setDeleteFile(e.target.checked);
            setConfirmName('');
          }}
          className="mt-0.5 h-4 w-4 flex-none accent-red-500"
        />
        <span className="min-w-0 text-sm">
          <span className="font-medium text-red-500">Also delete the file permanently</span>
          <span className="block text-xs text-muted-foreground">
            Irreversible — erases the database and all its connections.
          </span>
        </span>
      </label>
      {deleteFile && nameConfirmField}
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
          disabled={deleteFile && !nameOk}
          className="rounded-md bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
        >
          {deleteFile ? 'Delete permanently' : 'Remove'}
        </button>
      </div>
    </Shell>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
