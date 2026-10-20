/**
 * The full Notifications page at `/notifications` — opened from the header bell's
 * "See all notifications →". A dedicated, paginated list so an inbox with many pending
 * access requests stays usable (the bell dropdown only shows the latest few). Same grant/
 * dismiss actions as the dropdown, backed by the shared useAccessRequests controller.
 * Matches design/mock/notifications.html (frontend-only; the one real notification type
 * today is a collection access request).
 */

import { useRef, useState } from 'react';
import { useServerSession } from '../store/serverSessionStore';
import { useAccessRequests } from '../store/accessRequests';
import { RequestRow } from './AccessRequestsInbox';
import { OverlayHeaderControls } from './OverlayHeaderControls';
import riteLogo from '../assets/rite.png';
import { useTranslation } from '../i18n/i18n';

const PER_PAGE = 8;

export function NotificationsDashboard() {
  const { t } = useTranslation();
  const { mode } = useServerSession();
  const ctl = useAccessRequests();
  const { requests, error } = ctl;
  const [page, setPage] = useState(0);

  // Keep the page in range if the list shrinks (a grant/dismiss removes a row). Close/Esc live
  // in OverlayHeaderControls.
  const pageCount = Math.max(1, Math.ceil(requests.length / PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  if (safePage !== page) setPage(safePage);
  const slice = requests.slice(safePage * PER_PAGE, safePage * PER_PAGE + PER_PAGE);

  // The header, for OverflowNav's fit measurement (see OverlayHeaderControls).
  const appbarRef = useRef<HTMLElement>(null);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <header ref={appbarRef} className="m-appbar m-appbar-fit">
        <div className="m-brand flex items-center gap-2.5">
          <img src={riteLogo} alt="Rite" className="h-[26px] rounded-[7px]" />
        </div>
        {mode?.instanceName && (
          <span className="m-chip" title={t('notif.instance')}>
            <span className="m-dot" />
            {mode.instanceName}
          </span>
        )}
        <span className="m-spacer" />
        <OverlayHeaderControls appbarRef={appbarRef} />
      </header>

      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-7">
        <div className="mx-auto w-full max-w-3xl">
          <div className="mb-5 flex items-center gap-3.5">
            <h1 className="text-[22px] font-bold">{t('notif.title')}</h1>
            <span className="text-[13px] text-muted-foreground">
              {requests.length === 0
                ? t('notif.nothing')
                : t('notif.pending', { count: requests.length })}
            </span>
          </div>

          {error && (
            <div className="mb-4 rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">
              {error}
            </div>
          )}

          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            {requests.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-secondary text-muted-foreground">
                  <svg
                    className="h-6 w-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"
                    />
                  </svg>
                </div>
                <div className="text-sm font-medium">{t('notif.caughtUp')}</div>
                <div className="mt-1 text-sm text-muted-foreground">{t('notif.caughtUpWhy')}</div>
              </div>
            ) : (
              slice.map((r) => (
                <div key={ctl.keyOf(r)} className="border-b border-border last:border-b-0">
                  <RequestRow r={r} ctl={ctl} />
                </div>
              ))
            )}
          </div>

          {pageCount > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {t('notif.page', { page: safePage + 1, total: pageCount })}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40"
                >
                  {t('notif.prev')}
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={safePage >= pageCount - 1}
                  className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40"
                >
                  {t('notif.next')}
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
