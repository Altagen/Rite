/**
 * Snippets Modal
 *
 * A personal library of reusable commands. Run a snippet on the current pane, or
 * broadcast it to every open pane. Running types the command (+ Enter) into the
 * session's stdin via send_terminal_input — no backend involved.
 */

import { useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { useSnippets } from '../store/snippets';
import { Backend } from '../utils/backend';
import { terminalPool } from '../utils/terminalPool';

interface Props {
  // The pane that opened the library — the target of a plain "Run".
  sessionId: string;
  paneLabel?: string;
  onClose: () => void;
}

async function sendTo(sessionId: string, command: string) {
  const bytes = Array.from(new TextEncoder().encode(`${command}\n`));
  await Backend.Terminal.sendTerminalInput(sessionId, bytes).catch(() => {});
}

export function SnippetsModal({ sessionId, paneLabel, onClose }: Props) {
  const { t } = useTranslation();
  const { snippets, add, remove } = useSnippets();
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = (cmd: string) => {
    void sendTo(sessionId, cmd);
  };
  const broadcast = (cmd: string) => {
    for (const id of terminalPool.getAllSessionIds()) void sendTo(id, cmd);
  };

  const addSnippet = () => {
    if (!name.trim() || !command.trim()) {
      setError(t('snip.fillAll'));
      return;
    }
    setError(null);
    add(name.trim(), command.trim());
    setName('');
    setCommand('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-background shadow-xl">
        <div className="border-b border-border px-4 py-3">
          <div className="text-sm font-medium">{t('snip.title')}</div>
          <div className="text-xs text-muted-foreground">
            {t('snip.subtitle', { pane: paneLabel ?? t('snip.thisPane') })}
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          {snippets.length === 0 ? (
            <p className="mb-3 text-sm text-muted-foreground">{t('snip.empty')}</p>
          ) : (
            <ul className="mb-3 flex flex-col gap-1.5">
              {snippets.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 rounded border border-border bg-muted/40 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.name}</div>
                    <code className="block truncate font-mono text-[11px] text-muted-foreground">
                      {s.command}
                    </code>
                  </div>
                  <button
                    type="button"
                    onClick={() => run(s.command)}
                    className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted"
                    title={t('snip.runHere')}
                  >
                    {t('snip.run')}
                  </button>
                  <button
                    type="button"
                    onClick={() => broadcast(s.command)}
                    className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted"
                    title={t('snip.broadcast')}
                  >
                    ⇉
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(s.id)}
                    className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                    title={t('snip.remove')}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex w-40 flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t('snip.name')}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Tail nginx"
                className="w-full rounded border border-border bg-input px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t('snip.command')}</span>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="tail -f /var/log/nginx/error.log"
                className="w-full min-w-[180px] rounded border border-border bg-input px-2 py-1.5 font-mono text-sm"
              />
            </label>
            <button
              type="button"
              onClick={addSnippet}
              className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {t('snip.add')}
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
        </div>

        <div className="flex justify-end border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            {t('snip.done')}
          </button>
        </div>
      </div>
    </div>
  );
}
