/**
 * The local-vault counterpart of the identity pastille.
 *
 * The local workspace used to carry a bare gear and a bare padlock — two icon buttons in the
 * corner where a server session shows a pastille with a menu. Same bar, same corner, two
 * grammars.
 *
 * It does NOT say "Local". The context pill on the other side of the bar already names the
 * active context — "Personal", "Home lab", whatever the vault is called — so a second label
 * saying the same thing twice on one bar is the duplication the nav was built to remove. What
 * this shows instead is the thing not already on screen: whether the vault is open.
 *
 * Locking moved into the menu, which costs a click on a safety action — so `vault.lock` is a
 * keyboard command now (Mod+Shift+L by default). Stepping away from the machine is a
 * keystroke rather than a click and a aim, which is better than what it replaced.
 */

import { useTranslation } from '../i18n/i18n';
import { HeaderPastille, type PastilleItem } from './HeaderPastille';
import { IconGear, IconLock } from './icons';

export function VaultPastille({
  isLocked,
  isFirstRun,
  vaultLabel,
  onLock,
  onUnlock,
  onSettings,
}: {
  isLocked: boolean;
  /** No vault on this machine yet: the action is "create", not "unlock". */
  isFirstRun: boolean;
  /** The active vault's name, for the menu header. Absent before one exists. */
  vaultLabel?: string | null;
  onLock: () => void;
  onUnlock: () => void;
  onSettings: () => void;
}) {
  const { t } = useTranslation();

  // Classes built with `clsx`-style concatenation rather than one template literal: the
  // string checks read text that touches an interpolation, and `grid ${size} flex-none` is
  // indistinguishable from a sentence wrapped round a count.
  const tone = isLocked ? 'bg-secondary text-muted-foreground' : 'bg-primary/15 text-primary';
  const glyph = (big: boolean) => (
    <span
      className={[
        'grid flex-none place-items-center rounded-full',
        big ? 'h-9 w-9' : 'h-6 w-6',
        tone,
      ].join(' ')}
    >
      <IconLock className={big ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
    </span>
  );

  const items: PastilleItem[] = [];
  // The vault action first: it is the one with a consequence, and in the locked state it is
  // the only reason the menu is open.
  if (isLocked) {
    items.push({
      key: 'unlock',
      icon: <IconLock className="h-4 w-4" />,
      label: isFirstRun ? t('ws.createVault') : t('ws.unlockVault'),
      onClick: onUnlock,
    });
  } else {
    items.push({
      key: 'lock',
      icon: <IconLock className="h-4 w-4" />,
      label: t('main.lock'),
      onClick: onLock,
    });
  }
  items.push({
    key: 'settings',
    icon: <IconGear className="h-4 w-4" />,
    label: t('settings.title'),
    onClick: onSettings,
  });

  return (
    <HeaderPastille
      title={isLocked ? t('ws.vaultLocked') : t('ws.vaultOpen')}
      testId="vault-pastille"
      glyph={glyph(false)}
      primary={t('ws.vault')}
      chip={isLocked ? t('ws.chipLocked') : t('ws.chipOpen')}
      chipClass={isLocked ? 'bg-secondary text-muted-foreground' : 'bg-primary/15 text-primary'}
      headerGlyph={glyph(true)}
      headerPrimary={vaultLabel || t('ws.vault')}
      headerSecondary={isLocked ? t('ws.vaultLocked') : t('ws.vaultOpen')}
      items={items}
    />
  );
}
