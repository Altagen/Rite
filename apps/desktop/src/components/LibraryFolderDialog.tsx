/**
 * Create or rename a top-level personal folder (ADR 0016 view hierarchy). Purely
 * a name + colour picker; persistence is the caller's (the encrypted library tree).
 */

import { useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { MACHINE_SWATCHES } from '../theme/swatches';

export function LibraryFolderDialog({
  initialName,
  initialColor,
  onClose,
  onSave,
}: {
  initialName?: string;
  initialColor?: string | null;
  onClose: () => void;
  onSave: (name: string, color: string) => void | Promise<void>;
}) {
  const editing = initialName !== undefined;
  const { t } = useTranslation();
  const [name, setName] = useState(initialName ?? '');
  const [color, setColor] = useState(initialColor ?? MACHINE_SWATCHES[0]);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(name.trim(), color);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-lg font-semibold">{editing ? t('fold.rename') : t('fold.new')}</h3>

        <label className="mb-1 block text-sm font-medium">{t('dlg.name')}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder={t('fold.phLibrary')}
          className="mb-4 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          disabled={busy}
        />

        <label className="mb-1 block text-sm font-medium">{t('dlg.colour')}</label>
        <div className="mb-5 flex flex-wrap gap-2">
          {MACHINE_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`h-7 w-7 rounded-full ${color === c ? 'ring-2 ring-foreground ring-offset-2 ring-offset-card' : ''}`}
              style={{ backgroundColor: c }}
              aria-label={t('dlg.colourAria', { hex: c })}
            />
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
          >
            {t('dlg.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {editing ? t('dlg.save') : t('dlg.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
