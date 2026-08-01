/**
 * Backend Commands Wrapper with Zod Validation
 *
 * This module provides type-safe wrappers for all Backend commands with runtime validation.
 * All responses from the Rust backend are validated using Zod schemas to ensure type safety.
 */

import { z } from 'zod';
import { errorHandler, ErrorSeverity, ErrorCategory } from './errorHandler';
import { transport } from './transport';

/**
 * Generic wrapper for Backend invoke with Zod validation
 */
async function invokeWithValidation<T>(
  command: string,
  schema: z.ZodType<T>,
  args?: Record<string, unknown>
): Promise<T> {
  try {
    // Route through the active transport (Backend IPC, HTTP to rite-server, or the
    // dev mock). Callers and Zod schemas are identical across all three.
    const response = await transport().invoke(command, args);

    // Validate response with Zod
    const result = schema.safeParse(response);

    if (!result.success) {
      // Log validation error with details
      errorHandler.handle(`Backend command '${command}' returned invalid data`, {
        severity: ErrorSeverity.ERROR,
        category: ErrorCategory.VALIDATION,
        context: {
          command,
          args,
          validationErrors: result.error.issues,
          receivedData: response,
        },
      });

      throw new Error(`Invalid response from ${command}: ${result.error.message}`);
    }

    return result.data;
  } catch (error) {
    // Re-throw with context if it's not already a validation error
    if (error instanceof Error && !error.message.includes('Invalid response from')) {
      errorHandler.handle(`Backend command '${command}' failed`, {
        severity: ErrorSeverity.ERROR,
        category: ErrorCategory.UNKNOWN,
        originalError: error,
        context: { command, args },
      });
    }
    throw error;
  }
}

// ============================================================================
// Zod Schemas for Backend Command Responses
// ============================================================================

// Auth schemas
const BooleanSchema = z.boolean();
const StringSchema = z.string();
const NullableStringSchema = z.string().nullable();

const UnlockResponseSchema = z.object({
  type: z.enum(['success', 'invalidPassword', 'rateLimited']),
  waitSeconds: z.number().optional(),
});

// Settings schemas
const SettingsRecordSchema = z.record(z.string(), z.string());

// Connection schemas
const ConnectionInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: z.string(),
  hostname: z.string(),
  port: z.number(),
  username: z.string(),
  authType: z.string(),
  folder: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  sshKeepAliveOverride: z.string().nullable().optional(),
  sshKeepAliveInterval: z.number().nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().nullable().optional(),
});

const ConnectionInfoArraySchema = z.array(ConnectionInfoSchema);

// SSH Config schemas
const SshConfigEntrySchema = z.object({
  host: z.string(),
  hostname: z.string().nullable(),
  user: z.string().nullable(),
  port: z.number().nullable(),
  identityFile: z.string().nullable(),
  serverAliveInterval: z.number().nullable(),
});

const SshConfigEntryArraySchema = z.array(SshConfigEntrySchema);

// Terminal schemas
const StringArraySchema = z.array(z.string());

// Password validation schema
const PasswordStrengthSchema = z.object({
  is_valid: z.boolean(),
  score: z.number(),
  feedback: z.array(z.string()),
});

// ============================================================================
// Type-Safe Backend Command Wrappers
// ============================================================================

// Auth Commands
export const BackendAuth = {
  /**
   * Check if this is the first run of the application
   */
  isFirstRun: () => invokeWithValidation('is_first_run', BooleanSchema),

  /**
   * Check if the application is currently locked
   */
  isLocked: () => invokeWithValidation('is_locked', BooleanSchema),

  /**
   * Setup the master password (first run)
   */
  setupMasterPassword: (password: string) =>
    invokeWithValidation('setup_master_password', z.null(), { password }),

  /**
   * Unlock the application with the master password
   */
  unlock: (password: string) =>
    invokeWithValidation('unlock', UnlockResponseSchema, { password }),

  /**
   * Lock the application
   */
  lock: () => invokeWithValidation('lock', z.null()),

  /**
   * Validate password strength
   */
  validatePassword: (password: string) =>
    invokeWithValidation('validate_password', PasswordStrengthSchema, { password }),

  /**
   * Reset the database (DANGEROUS - only for UnlockScreen emergency reset)
   */
  resetDatabase: () => invokeWithValidation('reset_database', z.null()),
} as const;

