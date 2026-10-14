/**
 * The accounts nav: Teams / Collections / Organization, written once.
 *
 * These are pages you travel between, and every surface carries the list — the
 * workspace's own bar and each overlay page's bar (`OverlayHeaderControls`). An
 * overlay used to hold Close and the identity pastille and nothing else, so going from
 * Collections to Teams meant Close, then finding the button you had just left. The bar
 * is the emptiest one in the app, so the nav costs nothing to carry, and Close stays
 * exactly where it was for the trip back to the terminals.
 *
 * `design/mock/full-data.js` (`overlayNavHTML`) is the same list in the prototype.
 *
 * Two surfaces are deliberately not here:
 *
 * - the **admin console**, whose own left rail already says Teams and Collections —
 *   the organisation's, not yours. The same two words twice on one screen, meaning two
 *   different things, is worse than a Close.
 * - an **admin-only deployment** (`serveWebui: false`), where the console is the whole
 *   surface: there is no workspace and no /teams page to reach, so the nav would offer
 *   routes that render nothing.
 */

import { useRoutePath, navigate } from '../store/route';
import { useServerSession } from '../store/serverSessionStore';
import { IconCollection, IconShield, IconUsers } from './icons';
import { isNativeShell } from '../utils/nativeShell';
import type { NavAction } from './OverflowNav';

export function useAccountsNav(): NavAction[] {
  const { user, mode } = useServerSession();
  const path = useRoutePath();
  if (!user || mode?.serveWebui === false) return [];

  // Org management is open to admins AND managers; the console filters its own
  // sections by role. A deployment may also serve the client without the console.
  const canManage = (user.role === 'admin' || user.role === 'manager') && mode?.serveAdmin !== false;
  // The desktop shell and managers say "Organization": server settings are web-only.
  const orgLabel = isNativeShell() || user.role === 'manager' ? 'Organization' : 'Admin';

  const nav: NavAction[] = [
    {
      id: 'teams',
      label: 'Teams',
      icon: <IconUsers className="h-4 w-4" />,
      onClick: () => navigate('/teams'),
      active: path === '/teams',
    },
    {
      id: 'collections',
      label: 'Collections',
      title: 'Collections — yours + Discover (offered to your teams)',
      icon: <IconCollection className="h-4 w-4" />,
      onClick: () => navigate('/collections'),
      active: path === '/collections',
    },
  ];
  if (canManage)
    nav.push({
      id: 'admin',
      label: orgLabel,
      title:
        isNativeShell() || user.role === 'manager'
          ? 'Organization (server settings are in the web console)'
          : 'Administration',
      icon: <IconShield className="h-4 w-4" />,
      onClick: () => navigate('/admin'),
      active: path === '/admin',
    });
  return nav;
}
