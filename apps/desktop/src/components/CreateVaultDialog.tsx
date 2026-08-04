/**
 * Create-a-local-vault dialog (ADR 0014). Shows where the new vault will be written (Rite's
 * default location, auto-incremented so it never clobbers an existing one) as a label, so the
 * user sees the path without a file picker popping up. "Change location…" opens the native save
 * dialog to write it elsewhere; "Create vault" writes it at the shown path. Either way the window
 * then switches onto the fresh vault and prompts for a master password (register-after-password).
 */

import { sendVaultCommand, suggestedVaultPath } from '../utils/nativeShell';

export function CreateVaultDialog({ onClose }: { onClose: () => void }) {
  const path = suggestedVaultPath() ?? '';
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const file = slash >= 0 ? path.slice(slash + 1) : path;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Create a local vault</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          An encrypted database on this machine. Next you’ll set its master password.
        </p>

        <div className="mt-4">
          <span className="text-xs font-medium text-muted-foreground">Location</span>
          <div className="mt-1 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2.5">
            <svg className="h-4 w-4 flex-none text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            </svg>
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
              <span className="text-muted-foreground">{dir}</span>
              <span className="font-medium text-foreground">{file}</span>
            </span>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            onClick={() => {
              // Native picker path: create with no path → the shell shows the save dialog.
              sendVaultCommand({ type: 'vault-new' });
              onClose();
            }}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Change location…
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-muted">
              Cancel
            </button>
            <button
              onClick={() => {
                if (path) sendVaultCommand({ type: 'vault-new', path });
                else sendVaultCommand({ type: 'vault-new' }); // no suggestion ⇒ fall back to the picker
                onClose();
              }}
              className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Create vault
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
