/**
 * Import SSH Config Modal (desktop)
 *
 * Reads ~/.ssh/config from disk — which only a local shell can do — and imports
 * the chosen hosts into a collection. Parsing stays server-side because the file
 * lives there; creating goes through the connection source like any other machine,
 * so imported hosts land in the same store as hand-made ones (ADR 0018). The web
 * shell has no file access and uses ImportSSHPasteModal instead.
 */

import { useState, useEffect } from 'react';
import { useTranslation } from '../i18n/i18n';
import { Backend, type SshConfigEntry } from '../utils/backend';
import type { CreateConnectionInput } from '../store/connectionsStore';

interface ImportSSHConfigModalProps {
  onClose: () => void;
  onImported: (count: number) => void;
  /** Collections the machines may be imported into (no loose machines, ADR 0016). */
  collectionTargets: { id: string; name: string }[];
  defaultCollectionId?: string | null;
  create: (input: CreateConnectionInput) => Promise<void>;
}

interface SelectableSshConfigEntry extends SshConfigEntry {
  selected: boolean;
  preview: string;
}

export function ImportSSHConfigModal({
  onClose,
  onImported,
  collectionTargets,
  defaultCollectionId,
  create,
}: ImportSSHConfigModalProps) {
  const { t } = useTranslation();
  const [collectionId, setCollectionId] = useState(
    defaultCollectionId ?? collectionTargets[0]?.id ?? '',
  );
  const [configPath, setConfigPath] = useState('');
  const [entries, setEntries] = useState<SelectableSshConfigEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [loadingDefault, setLoadingDefault] = useState(true);

  // Load default SSH config path on mount
  useEffect(() => {
    const loadDefaultPath = async () => {
      try {
        const defaultPath = await Backend.Connections.getDefaultSshConfigPath();
        setConfigPath(defaultPath);
      } catch (err) {
        console.error('[ImportSSH] Failed to get default path:', err);
        setConfigPath('~/.ssh/config');
      } finally {
        setLoadingDefault(false);
      }
    };

    loadDefaultPath();
  }, []);

  const handleParse = async () => {
    if (!configPath.trim()) {
      setError(t('sshImport.errPath'));
      return;
    }

    setError('');
    setLoading(true);
    setEntries([]);

    try {
      const parsedEntries = await Backend.Connections.parseSshConfig(configPath);

      // Add preview and selection state
      const selectableEntries: SelectableSshConfigEntry[] = parsedEntries.map((entry) => {
        const hostname = entry.hostname || entry.host;
        const user = entry.user ? `${entry.user}@` : '';
        const port = entry.port && entry.port !== 22 ? `:${entry.port}` : '';
        const preview = `${user}${hostname}${port}`;

        return {
          ...entry,
          selected: false, // All unchecked by default
          preview,
        };
      });

      setEntries(selectableEntries);

      if (selectableEntries.length === 0) {
        setError(t('sshImport.errNoHosts'));
      }
    } catch (err) {
      console.error('[ImportSSH] Parse failed:', err);
      setError(typeof err === 'string' ? err : t('sshImport.errParse'));
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = (index: number) => {
    setEntries((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, selected: !entry.selected } : entry)),
    );
  };

  const handleSelectAll = () => {
    const allSelected = entries.every((e) => e.selected);
    setEntries((prev) => prev.map((entry) => ({ ...entry, selected: !allSelected })));
  };

  const handleImport = async () => {
    const selectedEntries = entries.filter((e) => e.selected);

    if (selectedEntries.length === 0) {
      setError(t('sshImport.errNoneChosen'));
      return;
    }

    setError('');
    setImporting(true);

    try {
      // Create through the source, so an imported host is stored exactly like one
      // added by hand — same collection, same encryption, one code path.
      let count = 0;
      for (const e of selectedEntries) {
        await create({
          name: e.host,
          protocol: 'SSH',
          hostname: e.hostname ?? e.host,
          port: e.port ?? 22,
          username: e.user ?? '',
          authMethod: e.identityFile
            ? { type: 'publicKey', keyPath: e.identityFile }
            : { type: 'password', password: '' },
          collectionId,
        });
        count += 1;
      }

      onImported(count);
      onClose();
    } catch (err) {
      console.error('[ImportSSH] Import failed:', err);
      setError(typeof err === 'string' ? err : t('sshImport.errImport'));
    } finally {
      setImporting(false);
    }
  };

  const selectedCount = entries.filter((e) => e.selected).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-2xl rounded-lg bg-background p-6 shadow-xl border border-border">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold">{t('sshImport.title')}</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            disabled={loading || importing}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <p className="mb-4 text-sm text-muted-foreground">{t('sshImport.subtitle')}</p>

        {/* File Path Input */}
        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium">{t('sshImport.configPath')}</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={loadingDefault ? t('sshImport.loading') : configPath}
              onChange={(e) => setConfigPath(e.target.value)}
              placeholder="~/.ssh/config"
              className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              disabled={loading || importing || loadingDefault}
            />
            <button
              onClick={handleParse}
              className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              disabled={loading || importing || loadingDefault}
            >
              {loading ? t('sshImport.parsing') : t('sshImport.parse')}
            </button>
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-4 rounded border border-red-500 bg-red-500/10 p-3 text-sm text-red-500">
            {error}
          </div>
        )}

        {/* Entries List */}
        {entries.length > 0 && (
          <>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">
                {t('sshImport.found', { count: entries.length })}
              </p>
              <button
                onClick={handleSelectAll}
                className="text-sm text-primary hover:underline"
                disabled={importing}
              >
                {entries.every((e) => e.selected)
                  ? t('sshImport.deselectAll')
                  : t('sshImport.selectAll')}
              </button>
            </div>

            <div className="mb-4 max-h-80 overflow-y-auto rounded border border-border bg-muted/30 p-2">
              {entries.map((entry, index) => (
                <label
                  key={index}
                  className="flex cursor-pointer items-center gap-3 rounded p-2 hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={entry.selected}
                    onChange={() => handleToggle(index)}
                    className="h-4 w-4 rounded text-primary focus:ring-primary"
                    disabled={importing}
                  />
                  <div className="flex-1">
                    <div className="font-medium">{entry.host}</div>
                    <div className="text-sm text-muted-foreground">{entry.preview}</div>
                  </div>
                  {entry.identityFile && (
                    <span className="rounded bg-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
                      {t('sshImport.sshKey')}
                    </span>
                  )}
                </label>
              ))}
            </div>

            <div className="mb-4 rounded bg-muted/50 p-3 text-sm">
              <p className="font-medium">{t('sshImport.workflow')}</p>
              <ul className="mt-1 ml-4 list-disc text-muted-foreground">
                <li>{t('sshImport.noPasswords')}</li>
                <li>
                  {t('sshImport.willHave')}{' '}
                  <span className="font-semibold text-foreground">
                    {t('sshImport.emptyPasswords')}
                  </span>
                </li>
                <li>
                  <span className="font-semibold text-foreground">{t('sshImport.toUseThem')}</span>{' '}
                  {t('sshImport.toUseThemHow')}
                </li>
              </ul>
            </div>
          </>
        )}

        {/* Actions */}
        <div className="flex items-end justify-end gap-3">
          {/* No loose machines (ADR 0016): imported hosts land in a collection. */}
          <div className="mr-auto">
            <label htmlFor="import-file-coll" className="mb-1 block text-xs text-muted-foreground">
              {t('sshImport.importInto')}
            </label>
            <select
              id="import-file-coll"
              value={collectionId}
              onChange={(e) => setCollectionId(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              disabled={loading || importing}
            >
              {collectionTargets.length === 0 && (
                <option value="">{t('sshImport.noCollection')}</option>
              )}
              {collectionTargets.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={onClose}
            className="rounded bg-secondary px-4 py-2 font-medium text-secondary-foreground hover:bg-secondary/80"
            disabled={loading || importing}
          >
            {t('dlg.cancel')}
          </button>
          <button
            onClick={handleImport}
            className="rounded bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2"
            disabled={loading || importing || selectedCount === 0 || !collectionId}
          >
            {importing && (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-solid border-current border-r-transparent" />
            )}
            {importing
              ? t('sshImport.importing', { count: selectedCount })
              : t('sshImport.importSelected', { count: selectedCount })}
          </button>
        </div>
      </div>
    </div>
  );
}
