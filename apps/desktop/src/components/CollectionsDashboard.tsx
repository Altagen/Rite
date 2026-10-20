/**
 * The user's collection manager at the `/collections` route (ADR 0016) — the
 * collections I'm a member of, opened from the header. A dedicated page (top bar +
 * the master-detail CollectionsPanel: rail on the left, editor on the right),
 * matching design/mock/collections.html.
 */

import { useRef, useState } from 'react';
import { useServerSession } from '../store/serverSessionStore';
import { CollectionsPanel } from './CollectionsPanel';
import { DiscoverPanel } from './DiscoverPanel';
import { OverlayHeaderControls } from './OverlayHeaderControls';
import riteLogo from '../assets/rite.png';
import { useTranslation } from '../i18n/i18n';

export function CollectionsDashboard() {
  const { t } = useTranslation();
  const { mode } = useServerSession();
  const [tab, setTab] = useState<'mine' | 'discover'>('mine');
  // The header, for OverflowNav's fit measurement (see OverlayHeaderControls).
  const appbarRef = useRef<HTMLElement>(null);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <header ref={appbarRef} className="m-appbar m-appbar-fit">
        <div className="m-brand flex items-center gap-2.5">
          <img src={riteLogo} alt="Rite" className="h-[26px] rounded-[7px]" />
        </div>
        {mode?.instanceName && (
          <span className="m-chip" title={t('coll.instance')}>
            <span className="m-dot" />
            {mode.instanceName}
          </span>
        )}
        <span className="m-spacer" />
        <OverlayHeaderControls appbarRef={appbarRef} />
      </header>
      <nav className="flex gap-1 border-b border-border bg-input px-4 pt-1.5">
        {(['mine', 'discover'] as const).map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            className={`border-b-2 px-3.5 py-2 text-sm font-semibold transition ${
              tab === tb
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tb === 'mine' ? t('coll.mine') : t('coll.discover')}
          </button>
        ))}
      </nav>
      {tab === 'mine' ? <CollectionsPanel /> : <DiscoverPanel />}
    </div>
  );
}