// Settings Commands
export const BackendSettings = {
  /**
   * Get all settings as a key-value record
   */
  getAllSettings: () => invokeWithValidation('get_all_settings', SettingsRecordSchema),

  /**
   * Get a specific setting by key
   */
  getSetting: (key: string) => invokeWithValidation('get_setting', NullableStringSchema, { key }),

  /**
   * Set a specific setting
   */
  setSetting: (key: string, value: string) =>
    invokeWithValidation('set_setting', z.null(), { key, value }),
} as const;

// Connection Commands
export const BackendConnections = {
  /**
   * Get all connections
   */
  getAllConnections: () => invokeWithValidation('get_all_connections', ConnectionInfoArraySchema),

  /**
   * Create a new connection
   */
  createConnection: (input: unknown) =>
    invokeWithValidation('create_connection', ConnectionInfoSchema, { input }),

  /**
   * Update an existing connection
   */
  updateConnection: (input: unknown) =>
    invokeWithValidation('update_connection', ConnectionInfoSchema, { input }),

  /**
   * Delete a connection by ID
   */
  deleteConnection: (id: string) => invokeWithValidation('delete_connection', z.null(), { id }),

  /**
   * Get default SSH config path (~/.ssh/config)
   */
  getDefaultSshConfigPath: () =>
    invokeWithValidation('get_default_ssh_config_path', StringSchema),

  /**
   * Parse SSH config file and return entries for preview
   */
  parseSshConfig: (configPath: string) =>
    invokeWithValidation('parse_ssh_config', SshConfigEntryArraySchema, { configPath }),

  /**
   * Import selected SSH config entries as connections
   */
  importSshConfigEntries: (entries: unknown[]) =>
    invokeWithValidation('import_ssh_config_entries', ConnectionInfoArraySchema, { entries }),
} as const;

// SSH host-key confirmation
export const BackendSsh = {
  /** Trust a pending unknown host key so the next connection succeeds. */
  acceptHostKey: (host: string, port: number) =>
    invokeWithValidation('accept_host_key', z.null(), { host, port }),

  /** Drop a pending unknown host key (user declined). */
  rejectHostKey: (host: string, port: number) =>
    invokeWithValidation('reject_host_key', z.null(), { host, port }),
} as const;

// Terminal Commands
export const BackendTerminal = {
  /**
   * Get list of installed shells
   */
  getInstalledShells: (shells: string[]) =>
    invokeWithValidation('get_installed_shells', StringArraySchema, { shells }),

  /**
   * Connect to a terminal (SSH connection)
   */
  connectTerminal: (connectionId: string) =>
    invokeWithValidation('connect_terminal', StringSchema, { connectionId }),

  /**
   * Connect to a local terminal with custom shell
   */
  connectLocalTerminal: (shell?: string) =>
    invokeWithValidation('connect_local_terminal', StringSchema, { shell }),

  /**
   * Quick SSH connect (temporary connection)
   */
  quickSshConnect: (
    host: string,
    username: string,
    port: number,
    authMethod: {
      type: 'password';
      password: string;
    } | {
      type: 'publicKey';
      keyPath: string;
      passphrase?: string;
    }
  ) =>
    invokeWithValidation('quick_ssh_connect', StringSchema, {
      host,
      username,
      port,
      authMethod,
    }),

  /**
   * Send input to a terminal session
   */
  sendTerminalInput: (sessionId: string, data: number[]) =>
    invokeWithValidation('send_terminal_input', z.null(), { sessionId, data }),

  /**
   * Resize a terminal session
   */
  resizeTerminal: (sessionId: string, cols: number, rows: number) =>
    invokeWithValidation('resize_terminal', z.null(), { sessionId, cols, rows }),

  /**
   * Claim the initial output buffer for a terminal session.
   * Returns base64-encoded bytes that arrived before the frontend registered
   * its listener, and switches the session to streaming mode.
   */
  claimSessionOutput: (sessionId: string) =>
    invokeWithValidation('claim_session_output', z.string(), { sessionId }),

  /**
   * Disconnect a terminal session
   */
  disconnectTerminal: (sessionId: string) =>
    invokeWithValidation('disconnect_terminal', z.null(), { sessionId }),
} as const;

