/**
 * Browser mock backend for the Vite dev preview.
 *
 * `pnpm dev:frontend` runs the app with no Rust backend, so real calls would
 * fail. This module provides schema-valid mock responses (via `mockInvoke`) so
 * the UI is fully browsable and iterable standalone. It is a pure dev/preview
 * aid: the Http transport is used everywhere the real backend is present.
 */

const now = () => Math.floor(Date.now() / 1000);

interface MockConnection {
  id: string;
  name: string;
  protocol: string;
  hostname: string;
  port: number;
  username: string;
  authType: string;
  folder: string | null;
  color: string | null;
  icon: string | null;
  notes: string | null;
  sshKeepAliveOverride: string | null;
  sshKeepAliveInterval: number | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

// In-memory connection store so create/update/delete feel real during preview.
let mockConnections: MockConnection[] = [
  {
    id: 'demo-web-01',
    name: 'Web Server (demo)',
    protocol: 'ssh',
    hostname: '192.168.1.10',
    port: 22,
    username: 'deploy',
    authType: 'password',
    folder: 'Production',
    color: '#89b4fa',
    icon: null,
    notes: 'Demo connection — browser preview only',
    sshKeepAliveOverride: 'enabled',
    sshKeepAliveInterval: 30,
    createdAt: now() - 86400,
    updatedAt: now() - 3600,
    lastUsedAt: now() - 1800,
  },
  {
    id: 'demo-db-01',
    name: 'Database (demo)',
    protocol: 'ssh',
    hostname: 'db.example.com',
    port: 2222,
    username: 'admin',
    authType: 'publicKey',
    folder: 'Production',
    color: '#a6e3a1',
    icon: null,
    notes: null,
    sshKeepAliveOverride: 'disabled',
    sshKeepAliveInterval: null,
    createdAt: now() - 172800,
    updatedAt: now() - 7200,
    lastUsedAt: null,
  },
];

const mockSettings: Record<string, string> = {
  language: 'en',
  autoLockEnabled: 'false',
  autoLockTimeout: '5',
  clipboardClearEnabled: 'true',
  hostKeyVerificationMode: 'strict',
  defaultShell: '/bin/bash',
  theme: 'dark',
};

const commonShells = ['/bin/bash', '/bin/zsh', '/usr/bin/fish', '/bin/sh'];

function toConnection(input: Record<string, unknown>): MockConnection {
  const i = (input?.input as Record<string, unknown>) ?? input ?? {};
  return {
    id: (i.id as string) || `demo-${Math.random().toString(36).slice(2, 8)}`,
    name: (i.name as string) || 'New connection',
    protocol: (i.protocol as string) || 'ssh',
    hostname: (i.hostname as string) || 'localhost',
    port: (i.port as number) ?? 22,
    username: (i.username as string) || 'user',
    authType: (i.authType as string) || 'password',
    folder: (i.folder as string) ?? null,
    color: (i.color as string) ?? null,
    icon: (i.icon as string) ?? null,
    notes: (i.notes as string) ?? null,
    sshKeepAliveOverride: (i.sshKeepAliveOverride as string) ?? null,
    sshKeepAliveInterval: (i.sshKeepAliveInterval as number) ?? null,
    createdAt: now(),
    updatedAt: now(),
    lastUsedAt: null,
  };
}

/** Return a mock response for a Backend command. */
export async function mockInvoke(
  command: string,
  args?: Record<string, unknown>
): Promise<unknown> {
  switch (command) {
    // --- Auth ---
    case 'is_first_run':
      return false;
    case 'is_locked':
      return false;
    case 'unlock':
      return { type: 'success' };
    case 'lock':
    case 'setup_master_password':
    case 'reset_database':
      return null;
    case 'validate_password': {
      const pw = String(args?.password ?? '');
      const score = Math.min(6, Math.floor(pw.length / 3));
      return { is_valid: pw.length >= 12, score, feedback: [] };
    }

    // --- Settings ---
    case 'get_all_settings':
      return mockSettings;
    case 'get_setting':
      return mockSettings[String(args?.key ?? '')] ?? null;
    case 'set_setting':
      mockSettings[String(args?.key ?? '')] = String(args?.value ?? '');
      return null;

    // --- Connections ---
    case 'get_all_connections':
      return mockConnections;
    case 'create_connection': {
      const c = toConnection(args ?? {});
      mockConnections = [...mockConnections, c];
      return c;
    }
    case 'update_connection': {
      const c = toConnection(args ?? {});
      mockConnections = mockConnections.map((existing) =>
        existing.id === c.id ? c : existing
      );
      return c;
    }
    case 'delete_connection':
      mockConnections = mockConnections.filter((c) => c.id !== args?.id);
      return null;
    case 'get_default_ssh_config_path':
      return '~/.ssh/config';
    case 'parse_ssh_config':
      return [];
    case 'import_ssh_config_entries':
      return [];
    case 'accept_host_key':
    case 'reject_host_key':
      return null;

    // --- Server accounts (dev mock behaves as local: no accounts) ---
    case 'server_mode':
      return { accounts: false, needsBootstrap: false, instanceName: null, sessionPersistence: true, defaultShell: 'bash', allowQuickSsh: false };
    case 'admin_set_instance':
    case 'admin_set_session_persistence':
    case 'admin_set_default_shell':
    case 'admin_set_quick_ssh':
      return null;
    case 'server_prelogin':
      return { salt: '00112233445566778899aabbccddeeff', params: { mem: 19456, iter: 2, par: 1 } };
    case 'server_login':
    case 'server_bootstrap':
      return {
        token: 'mock-session',
        user: {
          id: 'mock-admin',
          username: String(args?.username ?? 'admin'),
          role: 'admin',
          status: 'active',
          createdAt: now(),
        },
        vault: null,
      };
    case 'server_logout':
      return null;
    case 'server_me':
      return {
        user: {
          id: 'mock-admin',
          username: 'admin',
          role: 'admin',
          status: 'active',
          createdAt: now(),
        },
        vault: null,
      };
    case 'admin_list_users':
      return [
        { id: 'mock-admin', username: 'admin', role: 'admin', status: 'active', createdAt: now() },
      ];
    case 'admin_create_user':
      return {
        id: `mock-${Math.random().toString(36).slice(2, 8)}`,
        username: String(args?.username ?? 'user'),
        role: String(args?.role ?? 'user'),
        status: 'active',
        createdAt: now(),
      };
    case 'admin_set_status':
    case 'admin_delete_user':
      return null;

    // --- Teams (dev mock: empty) ---
    case 'admin_list_teams':
    case 'teams_mine':
    case 'team_members':
    case 'vault_conn_list':
      return [];
    case 'vault_conn_create':
      return { id: `vc-${Math.random().toString(36).slice(2, 8)}`, blob: String(args?.blob ?? ''), createdAt: now(), updatedAt: now() };
    case 'vault_conn_update':
    case 'vault_conn_delete':
      return null;
    case 'admin_create_team':
      return { id: `team-${Math.random().toString(36).slice(2, 8)}`, name: String(args?.name ?? ''), createdAt: now() };
    case 'admin_delete_team':
    case 'team_add_member':
    case 'team_remove_member':
      return null;

    // --- Collections (ADR 0016; dev mock: empty) ---
    case 'directory_list':
    case 'collections_mine':
    case 'collection_members':
    case 'collection_items':
    case 'collections_offered':
    case 'collections_requests':
      return [];
    case 'collection_create':
      return { id: `col-${Math.random().toString(36).slice(2, 8)}` };
    case 'collection_item_create':
      return { id: `ci-${Math.random().toString(36).slice(2, 8)}`, blob: String(args?.blob ?? ''), createdAt: now(), updatedAt: now() };
    case 'collection_update':
    case 'collection_delete':
    case 'collection_add_member':
    case 'collection_set_role':
    case 'collection_remove_member':
    case 'collection_item_update':
    case 'collection_item_delete':
    case 'collection_set_offer':
    case 'collection_clear_offer':
    case 'collection_request_access':
    case 'collection_resolve_request':
      return null;

    // --- Library tree (ADR 0016; dev mock: empty) ---
    case 'library_get':
      return { blob: null };
    case 'library_set':
      return null;

    // --- Context multiplexer (dev mock: local only, empty roster) ---
    case 'context_get':
      return { active: 'local', roster: [] };
    case 'context_add_server':
      return {
        id: `mock-${Math.random().toString(36).slice(2, 8)}`,
        url: String(args?.url ?? ''),
        label: String(args?.label || args?.url || ''),
      };
    case 'context_remove_server':
    case 'context_set_active':
    case 'context_pin_server':
    case 'context_vault_unlock':
    case 'context_vault_lock':
      return null;
    case 'context_probe':
      // Dev mock: pretend every probed remote has a trusted (real) cert.
      return { trusted: true, fingerprint: null };
    case 'context_vault_status':
      return { unlocked: false };

    // --- Terminal (no backend PTY in the browser; sessions are inert) ---
    case 'get_installed_shells':
      return (args?.shells as string[]) ?? commonShells;
    case 'connect_terminal':
    case 'connect_local_terminal':
    case 'quick_ssh_connect':
      return `mock-session-${Math.random().toString(36).slice(2, 8)}`;
    case 'claim_session_output':
      return '';
    case 'send_terminal_input':
    case 'resize_terminal':
    case 'disconnect_terminal':
      return null;

    default:
      console.warn(`[mockBackend] unhandled command: ${command}`);
      return null;
  }
}
