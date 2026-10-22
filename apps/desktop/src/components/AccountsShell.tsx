/**
 * Accounts shell (ADR 0014 phases 2–3): the auth gate + connection source around
 * the shared `Workspace` for a shared-server session.
 *
 * Everyone — member and org-admin — lands in the one workspace (connections +
 * terminals), backed by the browser-crypto accounts source. The org-admin gets an
 * extra header entry that opens the management panels (users, teams, shared
 * connections) as a surface *within* the workspace, rather than a separate screen.
 * A token-only resume (reload without the password) can't decrypt the vault, so it
 * asks the user to sign in again rather than showing an empty shell.
 */

import { lazy, Suspense } from 'react';
import { useServerSession } from '../store/serverSessionStore';
import { useAccountsConnectionsSource } from '../store/accountsConnectionsSource';
import { useRoutePath, navigate } from '../store/route';
import { Workspace } from './Workspace';
/**
 * The admin console, fetched when someone opens it.
 *
 * It is a whole surface — users, teams, invitations, collections, the instance's policies
 * — that most members never open, and on an instance with `serveWebui` off it is the only
 * surface there is. Carrying it in the first chunk charged everyone for it; `lazy` charges
 * whoever asks. `Suspense` renders nothing while it arrives: the console mounts over the
 * workspace, and a spinner over a working page is worse than a beat of nothing.
 */
const AdminDashboard = lazy(() =>
  import('./AdminDashboard').then((m) => ({ default: m.AdminDashboard })),
);
import { AdminOnlyNotice } from './AdminOnlyNotice';
import { CollectionsDashboard } from './CollectionsDashboard';
import { TeamsDashboard } from './TeamsDashboard';
import { NotificationsDashboard } from './NotificationsDashboard';
import { AccessRequestsBell } from './AccessRequestsInbox';
import { ForcePasswordChange } from './ForcePasswordChange';
import { Settings } from './Settings';
import { useSettingsModal } from '../store/settingsModal';
import { useAccountsNav } from './accountsNav';
import { useTranslation } from '../i18n/i18n';

/** Reload without the password left no keys in RAM — re-auth to decrypt. */
function ReauthNotice({ onSignOut }: { onSignOut: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="mx-4 w-full max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-xl">
        <h1 className="mb-2 text-lg font-semibold">{t('reauth.title')}</h1>
        <p className="mb-6 text-sm text-muted-foreground">{t('reauth.why')}</p>
        <button
          onClick={onSignOut}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t('reauth.signIn')}
        </button>
      </div>
    </div>
  );
}

export function AccountsShell() {
  const { user, userKey, logout, mode } = useServerSession();
  const conns = useAccountsConnectionsSource();
  const path = useRoutePath();
  const settingsOpen = useSettingsModal((s) => s.open);
  const setSettingsOpen = useSettingsModal((s) => s.setOpen);
  // The one nav list, shared with every overlay page's bar (accountsNav.tsx). Called
  // here with the other hooks, above the early returns below.
  const nav = useAccountsNav();
  if (!user) return null;

  // A user without the unwrapped vault key (token-only resume) must re-auth.
  if (!userKey) return <ReauthNotice onSignOut={() => logout()} />;

  // Admin-provisioned account still on its initial password → force a change (re-keys the
  // vault) before anything else, so the account becomes zero-knowledge from the admin.
  if (user.mustChangePassword) return <ForcePasswordChange />;

  // Runtime serve-surface gating (rite-admin-console-split): a deployment can turn
  // the admin console and/or the client workspace off. Both default on when absent.
  const serveAdmin = mode?.serveAdmin !== false;
  const serveWebui = mode?.serveWebui !== false;
  // Org management (the /admin console) is open to admins AND managers; the console itself
  // filters its sections by role (managers: users + teams only) and by shell.
  const canManage = (user.role === 'admin' || user.role === 'manager') && serveAdmin;

  // The Settings modal is global (store-driven) so every accounts surface — the workspace and
  // each overlay page's identity pastille — opens the same one. Rendered here so it sits above
  // the overlays and is present even when there's no Workspace (admin-only server below).
  const settingsModal = settingsOpen ? <Settings onClose={() => setSettingsOpen(false)} /> : null;

  // Admin-only server (client workspace off): no Workspace at all — an admin/manager gets the
  // console as the whole surface; anyone else is told they have no access here.
  if (!serveWebui) {
    return (
      <>
        {canManage ? (
          <Suspense fallback={null}>
            <AdminDashboard hideBack />
          </Suspense>
        ) : (
          <AdminOnlyNotice onSignOut={() => logout()} />
        )}
        {settingsModal}
      </>
    );
  }

  // `/admin` and `/collections` are real routes rendered as overlays over the
  // (kept-mounted) workspace, so live terminals survive a trip to admin. Someone without org
  // access (or an admin on a server with the console gated off) is bounced back to the app.
  if (path === '/admin' && !canManage) navigate('/');

  return (
    <>
      <Workspace
        auth={{
          // Accounts sessions have no separate lock: the vault key lives only in
          // RAM, so "sign out" clears it (back to the login screen). The pastille
          // names the action itself, so no label travels through here any more.
          isLocked: false,
          lock: () => logout(),
          renderUnlockModal: () => null,
        }}
        conns={conns}
        instanceName={mode?.instanceName}
        identity={{ username: user.username, role: user.role }}
        navActions={nav}
        headerExtra={<AccessRequestsBell />}
      />
      {path === '/teams' && <TeamsDashboard />}
      {path === '/collections' && <CollectionsDashboard />}
      {path === '/notifications' && <NotificationsDashboard />}
      {path === '/admin' && canManage && (
        <Suspense fallback={null}>
          <AdminDashboard />
        </Suspense>
      )}
      {settingsModal}
    </>
  );
}