// ============================================================================
// Unified Backend API
// ============================================================================

/**
 * Type-safe Backend API with runtime validation
 *
 * Usage:
 * ```ts
 * import { Backend } from '@/utils/backend';
 *
 * // Auth
 * const isFirstRun = await Backend.Auth.isFirstRun();
 *
 * // Settings
 * const settings = await Backend.Settings.getAllSettings();
 *
 * // Connections
 * const connections = await Backend.Connections.getAllConnections();
 *
 * // Terminal
 * const sessionId = await Backend.Terminal.connectTerminal(connectionId);
 * ```
 */
// Server accounts (ADR 0010) — shared-server login/bootstrap/session.
const KdfParamsSchema = z.object({ mem: z.number(), iter: z.number(), par: z.number() });
const ServerModeSchema = z.object({
  accounts: z.boolean(),
  needsBootstrap: z.boolean(),
  instanceName: z.string().nullable().optional(),
  // Whether the client may persist the vault key in sessionStorage (default true
  // when absent). Admin-controlled; still zero-knowledge (key stays in the browser).
  sessionPersistence: z.boolean().optional(),
  // Which surfaces this deployment serves (default true when absent). serveAdmin
  // gates the admin console; serveWebui gates the client workspace.
  serveAdmin: z.boolean().optional(),
  serveWebui: z.boolean().optional(),
  // Server-governed client capabilities (mock "Client capabilities"): the shell used for
  // terminals on this server, and whether ad-hoc Quick SSH is allowed (off by default).
  defaultShell: z.string().optional(),
  allowQuickSsh: z.boolean().optional(),
  // Machine health-check policy (ADR 0017): passive "last seen" + governed active probing.
  healthcheck: z
    .object({
      passiveStatus: z.boolean(),
      active: z.enum(['off', 'on-demand', 'full', 'client-choice']),
      methods: z.array(z.string()),
      restrictUsers: z.array(z.string()),
      minInterval: z.number(),
    })
    .optional(),
  // Collection governance policy (admin → Collections). Absent ⇒ permissive defaults.
  collectionPolicy: z
    .object({
      allowCreate: z.boolean(),
      allowSharingOutsideTeams: z.boolean(),
      maxMembers: z.number(),
      defaultRole: z.enum(['viewer', 'editor']),
    })
    .optional(),
});
export type HealthcheckPolicy = NonNullable<z.infer<typeof ServerModeSchema>['healthcheck']>;
export type CollectionPolicy = NonNullable<z.infer<typeof ServerModeSchema>['collectionPolicy']>;
// Active health-check probe (ADR 0017). The client sends host:port (decrypted from its own
// blob) per target; the server returns a reachability verdict. `unsupported` ≠ `down` — it
// means the method can't run (e.g. icmp without privileges), so the UI won't paint it offline.
export type ProbeMethod = 'tcp-connect' | 'icmp' | 'ssh-handshake';
export type ProbeTarget = { id: string; host: string; port: number; method?: ProbeMethod };
const HealthProbeSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['up', 'down', 'unsupported']),
      latencyMs: z.number().nullable(),
    }),
  ),
});
export type HealthProbeResult = z.infer<typeof HealthProbeSchema>['results'][number];
const PreloginSchema = z.object({ salt: z.string(), params: KdfParamsSchema });
const ServerUserSchema = z.object({
  // True while the account still uses an admin-set password (first login / after reset):
  // the client must force a password change before proceeding.
  mustChangePassword: z.boolean().optional(),
  id: z.string(),
  username: z.string(),
  role: z.enum(['admin', 'user']),
  status: z.string(),
  createdAt: z.number(),
});
// Per-user vault key material (ADR 0011): the KDF salt + wrapped user key. Null
// for a user provisioned without a vault. Ciphertext only — safe to hand back.
const VaultSchema = z
  .object({
    kdfMasterSalt: z.string(),
    protectedUserKey: z.string(),
    publicKey: z.string(),
    protectedPrivateKey: z.string(),
  })
  .nullable();
