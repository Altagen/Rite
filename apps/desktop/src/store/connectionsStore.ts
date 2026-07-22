/**
 * Connections Store
 *
 * Manages SSH/SFTP connections:
 * - Loading connections from backend
 * - Creating, updating, deleting connections
 * - Storing connections in local state
 */

import { create } from 'zustand';
import { Backend } from '../utils/backend';
import { errorHandler, ErrorSeverity, ErrorCategory } from '../utils/errorHandler';

export type Protocol = 'SSH' | 'SFTP' | 'Local';
export type AuthType = 'password' | 'publicKey';

export interface ConnectionInfo {
  id: string;
  name: string;
  protocol: string;
  hostname: string;
  port: number;
  username: string;
  authType: string;
  color?: string | null;
  icon?: string | null;
  folder?: string | null;
  notes?: string | null;
  sshKeepAliveOverride?: string | null;
  sshKeepAliveInterval?: number | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number | null;
  // Collection provenance (ADR 0016): set when this machine lives in a shared
  // collection, so the sidebar can render it under a first-class collection node
  // (its own icon, colour and role) rather than a plain personal folder. Absent
  // for personal-vault and team connections.
  collectionId?: string | null;
  collectionName?: string | null;
  collectionColor?: string | null;
  collectionRole?: string | null; // 'owner' | 'editor' | 'viewer'
}

export interface CreateConnectionInput {
  name: string;
  protocol: Protocol;
  hostname: string;
  port: number;
  username: string;
  authMethod: {
    type: 'password';
    password: string;
  } | {
    type: 'publicKey';
    keyPath: string;
    passphrase?: string;
  };
  color?: string;
  icon?: string;
  folder?: string;
  notes?: string;
  sshKeepAliveOverride?: string | null;
  sshKeepAliveInterval?: number | null;
  // ADR 0016: save this machine into a shared collection (encrypted with the
  // collection key) instead of the personal vault. Absent ⇒ personal vault.
  collectionId?: string | null;
}

export interface UpdateConnectionInput {
  id: string;
  name?: string;
  protocol?: Protocol;
  hostname?: string;
  port?: number;
  username?: string;
  authMethod?: {
    type: 'password';
    password: string;
  } | {
    type: 'publicKey';
    keyPath: string;
    passphrase?: string;
  };
  color?: string;
  icon?: string;
  folder?: string;
  notes?: string;
  sshKeepAliveOverride?: string | null;
  sshKeepAliveInterval?: number | null;
}

/**
 * The connection source the Workspace reads from (ADR 0014). Local/native shells
 * back it with this store (`/api/connections`); the accounts/web shell backs it
 * with browser-decrypted per-user + team connections. `connect` opens a terminal
 * session for a saved connection and returns its id.
 */
export interface ConnectionsSource {
  connections: ConnectionInfo[];
  selectedConnectionId: string | null;
  refresh: () => Promise<void>;
  select: (id: string | null) => void;
  remove: (id: string) => Promise<void>;
  connect: (conn: ConnectionInfo) => Promise<string>;
  create: (input: CreateConnectionInput) => Promise<void>;
  update: (input: UpdateConnectionInput) => Promise<void>;
  // ADR 0016: collections the caller may write into (owner/editor), for the
  // machine form's "save to collection" target. Undefined in the local vault
  // context (no collections there); populated by the accounts source.
  writableCollections?: { id: string; name: string }[];
  // Every readable collection (incl. empty ones + the synthetic "Personal"), so the
  // sidebar can show a collection node before it has any machine. Accounts only.
  collections?: { id: string; name: string; color: string | null; role: string }[];
}

interface ConnectionsState {
  // State
  connections: ConnectionInfo[];
  isLoading: boolean;
  error: string | null;
  selectedConnectionId: string | null;

  // Actions
  fetchConnections: () => Promise<void>;
  createConnection: (input: CreateConnectionInput) => Promise<ConnectionInfo>;
  updateConnection: (input: UpdateConnectionInput) => Promise<ConnectionInfo>;
  deleteConnection: (id: string) => Promise<void>;
  selectConnection: (id: string | null) => void;
  clearError: () => void;
}

export const useConnectionsStore = create<ConnectionsState>((set) => ({
  // Initial state
  connections: [],
  isLoading: false,
  error: null,
  selectedConnectionId: null,

  // Fetch all connections
  fetchConnections: async () => {
    try {
      set({ isLoading: true, error: null });
      const connections = await Backend.Connections.getAllConnections();
      set({ connections, isLoading: false });
    } catch (error) {
      errorHandler.handle('Failed to fetch connections', {
        severity: ErrorSeverity.ERROR,
        category: ErrorCategory.DATABASE,
        originalError: error,
        context: { store: 'connectionsStore', action: 'fetchConnections' },
      });
      set({
        error: `Failed to load connections: ${error}`,
        isLoading: false
      });
    }
  },

  // Create a new connection
  createConnection: async (input: CreateConnectionInput) => {
    try {
      set({ isLoading: true, error: null });
      const connection = await Backend.Connections.createConnection(input);

      // Add to local state
      set(state => ({
        connections: [...state.connections, connection],
        isLoading: false
      }));

      return connection;
    } catch (error) {
      errorHandler.handle('Failed to create connection', {
        severity: ErrorSeverity.ERROR,
        category: ErrorCategory.DATABASE,
        originalError: error,
        context: { store: 'connectionsStore', action: 'createConnection', connectionName: input.name },
      });
      set({
        error: `Failed to create connection: ${error}`,
        isLoading: false
      });
      throw error;
    }
  },

  // Update an existing connection
  updateConnection: async (input: UpdateConnectionInput) => {
    try {
      set({ isLoading: true, error: null });
      const updatedConnection = await Backend.Connections.updateConnection(input);

      // Update in local state
      set(state => ({
        connections: state.connections.map(conn =>
          conn.id === updatedConnection.id ? updatedConnection : conn
        ),
        isLoading: false
      }));

      return updatedConnection;
    } catch (error) {
      errorHandler.handle('Failed to update connection', {
        severity: ErrorSeverity.ERROR,
        category: ErrorCategory.DATABASE,
        originalError: error,
        context: { store: 'connectionsStore', action: 'updateConnection', connectionId: input.id },
      });
      set({
        error: `Failed to update connection: ${error}`,
        isLoading: false
      });
      throw error;
    }
  },

  // Delete a connection
  deleteConnection: async (id: string) => {
    try {
      set({ isLoading: true, error: null });
      await Backend.Connections.deleteConnection(id);

      // Remove from local state
      set(state => ({
        connections: state.connections.filter(conn => conn.id !== id),
        selectedConnectionId: state.selectedConnectionId === id ? null : state.selectedConnectionId,
        isLoading: false
      }));
    } catch (error) {
      errorHandler.handle('Failed to delete connection', {
        severity: ErrorSeverity.ERROR,
        category: ErrorCategory.DATABASE,
        originalError: error,
        context: { store: 'connectionsStore', action: 'deleteConnection', connectionId: id },
      });
      set({
        error: `Failed to delete connection: ${error}`,
        isLoading: false
      });
      throw error;
    }
  },

  // Select a connection
  selectConnection: (id: string | null) => {
    set({ selectedConnectionId: id });
  },

  // Clear error message
  clearError: () => {
    set({ error: null });
  },
}));
