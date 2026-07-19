/**
 * The header "Contexts" entry (ADR 0014 phase 4) — replaces the old context
 * dropdown. Native only: it opens the {@link Hub} as an overlay so you can jump
 * to another context (which opens/focuses its own window). On the web build there
 * is a single server and nothing to switch, so this renders nothing.
 */

import { useEffect, useState } from 'react';
import { Backend } from '../utils/backend';
import { isNativeShell } from '../utils/nativeShell';
import { Hub } from './Hub';

export function ContextButton() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<{ kind: 'local' | 'server'; id?: string }>({ kind: 'local' });

  useEffect(() => {
    if (!isNativeShell()) return;
    // Learn which context this window holds so the hub can mark it "current".
    void Backend.Context.get()
      .then((ctx) => setCurrent(ctx.active === 'local' ? { kind: 'local' } : { kind: 'server', id: ctx.active.id }))
      .catch(() => setCurrent({ kind: 'local' }));
  }, []);

  if (!isNativeShell()) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-medium hover:bg-muted"
        title="Switch context"
      >
        <svg className="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
        <span>Contexts</span>
      </button>
      {open && <Hub current={current} onClose={() => setOpen(false)} />}
    </>
  );
}
