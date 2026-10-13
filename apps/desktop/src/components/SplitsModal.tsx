/**
 * Splits — the presets a divider can open, and the layouts that open several at once.
 *
 * Two sections rather than one list, because they are two different things: a preset
 * is one command in one pane, a layout arranges a whole tab. They share this dialog
 * because they share their two fields, and `section` decides which one you land on —
 * the split menu sends you to the presets, the Layouts button to the layouts.
 *
 * Everything here is editable in place. The first version could only add and remove,
 * which meant correcting a typo in a command was "delete it, retype the other field,
 * add it again" — and for a five-pane layout that is five lines retyped to fix one.
 * An entry you can write and not rewrite is a list you stop trusting.
 *
 * The plain terminal is listed first among the presets and cannot be edited or
 * removed: it is what the split button itself does, and showing it is what makes the
 * menu a superset of the button rather than a separate feature.
 */

import { useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { useSplits, PLAIN_PRESET } from '../store/splits';
import { parseLayoutPanes, formatLayoutPanes } from '../store/splitsFormat';

interface Props {
  onClose: () => void;
  /** Which section to open on. Defaults to the presets. */
  section?: 'presets' | 'layouts';
}

/** Which row is being edited, if any. `null` is the add form; a string is that entry. */
type Editing = { kind: 'preset' | 'layout'; id: string } | null;

export function SplitsModal({ onClose, section = 'presets' }: Props) {
  const { t } = useTranslation();
  const {
    presets,
    layouts,
    addPreset,
    updatePreset,
    removePreset,
    addLayout,
    updateLayout,
    removeLayout,
  } = useSplits();

  const [tab, setTab] = useState<'presets' | 'layouts'>(section);
  const [editing, setEditing] = useState<Editing>(null);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [panesText, setPanesText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const clear = () => {
    setEditing(null);
    setName('');
    setCommand('');
    setPanesText('');
    setError(null);
  };

  const editPreset = (id: string, n: string, c: string) => {
    setEditing({ kind: 'preset', id });
    setName(n);
    setCommand(c);
    setError(null);
  };

  const editLayout = (id: string, n: string, panes: { name: string; command: string }[]) => {
    setEditing({ kind: 'layout', id });
    setName(n);
    setPanesText(formatLayoutPanes(panes));
    setError(null);
  };

  const submitPreset = () => {
    if (!name.trim()) return setError(t('split.needName'));
    if (editing?.kind === 'preset') updatePreset(editing.id, name.trim(), command.trim());
    else addPreset(name.trim(), command.trim());
    clear();
  };

  const submitLayout = () => {
    if (!name.trim()) return setError(t('split.needName'));
    const panes = parseLayoutPanes(panesText);
    if (panes.length === 0) return setError(t('split.needPanes'));
    if (editing?.kind === 'layout') updateLayout(editing.id, name.trim(), panes);
    else addLayout(name.trim(), panes);
    clear();
  };

  const inputClass = 'w-full rounded border border-border bg-input px-2.5 py-1.5 text-sm';
  const rowClass =
    'flex items-center gap-2 rounded border border-border bg-muted/40 px-2.5 py-1.5';
  const iconBtn =
    'flex-none rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground';

  const field = (label: string, hint: string | null, input: React.ReactNode) => (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">
        {label}
        {hint && <span className="ml-1 opacity-70">· {hint}</span>}
      </span>
      {input}
    </label>
  );

  const tabBtn = (id: 'presets' | 'layouts', label: string) => (
    <button
      type="button"
      onClick={() => {
        setTab(id);
        clear();
      }}
      aria-selected={tab === id}
      role="tab"
      className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
        tab === id
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
      data-testid={`splits-tab-${id}`}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('split.title')}
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-background shadow-xl"
      >
        <div className="border-b border-border px-4 py-3">
          <div className="text-sm font-medium">{t('split.title')}</div>
          <div className="mb-2.5 text-xs text-muted-foreground">{t('split.subtitle')}</div>
          <div role="tablist" aria-label={t('split.title')} className="flex gap-1">
            {tabBtn('presets', t('split.presets'))}
            {tabBtn('layouts', t('split.layouts'))}
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          {tab === 'presets' ? (
            <>
              <ul className="mb-3 flex flex-col gap-1.5">
                {[PLAIN_PRESET, ...presets].map((p) => {
                  const builtin = p.id === PLAIN_PRESET.id;
                  return (
                    <li key={p.id} className={rowClass}>
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
                            onClick={() => editPreset(p.id, p.name, p.command)}
                            className={iconBtn}
                            title={t('split.edit')}
                            data-testid={`edit-preset-${p.id}`}
                          >
                            {t('split.edit')}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (editing?.id === p.id) clear();
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
                  {editing?.kind === 'preset' ? t('split.editPreset') : t('split.newPreset')}
                </div>
                {field(
                  t('split.name'),
                  null,
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
                  null,
                  <input
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="df -h"
                    className={`${inputClass} font-mono`}
                    data-testid="preset-command"
                  />,
                )}
                <div className="flex justify-end gap-2">
                  {editing?.kind === 'preset' && (
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
                    onClick={submitPreset}
                    className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                    data-testid="add-preset"
                  >
                    {editing?.kind === 'preset' ? t('split.save') : t('split.addPreset')}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              {layouts.length === 0 ? (
                <p className="mb-3 text-sm text-muted-foreground">{t('split.noLayouts')}</p>
              ) : (
                <ul className="mb-3 flex flex-col gap-1.5">
                  {layouts.map((l) => (
                    <li key={l.id} className={rowClass}>
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
                        onClick={() => editLayout(l.id, l.name, l.panes)}
                        className={iconBtn}
                        title={t('split.edit')}
                        data-testid={`edit-layout-${l.id}`}
                      >
                        {t('split.edit')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (editing?.id === l.id) clear();
                          removeLayout(l.id);
                        }}
                        className={iconBtn}
                        title={t('split.remove')}
                        data-testid={`remove-layout-${l.id}`}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-col gap-2.5 border-t border-border pt-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {editing?.kind === 'layout' ? t('split.editLayout') : t('split.newLayout')}
                </div>
                {field(
                  t('split.name'),
                  null,
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Deploy watch"
                    className={inputClass}
                    data-testid="layout-name"
                  />,
                )}
                {field(
                  t('split.panes'),
                  t('split.panesHint'),
                  <textarea
                    value={panesText}
                    onChange={(e) => setPanesText(e.target.value)}
                    rows={4}
                    spellCheck={false}
                    placeholder={'shell =\nload = top\ndisk = df -h'}
                    className={`${inputClass} resize-y font-mono leading-relaxed`}
                    data-testid="layout-panes"
                  />,
                )}
                <div className="flex justify-end gap-2">
                  {editing?.kind === 'layout' && (
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
                    onClick={submitLayout}
                    className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                    data-testid="add-layout"
                  >
                    {editing?.kind === 'layout' ? t('split.save') : t('split.addLayout')}
                  </button>
                </div>
              </div>
            </>
          )}

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