const LoginResultSchema = z.object({
  token: z.string(),
  user: ServerUserSchema,
  vault: VaultSchema,
});
const MeSchema = z.object({ user: ServerUserSchema, vault: VaultSchema });

export type ServerMode = z.infer<typeof ServerModeSchema>;
export type ServerUser = z.infer<typeof ServerUserSchema>;
export type VaultKeyBlob = z.infer<typeof VaultSchema>;

export const BackendServer = {
  /** Whether this endpoint is a shared server and if it still needs its admin. */
  mode: () => invokeWithValidation('server_mode', ServerModeSchema),
  /** KDF salt + params for a username (to derive the auth hash client-side). */
  prelogin: (username: string) =>
    invokeWithValidation('server_prelogin', PreloginSchema, { username }),
  login: (username: string, authHash: string) =>
    invokeWithValidation('server_login', LoginResultSchema, { username, authHash }),
  bootstrap: (
    username: string,
    salt: string,
    params: unknown,
    authHash: string,
    vault: {
      masterSalt: string;
      protectedUserKey: string;
      publicKey: string;
      protectedPrivateKey: string;
    },
  ) =>
    invokeWithValidation('server_bootstrap', LoginResultSchema, {
      username,
      salt,
      params,
      authHash,
      ...vault,
    }),
  logout: () => invokeWithValidation('server_logout', z.null()),
  me: () => invokeWithValidation('server_me', MeSchema),
  /** Replace my own password + vault (first login / after reset). New keypair; server never
   *  sees the password. Authenticated. */
  changePassword: (
    salt: string,
    params: unknown,
    authHash: string,
    vault: {
      masterSalt: string;
      protectedUserKey: string;
      publicKey: string;
      protectedPrivateKey: string;
    },
  ) =>
    invokeWithValidation('server_change_password', z.null(), {
      salt,
      params,
      authHash,
      ...vault,
    }),
  /** On-demand active health-check (ADR 0017). Governed by the server policy — may be refused
   *  (probing off / not permitted) or rate-limited; callers should degrade gracefully. */
  probeHealth: (targets: ProbeTarget[]) =>
    invokeWithValidation('server_probe_health', HealthProbeSchema, {
      targets: targets as unknown as Record<string, unknown>[],
    }),
} as const;

// Admin (server mode, role=admin) — account management.
const CollectionSummarySchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  memberCount: z.number(),
  itemCount: z.number(),
  // Opaque name/colour blob; an admin holding the group escrow can decrypt it.
  nameEnc: z.string(),
  // Admin-group escrow (ADR 0016): metaKey sealed to the group pubkey → admins can
  // decrypt the name. Null for un-escrowed collections (pre-split / no group yet).
  metaKeyGroupEnc: z.string().nullable().optional(),
  groupEpoch: z.number().nullable().optional(),
});
export type CollectionSummary = z.infer<typeof CollectionSummarySchema>;

// Admin-group escrow schemas (ADR 0016 split-key model).
const AdminGroupKeySchema = z.object({ epoch: z.number(), publicKey: z.string() });
const AdminGroupGrantSchema = z.object({ epoch: z.number(), protectedPrivateKey: z.string() });
const AdminKeySchema = z.object({ userId: z.string(), username: z.string(), publicKey: z.string() });
export type AdminGroupKey = z.infer<typeof AdminGroupKeySchema>;
export type AdminKey = z.infer<typeof AdminKeySchema>;

