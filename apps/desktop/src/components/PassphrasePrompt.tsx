/**
 * The dialog that asks for a key passphrase at connect time (ADR 0024 §4).
 *
 * Mounted once in the workspace; `askPassphrase` raises it from anywhere. What is typed
 * goes back to the caller for that one session — this component keeps it in state only
 * while the dialog is open, and clears it on the way out.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { onAskPassphrase, type PassphraseRequest } from '../utils/passphrasePrompt';

export function PassphrasePrompt() {
  const { t } = useTranslation();
  const [request, setRequest] = useState<PassphraseRequest | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => onAskPassphrase((next) => setRequest(next)), []);

  useEffect(() => {
    if (request) inputRef.current?.focus();
  }, [request]);

  if (!request) return null;

  const settle = (answer: string | null) => {
    request.settle(answer);
    setValue('');
    setRequest(null);
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4"
      data-testid="passphrase-prompt"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          settle(value);
        }}
        className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold">{t('connections.passphraseAsk')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('connections.passphraseAskFor', { name: request.label })}
        </p>
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          // Esc cancels, as it does on every other dialog here.
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              settle(null);
            }
          }}
          placeholder={t('connections.keyPassphrasePlaceholder')}
          className="mt-3 w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none"
          data-testid="passphrase-input"
        />
        <p className="mt-2 text-xs text-muted-foreground">{t('connections.passphraseAskWhy')}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => settle(null)} className="m-btn m-btn-sm">
            {t('connections.cancel')}
          </button>
          <button
            type="submit"
            className="m-btn m-btn-primary m-btn-sm"
            data-testid="passphrase-submit"
          >
            {t('connections.passphraseUnlock')}
          </button>
        </div>
      </form>
    </div>
  );
}
