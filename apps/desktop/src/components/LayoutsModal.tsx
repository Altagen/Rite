/**
 * The layouts file, shown as a file.
 *
 * Not a form over a file. A form would need a widget invented for every key the file
 * grows, and the file is the thing people copy between computers, mail to a colleague
 * and commit — so the file is what this shows. Save stores the text and re-parses it;
 * a file that does not parse keeps the layouts you already had, and says which line
 * stopped making sense.
 *
 * Underneath, what it opens, resolved against the library you actually have. The
 * interesting question is not "is my TOML valid" but "will this open what I think it
 * opens, on this computer, today" — so a machine the file names and the library does
 * not have is called out here, before you open the layout and find out.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { useLayouts } from '../store/layouts';
import { paneLabel, type Layout } from '../store/layoutsFormat';

interface Props {
  onClose: () => void;
  /** The machines this context can open, for resolving what the file names. Only
   *  their names matter here, so that is all this asks for. */
  connections: { name: string }[];
  /** False when the vault is locked: names cannot be resolved at all, which is not
   *  the same as a name being wrong, and the reader deserves the difference. */
  libraryReadable: boolean;
}

export function LayoutsModal({ onClose, connections, libraryReadable }: Props) {
  const { t } = useTranslation();
  const { text, path, layouts, error, load, save } = useLayouts();
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // The file may have been edited elsewhere (it is a file), so re-read on open.
  useEffect(() => {
    void load();
  }, [load]);

  // When the stored text changes under us — the reload above, or a save — the editor
  // follows it. Adjusted during render rather than in an effect: an effect would
  // paint the old text once first, and the reload is the whole point of the button.
  const [lastSeen, setLastSeen] = useState(text);
  if (lastSeen !== text) {
    setLastSeen(text);
    setDraft(text);
  }

  const onSave = async () => {
    setBusy(true);
    try {
      await save(draft);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } finally {
      setBusy(false);
    }
  };

  const known = new Set(connections.map((c) => c.name));
  const paneWhere = (machine: string | undefined) => {
    if (!machine) return { label: t('layouts.thisComputer'), ok: true };
    if (!libraryReadable) return { label: `${machine} — ${t('layouts.needsVault')}`, ok: false };
    if (!known.has(machine)) return { label: `${machine} — ${t('layouts.notInLibrary')}`, ok: false };
    return { label: machine, ok: true };
  };

  const row = (layout: Layout) => (
    <li key={layout.id} className="rounded border border-border bg-muted/40 px-2.5 py-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="truncate text-sm font-medium">{layout.name}</span>
        <span className="flex-none rounded border border-border px-1 text-[10px] font-semibold text-muted-foreground">
          {t('split.panesCount', { count: layout.panes.length })}
        </span>
        {layout.startup && (
          <span className="flex-none rounded border border-primary px-1 text-[10px] font-semibold text-primary">
            {t('layouts.atStartup')}
          </span>
        )}
      </div>
      {layout.panes.map((pane, i) => {
        const where = paneWhere(pane.machine);
        return (
          <div key={i} className="flex gap-2 py-0.5 text-xs">
            <span className={`w-44 flex-none truncate ${where.ok ? 'text-muted-foreground' : 'text-amber-500'}`}>
              {where.label}
            </span>
            <code className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
              {pane.command || t('layouts.plainShell')}
            </code>
            <span className="flex-none text-muted-foreground">{paneLabel(pane)}</span>
          </div>
        );
      })}
    </li>
  );

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('layouts.title')}
        className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
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

        <div className="flex-none border-b border-border px-4 py-3 pr-12">
          <div className="text-sm font-medium">{t('layouts.title')}</div>
          <div className="text-xs text-muted-foreground">{t('layouts.subtitle')}</div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-2 text-xs leading-relaxed text-muted-foreground">{t('layouts.lede')}</p>

          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            {path ? (
              <code className="min-w-0 flex-1 truncate font-mono" title={path} data-testid="layouts-path">
                {path}
              </code>
            ) : (
              <span className="min-w-0 flex-1">{t('layouts.noPath')}</span>
            )}
            <button
              type="button"
              onClick={() => void load()}
              className="flex-none rounded border border-border px-2 py-1 hover:bg-muted"
              data-testid="layouts-reload"
            >
              {t('layouts.reload')}
            </button>
          </div>

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={14}
            className="w-full resize-y rounded border border-border bg-input px-2.5 py-2 font-mono text-xs leading-relaxed"
            data-testid="layouts-file"
          />

          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={busy}
              className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              data-testid="layouts-save"
            >
              {t('layouts.save')}
            </button>
            {saved && !error && (
              <span className="text-xs text-muted-foreground" data-testid="layouts-saved">
                {t('layouts.saved')}
              </span>
            )}
          </div>

          {error ? (
            <p
              className="mt-2 rounded border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs leading-relaxed"
              data-testid="layouts-error"
            >
              <span className="font-semibold">{t('layouts.notLoaded')}</span>{' '}
              {error.line > 0 ? t('layouts.atLine', { line: error.line }) : null} {error.message}
              <span className="mt-1 block text-muted-foreground">{t('layouts.keptRunning')}</span>
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="layouts-ok">
              {t('layouts.loaded', { count: layouts.length })}
            </p>
          )}

          <div className="mt-4 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('layouts.whatItOpens')}
          </div>
          <ul className="mt-1.5 flex flex-col gap-1.5">{layouts.map(row)}</ul>
        </div>
      </div>
    </div>
  );
}
