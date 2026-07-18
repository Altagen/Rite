/**
 * Maps Backend command names to rite-server HTTP calls.
 *
 * Each route shapes its response to match exactly what the corresponding Backend
 * command returns, so the Zod schemas in `utils/backend.ts` validate identically
 * whether the app runs over Backend or over HTTP. Commands rite-server does not
 * expose yet throw a clear error. Used only by the HTTP transport.
 */

import { bearerToken } from './session';

type Args = Record<string, unknown>;
type Route = (args: Args) => Promise<unknown>;

async function json<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  // Session token (server mode) or the loopback launch token (desktop shell).
  const token = bearerToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = ((await res.json()) as { error?: string }).error ?? detail;
    } catch {
      // response had no JSON body
    }
    throw new Error(`rite-server ${path} failed: ${detail}`);
  }
  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const routes: Record<string, Route> = {
  is_first_run: () => json('/api/auth/first-run'),
  is_locked: () => json('/api/auth/locked'),
  unlock: (a) => json('/api/auth/unlock', post({ password: a.password })),
  setup_master_password: (a) => json('/api/auth/setup', post({ password: a.password })),
  lock: () => json('/api/auth/lock', { method: 'POST' }),
  reset_database: () => json('/api/auth/reset', { method: 'POST' }),
  validate_password: (a) => json('/api/auth/validate-password', post({ password: a.password })),

  get_all_settings: () => json('/api/settings'),
  get_setting: (a) => json(`/api/settings/${encodeURIComponent(String(a.key))}`),
  set_setting: async (a) => {
    await json(`/api/settings/${encodeURIComponent(String(a.key))}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: a.value }),
    });
    return null;
  },

  get_all_connections: () => json('/api/connections'),
  create_connection: (a) => json('/api/connections', post(a.input)),
  update_connection: (a) => {
    const input = a.input as { id: string };
    return json(`/api/connections/${encodeURIComponent(input.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(a.input),
    });
  },
  delete_connection: async (a) => {
    await json(`/api/connections/${encodeURIComponent(String(a.id))}`, { method: 'DELETE' });
    return null;
  },

  get_default_ssh_config_path: () => json('/api/ssh-config/default-path'),
  parse_ssh_config: (a) => json('/api/ssh-config/parse', post({ configPath: a.configPath })),
  import_ssh_config_entries: (a) => json('/api/ssh-config/import', post({ entries: a.entries })),

  server_mode: () => json('/api/server/mode'),
  server_prelogin: (a) => json('/api/server/prelogin', post({ username: a.username })),
  server_login: (a) =>
    json('/api/server/login', post({ username: a.username, authHash: a.authHash })),
  server_bootstrap: (a) =>
    json(
      '/api/server/bootstrap',
      post({
        username: a.username,
        salt: a.salt,
        params: a.params,
        authHash: a.authHash,
        masterSalt: a.masterSalt,
        protectedUserKey: a.protectedUserKey,
        publicKey: a.publicKey,
        protectedPrivateKey: a.protectedPrivateKey,
      }),
    ),
  server_logout: async () => {
    await json('/api/server/logout', { method: 'POST' });
    return null;
  },
  server_me: () => json('/api/server/me'),

  context_get: () => json('/api/context'),
  context_add_server: (a) => json('/api/context/servers', post({ url: a.url, label: a.label })),
  context_remove_server: async (a) => {
    await json(`/api/context/servers/${encodeURIComponent(String(a.id))}`, { method: 'DELETE' });
    return null;
  },
  context_set_active: async (a) => {
    await json('/api/context/active', post({ server: a.server }));
    return null;
  },
  context_probe: (a) => json('/api/context/probe', post({ url: a.url })),
  context_pin_server: async (a) => {
    await json(`/api/context/servers/${encodeURIComponent(String(a.id))}/pin`, post({ fingerprint: a.fingerprint }));
    return null;
  },
  context_vault_unlock: async (a) => {
    await json('/api/context/vault/unlock', post({ userKey: a.userKey, autoLockSecs: a.autoLockSecs }));
    return null;
  },
  context_vault_status: () => json('/api/context/vault/status'),
  context_vault_lock: async () => {
    await json('/api/context/vault/lock', { method: 'POST' });
    return null;
  },

  admin_list_users: () => json('/api/admin/users'),
  admin_create_user: (a) =>
    json(
      '/api/admin/users',
      post({
        username: a.username,
        salt: a.salt,
        params: a.params,
        authHash: a.authHash,
        role: a.role,
        masterSalt: a.masterSalt,
        protectedUserKey: a.protectedUserKey,
        publicKey: a.publicKey,
        protectedPrivateKey: a.protectedPrivateKey,
      }),
    ),
  admin_set_status: async (a) => {
    await json(`/api/admin/users/${encodeURIComponent(String(a.id))}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: a.status }),
    });
    return null;
  },
  admin_delete_user: async (a) => {
    await json(`/api/admin/users/${encodeURIComponent(String(a.id))}`, { method: 'DELETE' });
    return null;
  },

  // Teams / RBAC (product-model) + team key sharing (ADR 0013).
  admin_list_teams: () => json('/api/admin/teams'),
  admin_create_team: (a) => json('/api/admin/teams', post({ name: a.name })),
  admin_delete_team: async (a) => {
    await json(`/api/admin/teams/${encodeURIComponent(String(a.id))}`, { method: 'DELETE' });
    return null;
  },
  teams_mine: () => json('/api/teams'),
  team_members: (a) => json(`/api/teams/${encodeURIComponent(String(a.id))}/members`),
  team_add_member: async (a) => {
    await json(`/api/teams/${encodeURIComponent(String(a.id))}/members`, post({ userId: a.userId, role: a.role }));
    return null;
  },
  team_remove_member: async (a) => {
    await json(
      `/api/teams/${encodeURIComponent(String(a.id))}/members/${encodeURIComponent(String(a.userId))}`,
      { method: 'DELETE' },
    );
    return null;
  },
  team_grant_key: async (a) => {
    await json(
      `/api/teams/${encodeURIComponent(String(a.id))}/members/${encodeURIComponent(String(a.userId))}/key`,
      post({ protectedTeamKey: a.protectedTeamKey }),
    );
    return null;
  },
  team_revoke_key: async (a) => {
    await json(
      `/api/teams/${encodeURIComponent(String(a.id))}/members/${encodeURIComponent(String(a.userId))}/key`,
      { method: 'DELETE' },
    );
    return null;
  },

  accept_host_key: async (a) => {
    await json('/api/ssh/host-key/accept', post({ host: a.host, port: a.port }));
    return null;
  },
  reject_host_key: async (a) => {
    await json('/api/ssh/host-key/reject', post({ host: a.host, port: a.port }));
    return null;
  },

  quick_ssh_connect: async (a) =>
    (
      await json<{ sessionId: string }>(
        '/api/terminal/quick-ssh',
        post({ host: a.host, port: a.port, username: a.username, authMethod: a.authMethod }),
      )
    ).sessionId,

  get_installed_shells: (a) => json('/api/shells', post({ shells: a.shells })),

  list_sessions: () => json('/api/terminal'),

  connect_terminal: async (a) =>
    (await json<{ sessionId: string }>('/api/terminal/ssh', post({ connectionId: a.connectionId })))
      .sessionId,

  connect_local_terminal: async (a) =>
    (await json<{ sessionId: string }>('/api/terminal/local', post({ shell: a.shell }))).sessionId,

  send_terminal_input: async (a) => {
    await json(`/api/terminal/${a.sessionId}/input`, post({ data: a.data }));
    return null;
  },

  claim_session_output: async (a) =>
    (await json<{ data: string }>(`/api/terminal/${a.sessionId}/claim`, { method: 'POST' })).data,

  resize_terminal: async (a) => {
    await json(`/api/terminal/${a.sessionId}/resize`, post({ cols: a.cols, rows: a.rows }));
    return null;
  },

  disconnect_terminal: async (a) => {
    await json(`/api/terminal/${a.sessionId}`, { method: 'DELETE' });
    return null;
  },
};

export async function httpInvoke(command: string, args: Args): Promise<unknown> {
  const route = routes[command];
  if (!route) {
    throw new Error(`rite-server does not yet expose command '${command}'`);
  }
  return route(args);
}
