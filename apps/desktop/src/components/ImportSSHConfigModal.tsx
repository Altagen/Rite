/**
 * Import SSH Config Modal
 *
 * Allows users to import connections from their SSH config file
 */

import { useState, useEffect } from 'react';
import { Tauri, type SshConfigEntry } from '../utils/tauri';

interface ImportSSHConfigModalProps {
  onClose: () => void;
  onImported: (count: number) => void;
}

interface SelectableSshConfigEntry extends SshConfigEntry {
  selected: boolean;
  preview: string;
}

export function ImportSSHConfigModal({ onClose, onImported }: ImportSSHConfigModalProps) {
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
        const defaultPath = await Tauri.Connections.getDefaultSshConfigPath();
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
      setError('Please enter a config file path');
      return;
    }

    setError('');
    setLoading(true);
    setEntries([]);

    try {
      console.log('[ImportSSH] Parsing config at:', configPath);
      const parsedEntries = await Tauri.Connections.parseSshConfig(configPath);

      console.log('[ImportSSH] Found entries:', parsedEntries.length);

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
        setError('No valid hosts found in config file');
      }
    } catch (err) {
      console.error('[ImportSSH] Parse failed:', err);
      setError(typeof err === 'string' ? err : 'Failed to parse SSH config file');
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = (index: number) => {
    setEntries((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, selected: !entry.selected } : entry))
    );
  };

  const handleSelectAll = () => {
    const allSelected = entries.every((e) => e.selected);
    setEntries((prev) => prev.map((entry) => ({ ...entry, selected: !allSelected })));
  };

  const handleImport = async () => {
    const selectedEntries = entries.filter((e) => e.selected);

    if (selectedEntries.length === 0) {
      setError('Please select at least one host to import');
      return;
    }

    setError('');
    setImporting(true);

    try {
      console.log('[ImportSSH] Importing', selectedEntries.length, 'entries');

      // Strip the 'selected' and 'preview' fields before sending to backend
      const entriesToImport = selectedEntries.map(({ selected, preview, ...entry }) => entry);

      const imported = await Tauri.Connections.importSshConfigEntries(entriesToImport);

      console.log('[ImportSSH] Successfully imported', imported.length, 'connections');

      onImported(imported.length);
      onClose();
    } catch (err) {
      console.error('[ImportSSH] Import failed:', err);
      setError(typeof err === 'string' ? err : 'Failed to import connections');
    } finally {
      setImporting(false);
    }
  };

  const selectedCount = entries.filter((e) => e.selected).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-2xl rounded-lg bg-background p-6 shadow-xl border border-border">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold">Import SSH Config</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            disabled={loading || importing}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="mb-4 text-sm text-muted-foreground">
          Import connections from your OpenSSH config file
        </p>

        {/* File Path Input */}
        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium">
            Config File Path
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={loadingDefault ? 'Loading...' : configPath}
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
              {loading ? 'Parsing...' : 'Parse'}
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
                Found {entries.length} host{entries.length !== 1 ? 's' : ''}:
              </p>
              <button
                onClick={handleSelectAll}
                className="text-sm text-primary hover:underline"
                disabled={importing}
              >
                {entries.every((e) => e.selected) ? 'Deselect All' : 'Select All'}
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
                      SSH Key
                    </span>
                  )}
                </label>
              ))}
            </div>

            <div className="mb-4 rounded bg-muted/50 p-3 text-sm">
              <p className="font-medium">Important - Workflow:</p>
              <ul className="mt-1 ml-4 list-disc text-muted-foreground">
                <li>SSH config files never contain passwords (security)</li>
                <li>Imported connections will have <span className="font-semibold text-foreground">empty passwords</span></li>
                <li><span className="font-semibold text-foreground">To use them:</span> Click the 3 dots (⋮) on the connection card → Edit → Add password, OR use Quick SSH for temporary connections</li>
              </ul>
            </div>
          </>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded bg-secondary px-4 py-2 font-medium text-secondary-foreground hover:bg-secondary/80"
            disabled={loading || importing}
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            className="rounded bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2"
            disabled={loading || importing || selectedCount === 0}
          >
            {importing && (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-solid border-current border-r-transparent" />
            )}
            {importing
              ? `Importing ${selectedCount}...`
              : `Import Selected (${selectedCount})`}
          </button>
        </div>
      </div>
    </div>
  );
}
