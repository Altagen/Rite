/**
 * Local-vault shell (ADR 0014): the master-password auth gate around the shared
 * `Workspace`. Lock/unlock is a local-vault concept (the `authStore`); the
 * workspace itself is context-agnostic. Accounts contexts provide their own gate.
 */

import { useAuthStore } from '../store/authStore';
import { UnlockScreen } from './UnlockScreen';
import { Workspace } from './Workspace';

export function MainScreen() {
  const { isLocked, lock } = useAuthStore();
  return (
    <Workspace
      auth={{
        isLocked,
        lock,
        renderUnlockModal: ({ onClose }) => <UnlockScreen asModal onClose={onClose} />,
      }}
    />
  );
}
