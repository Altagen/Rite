/**
 * Local-vault shell (ADR 0014): the master-password auth gate + the local
 * connection source around the shared `Workspace`. Lock/unlock and connections
 * are local-vault concepts here; the workspace itself is context-agnostic.
 * Accounts contexts provide their own gate + source.
 */

import { useAuthStore } from '../store/authStore';
import { useLocalCollectionsSource } from '../store/localCollectionsSource';
import { UnlockScreen } from './UnlockScreen';
import { SetupScreen } from './SetupScreen';
import { Workspace } from './Workspace';

export function MainScreen() {
  const { isLocked, isFirstRun, lock } = useAuthStore();
  const conns = useLocalCollectionsSource();
  return (
    <Workspace
      auth={{
        isLocked,
        isFirstRun: isFirstRun ?? false,
        lock,
        // Opening the local vault: create the master password on first run,
        // otherwise unlock. Both render inside the workspace (base-first, ADR 0014).
        renderUnlockModal: ({ onClose }) =>
          isFirstRun ? (
            <SetupScreen asModal onClose={onClose} />
          ) : (
            <UnlockScreen asModal onClose={onClose} />
          ),
      }}
      conns={conns}
    />
  );
}
