/**
 * The app's own "are you sure", so none of them is the browser's.
 *
 * Mounted once at the root rather than inside the workspace. `SecretPrompt` lives in the
 * workspace, which is fine for a connection — there is always a workspace to connect from.
 * A confirmation is raised from the admin console too, and in an admin-only deployment
 * (`serveWebui: false`) the console IS the whole surface with no workspace behind it. A
 * dialog mounted there would never hear the request, `askConfirm` would resolve false, and
 * the action would quietly do nothing.
 *
 * The dangerous button carries `danger` and comes second, the way the workspace's delete
 * dialogs already read. Esc and the backdrop both cancel, because a dialog that closes only
 * through its own buttons is a trap.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { onAskConfirm, type ConfirmRequest } from '../utils/confirmPrompt';

type Pending = ConfirmRequest & { settle: (answer: boolean) => void };

export function ConfirmDialog() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => onAskConfirm((request) => setPending(request)), []);

  const settle = useCallback(
    (answer: boolean) => {
      pending?.settle(answer);
      setPending(null);
    },
    [pending],
  );

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, settle]);

  if (!pending) return null;
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
      onClick={() => settle(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-testid="confirm-dialog"
        className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-2 text-lg font-semibold">{pending.title}</h3>
        {pending.body && <p className="mb-4 text-sm text-muted-foreground">{pending.body}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={() => settle(false)}
            data-testid="confirm-cancel"
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
          >
            {t('dlg.cancel')}
          </button>
          <button
            onClick={() => settle(true)}
            autoFocus
            data-testid="confirm-accept"
            className={`rounded-md px-4 py-2 text-sm font-medium ${
              pending.danger
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}
          >
            {pending.action ?? t('dlg.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
