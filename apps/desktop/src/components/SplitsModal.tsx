/**
 * Split presets — the commands a divider can open.
 *
 * One command, one pane, one line each. Layouts used to share this dialog, because
 * they share its two fields; they are not the same feature, and sharing a screen
 * said that they were. A preset is a reflex you type in four seconds. A layout is
 * what opens when you sit down, it names machines, and it lives in a file —
 * `LayoutsModal`, docs/LAYOUTS.md.
 *
 * Everything here is editable in place. The first version could only add and remove,
 * which meant correcting a typo in a command was "delete it, retype the other field,
 * add it again". An entry you can write and not rewrite is a list you stop trusting.
 *
 * The plain terminal is listed first and cannot be edited or removed: it is what the
 * split button itself does, and showing it is what makes the menu a superset of the
 * button rather than a separate feature.
 *
 * There is no footer. Every change here is saved as you make it, so a bottom-right
 * "Close" would be a second answer to the question the ✕ already answers, and a
 * "Cancel" beside it would be a lie.
 */

import { useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { useSplits, PLAIN_PRESET } from '../store/splits';

interface Props {
  onClose: () => void;
}

export function SplitsModal({ onClose }: Props) {
  const { t } = useTranslation();
  const { presets, addPreset, updatePreset, removePreset } = useSplits();

  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [error, setError] = useState<string | null>(null);

  const clear = () => {
    setEditing(null);
    setName('');
    setCommand('');
    setError(null);
  };

  const edit = (id: string, n: string, c: string) => {
    setEditing(id);
    setName(n);
    setCommand(c);
    setError(null);
  };

  const submit = () => {
    if (!name.trim()) return setError(t('split.needName'));
    if (editing) updatePreset(editing, name.trim(), command.trim());
    else addPreset(name.trim(), command.trim());
    clear();
  };

  const inputClass = 'w-full rounded border border-border bg-input px-2.5 py-1.5 text-sm';
  const iconBtn =
    'flex-none rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground';

  const field = (label: string, input: React.ReactNode) => (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {input}
    </label>
  );

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('split.presets')}
        className="relative w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-background shadow-xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
          className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="border-b border-border px-4 py-3 pr-12">
          <div className="text-sm font-medium">{t('split.presets')}</div>
          <div className="text-xs text-muted-foreground">{t('split.subtitle')}</div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          <ul className="mb-3 flex flex-col gap-1.5">
            {[PLAIN_PRESET, ...presets].map((p) => {
              const builtin = p.id === PLAIN_PRESET.id;
              return (
                <li
                  key={p.id}
                  className="flex items-center gap-2 rounded border border-border bg-muted/40 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <code className="block truncate font-mono text-[11px] text-muted-foreground">
                      {p.command || t('split.plainHint')}
                    </code>
                  </div>
                  {!builtin && (
                    <>
                      <button
                        type="button"
                        onClick={() => edit(p.id, p.name, p.command)}
                        className={iconBtn}
                        title={t('split.edit')}
                        data-testid={`edit-preset-${p.id}`}
                      >
                        {t('split.edit')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (editing === p.id) clear();
                          removePreset(p.id);
                        }}
                        className={iconBtn}
                        title={t('split.remove')}
                        data-testid={`remove-preset-${p.id}`}
                      >
                        ✕
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="flex flex-col gap-2.5 border-t border-border pt-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {editing ? t('split.editPreset') : t('split.newPreset')}
            </div>
            {field(
              t('split.name'),
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Disk"
                className={inputClass}
                data-testid="preset-name"
              />,
            )}
            {field(
              t('split.command'),
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="df -h"
                className={`${inputClass} font-mono`}
                data-testid="preset-command"
              />,
            )}
            <div className="flex justify-end gap-2">
              {editing && (
                <button
                  type="button"
                  onClick={clear}
                  className="rounded border border-border px-3 py-1.5 text-xs hover:bg-muted"
                  data-testid="cancel-edit"
                >
                  {t('split.cancel')}
                </button>
              )}
              <button
                type="button"
                onClick={submit}
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                data-testid="add-preset"
              >
                {editing ? t('split.save') : t('split.addPreset')}
              </button>
            </div>
          </div>

          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  );
}
