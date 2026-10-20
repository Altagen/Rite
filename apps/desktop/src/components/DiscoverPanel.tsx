/**
 * Discover (ADR 0016) — collections offered to the teams I'm in, grouped by team, with
 * request-access. Discovery labels are plaintext (RBAC-gated to the team), NOT the encrypted
 * name; the machines stay end-to-end encrypted until a key-holder grants me. Mirrors the
 * "Discover" tab of design/mock/collections.html.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Backend, type OfferedCollection } from '../utils/backend';
import { IconCollection } from './icons';
import { useTranslation } from '../i18n/i18n';

export function DiscoverPanel() {
  const { t } = useTranslation();
  const [offered, setOffered] = useState<OfferedCollection[]>([]);
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setOffered(await Backend.Collections.offered());
    } catch {
      setError(t('discover.errLoad'));
    }
  }, [t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    refresh();
  }, [refresh]);

  const request = (id: string) => {
    setBusy(id);
    setError(null);
    void (async () => {
      try {
        await Backend.Collections.requestAccess(id);
        setRequested((prev) => new Set(prev).add(id));
      } catch (err) {
        setError(err instanceof Error ? err.message : t('discover.errRequest'));
      } finally {
        setBusy(null);
      }
    })();
  };

  // Group by team (each offer carries its team name).
  const byTeam = useMemo(() => {
    const m = new Map<string, OfferedCollection[]>();
    for (const o of offered) {
      const arr = m.get(o.teamName) ?? [];
      arr.push(o);
      m.set(o.teamName, arr);
    }
    return [...m.entries()];
  }, [offered]);

  return (
    <main className="min-w-0 flex-1 overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-[820px]">
        <h1 className="mb-1 text-2xl font-bold">{t('discover.title')}</h1>
        <p className="mb-4 text-sm text-muted-foreground">{t('discover.subtitle')}</p>

        <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-primary/25 bg-primary/[0.08] p-3 text-sm text-foreground/80">
          <IconCollection className="mt-0.5 h-4 w-4 flex-none text-primary" />
          <div>
            <b>{t('discover.labelsTitle')}</b> {t('discover.labelsWhy')}
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-red-500/20 bg-red-500/10 p-2 text-sm text-red-600">
            {error}
          </div>
        )}

        {byTeam.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t('discover.empty')}
          </div>
        )}

        {byTeam.map(([team, offers]) => (
          <section
            key={team}
            className="mb-4 overflow-hidden rounded-2xl border border-border bg-card"
          >
            <div className="border-b border-border px-4 py-3 text-sm font-semibold">
              {team} · {t('discover.offered', { count: offers.length })}
            </div>
            {offers.map((o) => {
              const isMember = o.memberRole !== null;
              const pending = requested.has(o.id);
              return (
                <div
                  key={o.id}
                  className="flex items-center gap-3.5 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <IconCollection className="h-5 w-5 flex-none text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{o.discoveryLabel}</div>
                    <div className="text-xs text-muted-foreground">
                      {isMember ? t('discover.youAreMember') : t('discover.encrypted')}
                    </div>
                  </div>
                  {isMember ? (
                    <span className="rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-semibold uppercase text-green-600">
                      {t('discover.member')}
                    </span>
                  ) : pending ? (
                    <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-semibold uppercase text-amber-600">
                      {t('discover.requested')}
                    </span>
                  ) : (
                    <button
                      onClick={() => request(o.id)}
                      disabled={busy === o.id}
                      className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                      {t('discover.request')}
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </main>
  );
}
