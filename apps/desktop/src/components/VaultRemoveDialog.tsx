/**
 * Remove / reset a local vault (ADR 0014). Two cases, decided by whether the target is the vault
 * THIS window currently holds:
 *
 * - Another vault → mirrors the mock's `removeVault`: forgetting drops it from the roster but keeps
 *   the file; an explicit, irreversible opt-in also deletes the `.db` (+ sidecars, via the shell).
 * - The current vault → you can't "remove it from the list" while you're in it (and it may be the
 *   only one), so instead offer **Reset**: wipe its master password + all connections to start from
 *   scratch (`reset_database`, works even while locked), then return to the base workspace.
 *
 * The irreversible actions (reset, and delete-the-file) require typing the vault's name to confirm,
 * as a guard against an accidental click. Forget keeps the file, so it needs no name.
 *
 * Shared by every surface that lists vaults — the hub, the context pill, and the locked-state picker.
 */

import { useState } from 'react';
import { Backend } from '../utils/backend';
import {
  isNativeShell,
  nativeContext,
  requestReloadContext,
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
  const [busy, setBusy] = useState(false);
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

  if (isCurrent) {
    return (
      <Shell onClose={onClose}>
        <h3 className="font-semibold">Reset “{vault.label}”?</h3>
        <p className="mt-1 truncate text-xs text-muted-foreground">{vault.path}</p>
        <p className="mt-3 text-sm text-muted-foreground">
          This vault is open in this window. Resetting <strong>erases its master password, every
          connection, and its name/icon</strong> so you can start from scratch.
        </p>
        <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-muted-foreground">
          Irreversible — there’s no recovery (zero-knowledge).
        </div>
        {nameConfirmField}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="rounded-md px-3 py-1.5 text-sm hover:bg-muted">
            Cancel
          </button>
          <button
            onClick={async () => {
              setBusy(true);
              try {
                await Backend.Auth.resetDatabase(); // wipe the master password + connections
                // Drop the stale roster entry (name/icon) and rebuild the window via the shell so
                // __RITE_VAULTS__ is regenerated — a plain page reload would re-inject the old list.
                sendVaultCommand({ type: 'vault-forget', path: vault.path });
                if (!requestReloadContext()) window.location.reload();
              } catch {
                setBusy(false);
              }
            }}
            disabled={busy || !nameOk}
            className="rounded-md bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
          >
            {busy ? 'Resetting…' : 'Reset & start fresh'}
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
