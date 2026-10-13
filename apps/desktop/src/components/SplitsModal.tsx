/**
 * Splits — what a divider can open.
 *
 * Presets and layouts are the same two fields twice (a name, and what to run), so
 * they are edited in one place rather than two half-places. Reached from the foot of
 * the split menu and from Settings.
 *
 * The plain terminal is listed first and cannot be removed: it is what the split
 * button itself does, and showing it here is what makes the menu a superset of the
 * button rather than a separate feature.
 */

import { useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { useSplits, PLAIN_PRESET } from '../store/splits';
import { parseLayoutPanes } from '../store/splitsFormat';

interface Props {
  onClose: () => void;
}

export function SplitsModal({ onClose }: Props) {
  const { t } = useTranslation();
  const { presets, layouts, addPreset, removePreset, addLayout, removeLayout } = useSplits();
  const [presetName, setPresetName] = useState('');
  const [presetCommand, setPresetCommand] = useState('');
  const [layoutName, setLayoutName] = useState('');
  const [layoutPanes, setLayoutPanes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submitPreset = () => {
    if (!presetName.trim()) return setError(t('split.needName'));
    addPreset(presetName.trim(), presetCommand.trim());
    setPresetName('');
    setPresetCommand('');
    setError(null);
  };

  const submitLayout = () => {
    if (!layoutName.trim()) return setError(t('split.needName'));
    const panes = parseLayoutPanes(layoutPanes);
    if (panes.length === 0) return setError(t('split.needPanes'));
    addLayout(layoutName.trim(), panes);
    setLayoutName('');
    setLayoutPanes('');
    setError(null);
  };

  const heading = (text: string) => (
    <div className="mb-2 mt-4 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground first:mt-0">
      {text}
    </div>
  );

  const field = (label: string, hint: string | null, input: React.ReactNode) => (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">
        {label}
        {hint && <span className="ml-1 opacity-70">· {hint}</span>}
      </span>
      {input}
    </label>
  );

  const inputClass = 'w-full rounded border border-border bg-input px-2.5 py-1.5 text-sm';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('split.title')}
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-background shadow-xl"
      >
        <div className="border-b border-border px-4 py-3">
          <div className="text-sm font-medium">{t('split.title')}</div>
          <div className="text-xs text-muted-foreground">{t('split.subtitle')}</div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          {heading(t('split.presets'))}
          <ul className="mb-3 flex flex-col gap-1.5">
            {[PLAIN_PRESET, ...presets].map((p) => (
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
                {p.id !== PLAIN_PRESET.id && (
                  <button
                    type="button"
                    onClick={() => removePreset(p.id)}
                    className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                    title={t('split.remove')}
                    data-testid={`remove-preset-${p.id}`}
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-2.5 border-t border-border pt-3">
            {field(
              t('split.name'),
              null,
              <input
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="Disk"
                className={inputClass}
                data-testid="preset-name"
              />,
            )}
            {field(
              t('split.command'),
              null,
              <input
                value={presetCommand}
                onChange={(e) => setPresetCommand(e.target.value)}
                placeholder="df -h"
                className={`${inputClass} font-mono`}
                data-testid="preset-command"
              />,
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={submitPreset}
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                data-testid="add-preset"
              >
                {t('split.addPreset')}
              </button>
            </div>
          </div>

          {heading(t('split.layouts'))}
          {layouts.length === 0 ? (
            <p className="mb-3 text-sm text-muted-foreground">{t('split.noLayouts')}</p>
          ) : (
            <ul className="mb-3 flex flex-col gap-1.5">
              {layouts.map((l) => (
                <li
                  key={l.id}
                  className="flex items-center gap-2 rounded border border-border bg-muted/40 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {l.name}{' '}
                      <span className="rounded border border-border px-1 text-[10px] font-semibold text-primary">
                        {t('split.panesCount', { count: l.panes.length })}
                      </span>
                    </div>
                    <code className="block truncate font-mono text-[11px] text-muted-foreground">
                      {l.panes.map((p) => p.name).join(' · ')}
                    </code>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeLayout(l.id)}
                    className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                    title={t('split.remove')}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-2.5 border-t border-border pt-3">
            {field(
              t('split.name'),
              null,
              <input
                value={layoutName}
                onChange={(e) => setLayoutName(e.target.value)}
                placeholder="Deploy watch"
                className={inputClass}
                data-testid="layout-name"
              />,
            )}
            {field(
              t('split.panes'),
              t('split.panesHint'),
              <textarea
                value={layoutPanes}
                onChange={(e) => setLayoutPanes(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder={'shell =\nload = top\ndisk = df -h'}
                className={`${inputClass} resize-y font-mono leading-relaxed`}
                data-testid="layout-panes"
              />,
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={submitLayout}
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                data-testid="add-layout"
              >
                {t('split.addLayout')}
              </button>
            </div>
          </div>

          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-3 py-1.5 text-xs hover:bg-muted"
          >
            {t('split.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
