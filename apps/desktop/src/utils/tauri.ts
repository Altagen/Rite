/**
 * Tauri Commands Wrapper with Zod Validation
 *
 * This module provides type-safe wrappers for all Tauri commands with runtime validation.
 * All responses from the Rust backend are validated using Zod schemas to ensure type safety.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { z } from 'zod';
import { errorHandler, ErrorSeverity, ErrorCategory } from './errorHandler';

/**
 * Generic wrapper for Tauri invoke with Zod validation
 */
async function invokeWithValidation<T>(
  command: string,
  schema: z.ZodType<T>,
  args?: Record<string, unknown>
): Promise<T> {
  try {
    const response = await tauriInvoke(command, args);

    // Validate response with Zod
    const result = schema.safeParse(response);

    if (!result.success) {
      // Log validation error with details
      errorHandler.handle(`Tauri command '${command}' returned invalid data`, {
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
      errorHandler.handle(`Tauri command '${command}' failed`, {
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
// Zod Schemas for Tauri Command Responses
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
// Type-Safe Tauri Command Wrappers
// ============================================================================

// Auth Commands
export const TauriAuth = {
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
export const TauriSettings = {
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
export const TauriConnections = {
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

// Terminal Commands
export const TauriTerminal = {
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
   * Disconnect a terminal session
   */
  disconnectTerminal: (sessionId: string) =>
    invokeWithValidation('disconnect_terminal', z.null(), { sessionId }),
} as const;

// ============================================================================
// Unified Tauri API
// ============================================================================

/**
 * Type-safe Tauri API with runtime validation
 *
 * Usage:
 * ```ts
 * import { Tauri } from '@/utils/tauri';
 *
 * // Auth
 * const isFirstRun = await Tauri.Auth.isFirstRun();
 *
 * // Settings
 * const settings = await Tauri.Settings.getAllSettings();
 *
 * // Connections
 * const connections = await Tauri.Connections.getAllConnections();
 *
 * // Terminal
 * const sessionId = await Tauri.Terminal.connectTerminal(connectionId);
 * ```
 */
export const Tauri = {
  Auth: TauriAuth,
  Settings: TauriSettings,
  Connections: TauriConnections,
  Terminal: TauriTerminal,
} as const;

// Export types for external use
export type UnlockResponse = z.infer<typeof UnlockResponseSchema>;
export type ConnectionInfo = z.infer<typeof ConnectionInfoSchema>;
export type PasswordStrength = z.infer<typeof PasswordStrengthSchema>;
export type SshConfigEntry = z.infer<typeof SshConfigEntrySchema>;