export const BackendAdmin = {
  listUsers: () => invokeWithValidation('admin_list_users', z.array(ServerUserSchema)),
  createUser: (
    username: string,
    salt: string,
    params: unknown,
    authHash: string,
    role: string,
    vault: {
      masterSalt: string;
      protectedUserKey: string;
      publicKey: string;
      protectedPrivateKey: string;
    },
  ) =>
    invokeWithValidation('admin_create_user', ServerUserSchema, {
      username,
      salt,
      params,
      authHash,
      role,
      ...vault,
    }),
  setStatus: (id: string, status: 'active' | 'disabled') =>
    invokeWithValidation('admin_set_status', z.null(), { id, status }),
  /** Reset a user's access (admin): re-provision a temp vault + wipe their sharing crypto.
   *  Keeps username/role/teams; the user sets their own password at next login. */
  resetUser: (
    id: string,
    salt: string,
    params: unknown,
    authHash: string,
    vault: {
      masterSalt: string;
      protectedUserKey: string;
      publicKey: string;
      protectedPrivateKey: string;
    },
  ) => invokeWithValidation('admin_reset_user', z.null(), { id, salt, params, authHash, ...vault }),
  deleteUser: (id: string) => invokeWithValidation('admin_delete_user', z.null(), { id }),
  /** Set the global instance name shown to every user (org-admin only). */
  setInstanceName: (name: string) => invokeWithValidation('admin_set_instance', z.null(), { name }),
  /** Toggle client vault-key session persistence for the whole server (org-admin). */
  setSessionPersistence: (enabled: boolean) =>
    invokeWithValidation('admin_set_session_persistence', z.null(), { enabled }),
  /** Set the server's default shell for terminals (org-admin). */
  setDefaultShell: (shell: string) =>
    invokeWithValidation('admin_set_default_shell', z.null(), { shell }),
  /** Allow/forbid ad-hoc Quick SSH from the toolbar (org-admin). */
  setQuickSsh: (enabled: boolean) =>
    invokeWithValidation('admin_set_quick_ssh', z.null(), { enabled }),
  /** Set the machine health-check policy (org-admin). Sends the whole policy object. */
  setHealthcheck: (policy: HealthcheckPolicy) =>
    invokeWithValidation('admin_set_healthcheck', z.null(), policy as unknown as Record<string, unknown>),
  /** Set the collection governance policy (org-admin). Sends the whole policy object. */
  setCollectionPolicy: (policy: CollectionPolicy) =>
    invokeWithValidation('admin_set_collection_policy', z.null(), policy as unknown as Record<string, unknown>),

  // Collections governance (admin). Names stay encrypted — counts/membership only.
  listCollections: () => invokeWithValidation('admin_list_collections', z.array(CollectionSummarySchema)),
  collectionMembers: (id: string) =>
    invokeWithValidation('admin_collection_members', z.array(CollectionMemberSchema), { id }),
  removeCollectionMember: (id: string, userId: string) =>
    invokeWithValidation('admin_remove_collection_member', z.null(), { id, userId }),
  deleteCollection: (id: string) => invokeWithValidation('admin_delete_collection', z.null(), { id }),

  // Admin-group escrow (ADR 0016 split-key). Lets admins read collection names +
  // roster-add without ever holding item keys. The server stores only sealed blobs.
  /** The current Admin-group public key + epoch (null if never bootstrapped). */
  groupKey: () => invokeWithValidation('admin_group_key', AdminGroupKeySchema.nullable()),
  /** This admin's sealed group private key for the current epoch (null if no grant yet). */
  groupGrant: () => invokeWithValidation('admin_group_grant', AdminGroupGrantSchema.nullable()),
  /** Admins with published public keys — recipients for group grants. */
  listAdmins: () => invokeWithValidation('admin_list_admins', z.array(AdminKeySchema)),
  /** Bootstrap or rotate the group: new epoch pubkey + the priv sealed to each admin. */
  setGroupKey: (
    epoch: number,
    publicKey: string,
    grants: { userId: string; protectedPrivateKey: string }[],
  ) => invokeWithValidation('admin_set_group_key', z.null(), { epoch, publicKey, grants }),
  /** Grant a newly-added admin the current group private key (O(1), no rotation). */
  grantAdmin: (userId: string, protectedPrivateKey: string) =>
    invokeWithValidation('admin_grant_admin', z.null(), { userId, protectedPrivateKey }),
  /** Re-seal a collection's metaKey escrow to a group epoch (rotation step). */
  setEscrow: (id: string, metaKeyGroupEnc: string, groupEpoch: number) =>
    invokeWithValidation('admin_set_escrow', z.null(), { id, metaKeyGroupEnc, groupEpoch }),
  /** Roster meta-add: grant name/roster access by sealing only the metaKey. */
  addCollectionMemberMeta: (id: string, userId: string, protectedMetaKey: string) =>
    invokeWithValidation('admin_add_collection_member', z.null(), { id, userId, protectedMetaKey }),
} as const;

