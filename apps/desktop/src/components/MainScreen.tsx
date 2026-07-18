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
    connect: (c) => Backend.Terminal.connectTerminal(c.id),
    create: async (input) => {
      await createConnection(input);
    },
    update: async (input) => {
      await updateConnection(input);
    },
  };
}

export function MainScreen() {
  const { isLocked, lock } = useAuthStore();
  const conns = useLocalConnectionsSource();
  return (
    <Workspace
      auth={{
        isLocked,
        lock,
        renderUnlockModal: ({ onClose }) => <UnlockScreen asModal onClose={onClose} />,
      }}
      conns={conns}
    />
  );
}
