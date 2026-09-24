/**
 * Local-vault shell (ADR 0014): the master-password auth gate + the local
 * connection source around the shared `Workspace`. Lock/unlock and connections
 * are local-vault concepts here; the workspace itself is context-agnostic.
 * Accounts contexts provide their own gate + source.
 */

import { useAuthStore } from '../store/authStore';
import { useConnectionsStore, type ConnectionsSource } from '../store/connectionsStore';
import { Backend } from '../utils/backend';
import { UnlockScreen } from './UnlockScreen';
import { SetupScreen } from './SetupScreen';
import { Workspace } from './Workspace';

/** The local vault's connection source: the store + server-side connect. */
function useLocalConnectionsSource(): ConnectionsSource {
  const {
    connections,
    selectedConnectionId,
    fetchConnections,
    deleteConnection,
    selectConnection,
    createConnection,
    updateConnection,
  } = useConnectionsStore();
  return {
    connections,
    selectedConnectionId,
    refresh: fetchConnections,
    select: selectConnection,
    remove: deleteConnection,
    connect: async (c) => {
      const id = await Backend.Terminal.connectTerminal(c.id);
      // The local vault records "last used" (ADR 0017) — refresh so the pastille reflects it.
      void fetchConnections();
      return id;
    },
    create: async (input) => {
      await createConnection(input);
    },
    update: async (input) => {
      await updateConnection(input);
    },
    // Vault path: the core decrypts the saved connection by id and execs over SSH.
    execRemote: (c, command) => Backend.Terminal.machineExec(c.id, command),
    // Vault path again: the id is enough, the core resolves creds and jump chain.
    startForward: (c, f) =>
      Backend.Terminal.startForward({
        connectionId: c.id,
        bindHost: f.bindHost ?? undefined,
        localPort: f.localPort,
        remoteHost: f.remoteHost,
        remotePort: f.remotePort,
      }),
  };
}

export function MainScreen() {
  const { isLocked, isFirstRun, lock } = useAuthStore();
  const conns = useLocalConnectionsSource();
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
