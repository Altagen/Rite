/**
 * Move a machine to another folder within its collection (ADR 0016) — just changes
 * the machine's `folder` path, no re-creation. The destinations are the collection's
 * folder tree plus the collection root; persistence is the caller's (conns.update).
 */

import { useState } from 'react';

export function MoveMachineDialog({
  machineName,
  currentFolder,
  folderPaths,
  rootLabel = 'Root (no folder)',
  onClose,
  onPick,
}: {
  machineName: string;
  currentFolder: string; // '' ⇒ root (no folder)
  folderPaths: string[]; // every folder path in scope, sorted
  rootLabel?: string; // label for the '' destination
  onClose: () => void;
  onPick: (folder: string) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const pick = async (folder: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await onPick(folder);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const row = (path: string, label: string, depth: number) => {
    const isCurrent = currentFolder === path;
    return (
      <button
        key={path || '__root'}
        onClick={() => pick(path)}
        disabled={busy || isCurrent}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        className={`flex w-full items-center gap-2 rounded-md py-2 pr-3 text-left text-sm hover:bg-muted disabled:cursor-default disabled:opacity-60 ${
          isCurrent ? 'bg-primary/10' : ''
        }`}
      >
        <svg className="h-4 w-4 flex-none text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          {path === '' ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9-9 9 9M5 10v10h14V10" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          )}
        </svg>
        <span className="truncate">{label}</span>
        {isCurrent && <span className="ml-auto flex-none text-xs text-primary">here</span>}
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-sm flex-col rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-lg font-semibold">Move “{machineName}”</h3>
        <p className="mb-3 text-xs text-muted-foreground">Pick a destination folder.</p>
        <div className="-mx-1 space-y-0.5 overflow-y-auto">
          {row('', rootLabel, 0)}
          {folderPaths.map((p) => row(p, p.split('/').pop() ?? p, p.split('/').length))}
        </div>
        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