// Context multiplexer (ADR 0012) — the native client's roster of contexts.
const RemoteServerSchema = z.object({
  id: z.string(),
  url: z.string(),
  label: z.string(),
  certFingerprint: z.string().optional(),
});
const ContextSchema = z.object({
  active: z.union([z.literal('local'), RemoteServerSchema]),
  roster: z.array(RemoteServerSchema),
});
// A self-signed remote returns `trusted: false` + the fingerprint to confirm;
// a real cert returns `trusted: true` (fingerprint null); loopback http too.
const ProbeSchema = z.object({ trusted: z.boolean(), fingerprint: z.string().nullable() });
const VaultStatusSchema = z.object({ unlocked: z.boolean() });
export type RemoteServer = z.infer<typeof RemoteServerSchema>;
export type ContextState = z.infer<typeof ContextSchema>;
export type ProbeResult = z.infer<typeof ProbeSchema>;

export const BackendContext = {
  get: () => invokeWithValidation('context_get', ContextSchema),
  addServer: (url: string, label?: string) =>
    invokeWithValidation('context_add_server', RemoteServerSchema, { url, label }),
  removeServer: (id: string) => invokeWithValidation('context_remove_server', z.null(), { id }),
  /** `'local'` or a roster server id. */
  setActive: (server: string) => invokeWithValidation('context_set_active', z.null(), { server }),
  /** Probe a remote's TLS cert (TOFU) before adding a self-signed server. */
  probe: (url: string) => invokeWithValidation('context_probe', ProbeSchema, { url }),
  /** Pin a confirmed self-signed cert fingerprint for a roster server. */
  pinServer: (id: string, fingerprint: string) =>
    invokeWithValidation('context_pin_server', z.null(), { id, fingerprint }),
  /** Hand the unwrapped vault key to the trusted local server (ADR 0011). */
  vaultUnlock: (userKeyHex: string, autoLockSecs?: number) =>
    invokeWithValidation('context_vault_unlock', z.null(), { userKey: userKeyHex, autoLockSecs }),
  /** Whether the local server still holds the vault key (survives reloads). */
  vaultStatus: () => invokeWithValidation('context_vault_status', VaultStatusSchema),
  /** Zeroize the held vault key (explicit lock). */
  vaultLock: () => invokeWithValidation('context_vault_lock', z.null()),
} as const;

// Teams / RBAC (product-model.md). Keyless rosters — sharing lives in collections (ADR 0016).
const TeamRoleSchema = z.enum(['admin', 'member']);
const TeamSchema = z.object({ id: z.string(), name: z.string(), createdAt: z.number() });
const TeamMemberSchema = z.object({
  userId: z.string(),
  username: z.string(),
  role: TeamRoleSchema,
  publicKey: z.string().nullable().optional(),
});
const UserTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: TeamRoleSchema,
});
export type Team = z.infer<typeof TeamSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type UserTeam = z.infer<typeof UserTeamSchema>;
export type TeamRole = z.infer<typeof TeamRoleSchema>;

export const BackendTeams = {
  /** All teams (org-admin). */
  listAll: () => invokeWithValidation('admin_list_teams', z.array(TeamSchema)),
  create: (name: string) => invokeWithValidation('admin_create_team', TeamSchema, { name }),
  remove: (id: string) => invokeWithValidation('admin_delete_team', z.null(), { id }),
  /** Teams the caller belongs to (keyless roster). */
  mine: () => invokeWithValidation('teams_mine', z.array(UserTeamSchema)),
  members: (id: string) => invokeWithValidation('team_members', z.array(TeamMemberSchema), { id }),
  addMember: (id: string, userId: string, role: TeamRole) =>
    invokeWithValidation('team_add_member', z.null(), { id, userId, role }),
  removeMember: (id: string, userId: string) =>
    invokeWithValidation('team_remove_member', z.null(), { id, userId }),
} as const;

