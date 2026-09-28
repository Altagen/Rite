/**
 * Place a collection into a top-level personal folder (ADR 0016 view hierarchy),
 * or move it back to the root. Persistence is the caller's (the library tree).
 */

import { useState } from 'react';

export function MoveToFolderDialog({
  collectionName,
  folders,
  current,
  onClose,
  onPick,
}: {
  collectionName: string;
  folders: { id: string; name: string }[];
  current: string | null;
  onClose: () => void;
  onPick: (folderId: string | null) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const pick = async (folderId: string | null) => {
    setBusy(true);
    try {
      await onPick(folderId);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const row = (id: string | null, label: string) => (
    <button
      key={id ?? '__root'}
      onClick={() => pick(id)}
      disabled={busy}
      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50 ${
        (current ?? null) === id ? 'bg-primary/10' : ''
      }`}
    >
      <svg className="h-4 w-4 flex-none text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      </svg>
      {label}
      {(current ?? null) === id && <span className="ml-auto text-xs text-primary">current</span>}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-lg font-semibold">Move “{collectionName}”</h3>
        <p className="mb-3 text-xs text-muted-foreground">Choose a personal folder (your view only — not shared).</p>
        <div className="space-y-0.5">
          {row(null, '(no folder — root)')}
          {folders.map((f) => row(f.id, f.name))}
          {folders.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">No folders yet — create one from the library ＋.</p>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
