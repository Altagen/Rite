/**
 * Host-key confirmation modal.
 *
 * In strict mode, connecting to an unknown SSH host emits `ssh:host-key-unknown`
 * and the server rejects the connection, holding the offered key as pending. This
 * modal shows the fingerprint so the user can verify it out-of-band and accept
 * (trust it, then the connection is retried) or reject it. A changed host key is
 * shown as a security warning with no accept path (possible MITM).
 */

import { useTranslation } from '../i18n/i18n';

export interface HostKeyPrompt {
  host: string;
  port: number;
  keyType?: string;
  fingerprint: string;
  /** Set for a host-key-changed alert (previously trusted, key now differs). */
  changed?: boolean;
  oldFingerprint?: string;
}

interface HostKeyModalProps {
  prompt: HostKeyPrompt;
  onAccept: () => void;
  onReject: () => void;
  busy?: boolean;
}

export function HostKeyModal({ prompt, onAccept, onReject, busy }: HostKeyModalProps) {
  const { t } = useTranslation();
  const changed = prompt.changed === true;
  const target = `${prompt.host}:${prompt.port}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-key-title"
        className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center gap-3">
          <span className="text-2xl">{changed ? '⚠️' : '🔑'}</span>
          <h2 id="host-key-title" className="text-lg font-semibold">
            {changed ? t('hostKey.changed') : t('hostKey.unknown')}
          </h2>
        </div>

        <p className="mb-4 text-sm text-muted-foreground">
          {changed ? t('hostKey.changedWhy', { target }) : t('hostKey.unknownWhy', { target })}
        </p>

        <div className="mb-6 space-y-2 rounded-md bg-muted p-3 text-sm">
          {prompt.keyType && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{t('hostKey.keyType')}</span>
              <span className="font-mono">{prompt.keyType}</span>
            </div>
          )}
          {changed && prompt.oldFingerprint && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{t('hostKey.oldFp')}</span>
              <span className="break-all font-mono text-xs text-muted-foreground line-through">
                {prompt.oldFingerprint}
              </span>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">
              {changed ? t('hostKey.newFp') : t('hostKey.fp')}
            </span>
            <span className={`break-all font-mono text-xs ${changed ? 'text-red-500' : ''}`}>
              {prompt.fingerprint}
            </span>
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onReject}
            disabled={busy}
            className="rounded bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
          >
            {changed ? t('hostKey.close') : t('hostKey.cancel')}
          </button>
          {!changed && (
            <button
              type="button"
              onClick={onAccept}
              disabled={busy}
              className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? t('hostKey.connecting') : t('hostKey.trust')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
