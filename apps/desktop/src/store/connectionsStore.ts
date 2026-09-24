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
export type AuthType = 'password' | 'publicKey' | 'agent';

/**
 * Auth method as sent to the backend (mirrors the Rust `AuthMethod` enum).
 * `agent` authenticates via the local SSH agent (SSH_AUTH_SOCK) — the private
 * key never leaves the agent; `identity` optionally pins one key by SHA256
 * fingerprint (else all are offered), `forward` requests agent forwarding.
 */
export type AuthMethodInput =
  | { type: 'password'; password: string }
  | { type: 'publicKey'; keyPath: string; passphrase?: string }
  | { type: 'agent'; identity?: string; forward?: boolean };

/** A saved port-forward config on a connection (started/stopped at runtime). */
export interface PortForwardConfig {
  forwardType?: string; // "local" (MVP); "remote"/"dynamic" reserved
  bindHost?: string | null; // local bind host; null ⇒ 127.0.0.1
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

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
  // Pre-connect hook: a local command run (in a PTY) before the SSH session opens,
  // e.g. `wg-quick up wg0` or `aws sso login`. Empty/absent ⇒ none.
  preconnect?: string | null;
  // Jump host (ProxyJump): the id of another connection to reach this one through
  // (a bastion). Chainable — the jump may itself have a jump. Empty/absent ⇒ direct.
  jump?: string | null;
  // Saved port forwards (started/stopped at runtime from the forwarding panel).
  forwards?: PortForwardConfig[];
  // Health-check opt-out (ADR 0017): false ⇒ this machine is never actively probed,
  // even where the server policy allows it. Absent/true ⇒ follow the policy. A machine
  // can opt out of probing but can't opt into more than the server permits.
  hc?: boolean | null;
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
  authMethod: AuthMethodInput;
  color?: string;
  icon?: string;
  folder?: string;
  notes?: string;
  sshKeepAliveOverride?: string | null;
  sshKeepAliveInterval?: number | null;
  preconnect?: string | null; // pre-connect hook (see ConnectionInfo.preconnect)
  jump?: string | null; // jump-host connection id (see ConnectionInfo.jump)
  forwards?: PortForwardConfig[]; // saved port forwards (see ConnectionInfo.forwards)
  hc?: boolean | null; // health-check opt-out (false ⇒ never probe; see ConnectionInfo.hc)
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
  authMethod?: AuthMethodInput;
  color?: string;
  icon?: string;
  folder?: string;
  notes?: string;
  sshKeepAliveOverride?: string | null;
  sshKeepAliveInterval?: number | null;
  preconnect?: string | null; // pre-connect hook (see ConnectionInfo.preconnect)
  jump?: string | null; // jump-host connection id (see ConnectionInfo.jump)
  forwards?: PortForwardConfig[]; // saved port forwards (Some ⇒ replace the whole list)
  hc?: boolean | null; // health-check opt-out (false ⇒ never probe; see ConnectionInfo.hc)
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
  // sidebar can show a collection node before it has any machine, plus its declared
  // sub-folders (so empty folders show). Accounts only.
  collections?: {
    id: string;
    name: string;
    color: string | null;
    role: string;
    folders: { name: string; color: string | null }[];
    memberCount: number;
    isPersonal: boolean;
    // Collection-wide active-probe opt-out (ADR 0017): false ⇒ never probe its machines.
    hc?: boolean | null;
    // Whether this collection has a Board (an itemsKey-encrypted blob of cards). The
    // blob itself is read via readBoard; this flag lets the UI show an indicator.
    hasBoard?: boolean;
  }[];
  // The collection Board (ADR 0016) — members-only cards, itemsKey-encrypted. Present
  // only in the accounts source (collections live there). readBoard decrypts the
  // stored blob; saveBoard re-encrypts and persists (editor+). Undefined in the local
  // vault context, where there are no shared collections.
  readBoard?: (collectionId: string) => Promise<import('../utils/board').BoardCard[]>;
  saveBoard?: (collectionId: string, cards: import('../utils/board').BoardCard[]) => Promise<void>;
  // Run a one-shot command on a machine and capture its output — agentless dashboard
  // detection (docker ps / systemctl). Routes to the right execute path per source
  // (vault by id, accounts by decrypted target).
  execRemote?: (
    connection: ConnectionInfo,
    command: string,
  ) => Promise<import('../utils/backend').RemoteCommandOutput>;
  // Start a local port forward on a machine. Routes per source like execRemote: the
  // vault path names the connection by id (the core decrypts it), the accounts path
  // sends the decrypted target and its jump chain, since the server can't read them.
  startForward?: (
    connection: ConnectionInfo,
    forward: PortForwardConfig,
  ) => Promise<import('../utils/backend').PortForwardInfo>;
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
