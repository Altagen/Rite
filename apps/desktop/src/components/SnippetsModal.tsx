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

// Non-empty command lines — the units that run one after another.
const linesOf = (command: string) =>
  command.split('\n').map((l) => l.trim()).filter(Boolean);

// Send a snippet to a session: its lines are typed in order, so the shell runs
// them one after another (like pasting) — no && chaining needed.
async function sendTo(sessionId: string, command: string) {
  const script = `${command.replace(/\n+$/, '')}\n`;
  const bytes = Array.from(new TextEncoder().encode(script));
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
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('snip.title')}
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-background shadow-xl"
      >
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
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{s.name}</span>
                      {linesOf(s.command).length > 1 && (
                        <span
                          className="flex-none rounded border border-border px-1 text-[10px] font-semibold text-primary"
                          title={t('snip.nCmds', { n: linesOf(s.command).length })}
                        >
                          {t('snip.nCmds', { n: linesOf(s.command).length })}
                        </span>
                      )}
                    </div>
                    <code className="block truncate font-mono text-[11px] text-muted-foreground">
                      {linesOf(s.command)[0] ?? ''}
                      {linesOf(s.command).length > 1 && ` +${linesOf(s.command).length - 1}`}
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

          <div className="flex flex-col gap-2.5 border-t border-border pt-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t('snip.name')}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Deploy check"
                className="w-full rounded border border-border bg-input px-2.5 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">
                {t('snip.command')} <span className="font-normal">· {t('snip.onePerLine')}</span>
              </span>
              <textarea
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder={'git pull\nnpm ci\nnpm run build'}
                style={{ resize: 'vertical', minHeight: 66 }}
                className="w-full rounded border border-border bg-input px-2.5 py-1.5 font-mono text-sm leading-relaxed"
              />
            </label>
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={addSnippet}
                className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                {t('snip.add')}
              </button>
            </div>
          </div>
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
