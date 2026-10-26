/**
 * The hosts this member trusts, and the only clean way back from a rotated key.
 *
 * WHY IT EXISTS. `docs/ROADMAP.md` carried this gap from 0.2.4: nothing listed what was
 * trusted and nothing forgot a key. A changed host key is refused in every mode and the
 * dialog that reports it deliberately offers no accept (ADR 0021 §3), so a server that was
 * legitimately reinstalled had no path through — except Quick SSH, which force-accepts
 * BEFORE verification runs (§5) and overwrites the stored key without showing that it
 * changed. Forgetting the old key turns the rotation back into a first contact, which is
 * what an OpenSSH user already does with `ssh-keygen -R`.
 *
 * WHOSE LIST IT IS. Trust is per member (ADR 0021, addendum), and the server scopes every
 * one of these calls to the caller's session — a client cannot name an owner, which is
 * also what keeps one member's hosts from telling another where they connect. The wording
 * says so, impersonally like every other label, because a list that read as instance-wide
 * would teach the wrong model.
 *
 * Mirrors `design/mock/desktop.html` → Settings → SSH, which is the source of truth for
 * the shape (ADR 0019).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { BackendSsh, type KnownHost } from '../utils/backend';

/** How long ago, in the words a locale gives, or nothing when it has never been seen. */
function seenLabel(host: KnownHost, t: (k: string, v?: Record<string, string>) => string) {
  // `last_seen_at` is stamped when a connection matches the key, and starts equal to
  // `added_at`. Equal means "trusted, never used since", which is worth saying plainly
  // rather than rendering as "seen just now".
  if (host.lastSeenAt <= host.addedAt) return t('settings.knownHostsNever');
  const days = Math.floor((Date.now() / 1000 - host.lastSeenAt) / 86_400);
  const when =
    days <= 0
      ? new Date(host.lastSeenAt * 1000).toLocaleTimeString()
      : new Date(host.lastSeenAt * 1000).toLocaleDateString();
  return t('settings.knownHostsSeen', { when });
}

export function KnownHostsList() {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<KnownHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  /**
   * Bumped to ask for the list again.
   *
   * The fetch lives in the effect with a `cancelled` flag and sets state only from the
   * promise, which is the shape the rest of this app uses (see `AuthSection`'s agent
   * identities) and the one `react-hooks/set-state-in-effect` is asking for: subscribe to
   * an external system, and set state when it answers.
   */
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    BackendSsh.listHostKeys()
      .then((list) => {
        if (cancelled) return;
        setHosts(list);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError(t('settings.knownHostsErr'));
      });
    return () => {
      cancelled = true;
    };
  }, [reloads, t]);

  const forget = async (host: KnownHost) => {
    setForgetting(host.id);
    try {
      await BackendSsh.forgetHostKey(host.host, host.port);
      // Asked again rather than spliced out of local state: the list is the server's
      // answer, and a row removed here that the server still holds would be a lie about
      // what is trusted.
      setReloads((n) => n + 1);
    } catch {
      setError(t('settings.knownHostsForgetErr'));
    } finally {
      setForgetting(null);
    }
  };

  return (
    <div className="border-b border-border px-0.5 py-3" data-testid="known-hosts">
      <div className="text-sm font-medium">{t('settings.knownHosts')}</div>
      <p className="mt-0.5 mb-2 text-xs text-muted-foreground">
        {t('settings.knownHostsDesc')}
      </p>

      {error && (
        <p className="mb-2 text-sm text-red-500" data-testid="known-hosts-error">
          {error}
        </p>
      )}

      {hosts === null && !error && (
        <p className="text-sm text-muted-foreground">{t('settings.knownHostsLoading')}</p>
      )}

      {hosts !== null && hosts.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="known-hosts-empty">
          {t('settings.knownHostsEmpty')}
        </p>
      )}

      {hosts !== null && hosts.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {hosts.map((h) => (
            <div
              key={h.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 p-2"
              data-testid="known-host-row"
              data-host={h.host}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {/* The port only when it is not the default: a ":22" on every row is
                      noise on every row, and a non-default port IS a different host. */}
                  {h.port === 22 ? h.host : `${h.host}:${h.port}`}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {h.keyType} · {h.fingerprint} · {seenLabel(h, t)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void forget(h)}
                disabled={forgetting === h.id}
                className="flex-none rounded border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                data-testid="known-host-forget"
              >
                {t('settings.knownHostsForget')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
