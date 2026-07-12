/**
 * Browser mock for the Tauri IPC layer.
 *
 * When the frontend runs in a plain browser (e.g. `vite` dev server) instead of
 * the Tauri WebView, `window.__TAURI_INTERNALS__` is absent and real `invoke`
 * calls would fail. This module provides schema-valid mock responses so the UI
 * is fully browsable and iterable without the Rust backend. It is a pure
 * dev/preview aid — in the real app `isTauri()` is true and it is never used.
 */

/** True when running inside the Tauri WebView (real backend available). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

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

/** Return a mock response for a Tauri command. */
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
      console.warn(`[tauriMock] unhandled command: ${command}`);
      return null;
  }
}
