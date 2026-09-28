/**
 * Import SSH hosts by pasting an OpenSSH config (accounts/server context).
 *
 * The server must never touch the user's filesystem, so there is no file path and
 * no upload: the config text is pasted, parsed **in the browser**, and the chosen
 * hosts are saved into a collection (ADR 0016) — each encrypted client-side with
 * the collection key via the connection source's create path. Passwords are never
 * in an SSH config, so imported hosts start key-based (edit them afterwards).
 */

import { useMemo, useState } from 'react';
import { type CreateConnectionInput } from '../store/connectionsStore';

interface ParsedHost {
  name: string;
  hostname: string;
  user: string;
  port: number;
  identityFile?: string;
}

/** Minimal OpenSSH config parser: Host blocks with HostName/User/Port/IdentityFile. */
function parseSshConfig(text: string): ParsedHost[] {
  const hosts: ParsedHost[] = [];
  let current: ParsedHost | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'host') {
      // A Host line may list several aliases; skip pure wildcards.
      const alias = value.split(/\s+/).find((a) => !a.includes('*') && !a.includes('?'));
      if (current && current.hostname) hosts.push(current);
      current = alias ? { name: alias, hostname: '', user: '', port: 22 } : null;
    } else if (current) {
      if (key === 'hostname') current.hostname = value;
      else if (key === 'user') current.user = value;
      else if (key === 'port') current.port = Number(value) || 22;
      else if (key === 'identityfile') current.identityFile = value;
    }
  }
  if (current && current.hostname) hosts.push(current);
  // Fall back to the alias as the hostname when HostName is omitted.
  return hosts.map((h) => ({ ...h, hostname: h.hostname || h.name }));
}

export function ImportSSHPasteModal({
  collectionTargets,
  defaultCollectionId,
  create,
  onClose,
  onImported,
}: {
  collectionTargets: { id: string; name: string }[];
  defaultCollectionId?: string | null;
  create: (input: CreateConnectionInput) => Promise<void>;
  onClose: () => void;
  onImported: (count: number) => void;
}) {
  const [text, setText] = useState('');
  const [collectionId, setCollectionId] = useState(defaultCollectionId ?? collectionTargets[0]?.id ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [parsed, setParsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hosts = useMemo(() => parseSshConfig(text), [text]);

  const doParse = () => {
    const found = parseSshConfig(text);
    setSelected(new Set(found.map((h) => h.name)));
    setParsed(true);
    setError(found.length === 0 ? 'No hosts found in the pasted config.' : null);
  };

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const doImport = async () => {
    if (!collectionId) {
      setError('Choose a collection to import into.');
      return;
    }
    const chosen = hosts.filter((h) => selected.has(h.name));
    if (chosen.length === 0) {
      setError('Select at least one host.');
      return;
    }
    setBusy(true);
    setError(null);
    let count = 0;
    try {
      for (const h of chosen) {
        await create({
          name: h.name,
          protocol: 'SSH',
          hostname: h.hostname,
          port: h.port,
          username: h.user,
          authMethod: h.identityFile
            ? { type: 'publicKey', keyPath: h.identityFile }
            : { type: 'password', password: '' },
          collectionId,
        });
        count += 1;
      }
      onImported(count);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Import from SSH config</h3>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="mb-3 text-sm text-muted-foreground">
          Paste your <span className="font-mono">~/.ssh/config</span>. It's parsed in your browser and never uploaded —
          selected hosts become machines in the chosen collection (encrypted with its key).
        </p>

        {error && (
          <div className="mb-3 rounded-md border border-red-500/20 bg-red-500/10 p-2 text-sm text-red-600">{error}</div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setParsed(false);
            }}
            placeholder={'Host prod\n  HostName 10.0.0.5\n  User deploy\n  Port 22'}
            rows={6}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
            disabled={busy}
          />

          {!parsed ? (
            <button
              onClick={doParse}
              disabled={busy || !text.trim()}
              className="mt-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              Parse hosts
            </button>
          ) : (
            <>
              <div className="mt-3 text-xs font-medium text-muted-foreground">{hosts.length} host(s) found</div>
              <ul className="mt-1 space-y-1">
                {hosts.map((h) => (
                  <li key={h.name}>
                    <label className="flex cursor-pointer items-center gap-2 rounded border border-border px-3 py-1.5 text-sm hover:bg-muted">
                      <input type="checkbox" checked={selected.has(h.name)} onChange={() => toggle(h.name)} />
                      <span className="font-medium">{h.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {h.user ? `${h.user}@` : ''}
                        {h.hostname}:{h.port}
                        {h.identityFile ? ' · key' : ''}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <div className="flex-1 space-y-1">
            <label htmlFor="import-coll" className="text-xs font-medium text-muted-foreground">
              Into collection
            </label>
            <select
              id="import-coll"
              value={collectionId}
              onChange={(e) => setCollectionId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              disabled={busy}
            >
              {collectionTargets.length === 0 && <option value="">No writable collection</option>}
              {collectionTargets.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <button onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
            Cancel
          </button>
          <button
            onClick={doImport}
            disabled={busy || !parsed || selected.size === 0 || !collectionId}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Importing…' : `Import ${selected.size || ''}`.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}