// Per-user zero-knowledge connection blobs (ADR 0011). The browser encrypts/
// decrypts with its userKey; the server stores opaque v1.* blobs.
const ConnBlobSchema = z.object({
  id: z.string(),
  blob: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export const BackendVault = {
  connections: () => invokeWithValidation('vault_conn_list', z.array(ConnBlobSchema)),
  createConnection: (blob: string) =>
    invokeWithValidation('vault_conn_create', ConnBlobSchema, { blob }),
  updateConnection: (id: string, blob: string) =>
    invokeWithValidation('vault_conn_update', z.null(), { id, blob }),
  deleteConnection: (id: string) => invokeWithValidation('vault_conn_delete', z.null(), { id }),
} as const;

// Collections — the unified sharing primitive (ADR 0016). A collection carries a
// symmetric key sealed to each member; the browser unwraps it and de/encrypts the
// name+items. Roles gate writes (editor) and management (owner); ≥1 owner enforced.
const CollectionRoleSchema = z.enum(['owner', 'editor', 'viewer']);
// The org people directory that feeds the member picker (member-visible; ADR 0016).
const DirectoryEntrySchema = z.object({
  id: z.string(),
  username: z.string(),
  publicKey: z.string().nullable().optional(),
});
// A collection I belong to, with my sealed copies of its keys (nameEnc is opaque).
// Split-key model (ADR 0016): protectedMetaKey unwraps the name/colour, protectedItemsKey
// the machines. protectedItemsKey is null for a roster-only member (admin meta-add) until
// a member seals machine access.
const UserCollectionSchema = z.object({
  id: z.string(),
  nameEnc: z.string(),
  role: CollectionRoleSchema,
  protectedMetaKey: z.string(),
  protectedItemsKey: z.string().nullable(),
  createdAt: z.number(),
  // Offer-to-team discovery (ADR 0016): the team it's offered to + a plaintext label, or null.
  teamId: z.string().nullable().optional(),
  discoveryLabel: z.string().nullable().optional(),
});
// A collection offered to a team I belong to (discovery). Only the plaintext label is exposed.
const OfferedCollectionSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  discoveryLabel: z.string(),
  memberRole: CollectionRoleSchema.nullable(),
});
const CollectionMemberSchema = z.object({
  userId: z.string(),
  username: z.string(),
  role: CollectionRoleSchema,
  publicKey: z.string().nullable().optional(),
  // False for a roster-only member (admin meta-add) awaiting machine access.
  hasItemsKey: z.boolean().optional(),
});
// A pending access request I can grant (I own/edit the collection). Inbox item.
const IncomingRequestSchema = z.object({
  collectionId: z.string(),
  userId: z.string(),
  username: z.string(),
  publicKey: z.string().nullable().optional(),
  teamName: z.string().nullable().optional(),
  createdAt: z.number(),
});
const CollectionItemSchema = z.object({
  id: z.string(),
  blob: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const CreatedIdSchema = z.object({ id: z.string() });
export type CollectionRole = z.infer<typeof CollectionRoleSchema>;
export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;
export type UserCollection = z.infer<typeof UserCollectionSchema>;
export type OfferedCollection = z.infer<typeof OfferedCollectionSchema>;
export type IncomingRequest = z.infer<typeof IncomingRequestSchema>;
export type CollectionMember = z.infer<typeof CollectionMemberSchema>;
export type CollectionItem = z.infer<typeof CollectionItemSchema>;

export const BackendCollections = {
  /** The org people directory (id + username + public key) for the member picker. */
  directory: () => invokeWithValidation('directory_list', z.array(DirectoryEntrySchema)),
  /** Collections I belong to, each with my sealed collection key. */
  mine: () => invokeWithValidation('collections_mine', z.array(UserCollectionSchema)),
  /** The Admin-group public key (member-readable) to escrow a new collection's metaKey to. */
  groupKey: () =>
    invokeWithValidation('collections_group_key', AdminGroupKeySchema.nullable()),
  create: (
    nameEnc: string,
    protectedMetaKey: string,
    protectedItemsKey: string,
    escrow?: { metaKeyGroupEnc: string; groupEpoch: number } | null,
  ) =>
    invokeWithValidation('collection_create', CreatedIdSchema, {
      nameEnc,
      protectedMetaKey,
      protectedItemsKey,
      metaKeyGroupEnc: escrow?.metaKeyGroupEnc ?? null,
      groupEpoch: escrow?.groupEpoch ?? null,
    }),
  update: (id: string, nameEnc: string) =>
    invokeWithValidation('collection_update', z.null(), { id, nameEnc }),
  remove: (id: string) => invokeWithValidation('collection_delete', z.null(), { id }),
  members: (id: string) =>
    invokeWithValidation('collection_members', z.array(CollectionMemberSchema), { id }),
  addMember: (
    id: string,
    userId: string,
    role: CollectionRole,
    protectedMetaKey: string,
    protectedItemsKey: string,
  ) =>
    invokeWithValidation('collection_add_member', z.null(), {
      id,
      userId,
      role,
      protectedMetaKey,
      protectedItemsKey,
    }),
  setRole: (id: string, userId: string, role: CollectionRole) =>
    invokeWithValidation('collection_set_role', z.null(), { id, userId, role }),
  removeMember: (id: string, userId: string) =>
    invokeWithValidation('collection_remove_member', z.null(), { id, userId }),
  /** A collection's item blobs (opaque; the caller decrypts with the collection key). */
  items: (id: string) => invokeWithValidation('collection_items', z.array(CollectionItemSchema), { id }),
  createItem: (id: string, blob: string) =>
    invokeWithValidation('collection_item_create', CollectionItemSchema, { id, blob }),
  updateItem: (id: string, itemId: string, blob: string) =>
    invokeWithValidation('collection_item_update', z.null(), { id, itemId, blob }),
  deleteItem: (id: string, itemId: string) =>
    invokeWithValidation('collection_item_delete', z.null(), { id, itemId }),
  /** Collections offered to teams I'm in (opt-in discovery). */
  offered: () => invokeWithValidation('collections_offered', z.array(OfferedCollectionSchema)),
  /** Offer a collection to a team for discovery (owner). */
  setOffer: (id: string, teamId: string, discoveryLabel: string) =>
    invokeWithValidation('collection_set_offer', z.null(), { id, teamId, discoveryLabel }),
  /** Stop offering a collection (owner). */
  clearOffer: (id: string) => invokeWithValidation('collection_clear_offer', z.null(), { id }),
  /** Request access to a collection offered to one of my teams. */
  requestAccess: (id: string) => invokeWithValidation('collection_request_access', z.null(), { id }),
  /** Access requests I can grant (I own/edit the collection) — the inbox. */
  incomingRequests: () =>
    invokeWithValidation('collections_requests', z.array(IncomingRequestSchema)),
  /** Clear a pending request (after granting, or to dismiss). */
  resolveRequest: (id: string, userId: string) =>
    invokeWithValidation('collection_resolve_request', z.null(), { id, userId }),
} as const;

// Per-user library tree (ADR 0016 view hierarchy): an opaque, client-encrypted
// blob (folders + collection placement). The server stores/returns it verbatim.
export const BackendLibrary = {
  get: () => invokeWithValidation('library_get', z.object({ blob: z.string().nullable() })),
  set: (blob: string) => invokeWithValidation('library_set', z.null(), { blob }),
} as const;

export const Backend = {
  Auth: BackendAuth,
  Settings: BackendSettings,
  Connections: BackendConnections,
  Terminal: BackendTerminal,
  Ssh: BackendSsh,
  Server: BackendServer,
  Admin: BackendAdmin,
  Context: BackendContext,
  Teams: BackendTeams,
  Vault: BackendVault,
  Collections: BackendCollections,
  Library: BackendLibrary,
} as const;

// Export types for external use
export type UnlockResponse = z.infer<typeof UnlockResponseSchema>;
export type ConnectionInfo = z.infer<typeof ConnectionInfoSchema>;
export type PasswordStrength = z.infer<typeof PasswordStrengthSchema>;
export type SshConfigEntry = z.infer<typeof SshConfigEntrySchema>;
