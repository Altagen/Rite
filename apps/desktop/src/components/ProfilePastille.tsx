/**
 * Identity pastille (accounts context) — who is signed in and where, with the personal
 * actions behind it. The chrome is `HeaderPastille`, shared with the local-vault context so
 * the same corner of the same bar reads the same way whichever context a window holds.
 *
 * Matches the profile chip in design/mock/web.html and desktop.html.
 */

import { useTranslation } from '../i18n/i18n';
import { HeaderPastille } from './HeaderPastille';
import { IconGear } from './icons';

const ROLE_PILL: Record<string, string> = {
  admin: 'bg-primary/15 text-primary',
  manager: 'bg-amber-500/15 text-amber-600',
  user: 'bg-secondary text-muted-foreground',
};

function SignOutIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"
      />
    </svg>
  );
}

export function ProfilePastille({
  username,
  role,
  instanceName,
  onSettings,
  onSignOut,
}: {
  username: string;
  role: string;
  instanceName?: string | null;
  onSettings: () => void;
  onSignOut: () => void;
}) {
  const { t } = useTranslation();
  const initials = username.slice(0, 2).toUpperCase();
  const avatar = (size: string) => (
    <span
      className={`grid ${size} flex-none place-items-center rounded-full bg-primary/15 text-xs font-bold uppercase text-primary`}
    >
      {initials}
    </span>
  );

  return (
    <HeaderPastille
      title={t('profile.hint')}
      testId="profile-pastille"
      glyph={avatar('h-6 w-6')}
      primary={username}
      chip={role}
      chipClass={ROLE_PILL[role] ?? ROLE_PILL.user}
      headerGlyph={avatar('h-9 w-9')}
      headerPrimary={username}
      headerSecondary={
        instanceName ? t('profile.signedInOn', { instance: instanceName }) : t('profile.signedIn')
      }
      items={[
        {
          key: 'settings',
          icon: <IconGear className="h-4 w-4" />,
          label: t('settings.title'),
          onClick: onSettings,
        },
        {
          key: 'sign-out',
          icon: <SignOutIcon />,
          label: t('profile.signOut'),
          onClick: onSignOut,
        },
      ]}
    />
  );
}
