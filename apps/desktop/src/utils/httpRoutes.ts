/**
 * Maps Backend command names to rite-server HTTP calls.
 *
 * Each route shapes its response to match exactly what the corresponding Backend
 * command returns, so the Zod schemas in `utils/backend.ts` validate identically
 * whether the app runs over Backend or over HTTP. Commands rite-server does not
 * expose yet throw a clear error. Used only by the HTTP transport.
 */

import { bearerToken } from './session';
import { RiteHttpError, kindFor, notifyUnauthorized } from './httpError';

type Args = Record<string, unknown>;
type Route = (args: Args) => Promise<unknown>;

async function json<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  // Session token (server mode) or the loopback launch token (desktop shell).
  const token = bearerToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    // Network failure — the server couldn't be reached at all.
    throw new RiteHttpError(`can't reach the server (${path})`, 0, 'unreachable');
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = ((await res.json()) as { error?: string }).error ?? detail;
    } catch {
      // response had no JSON body
    }
    // A mid-session 401 means the token was revoked/expired → global sign-out + notice.
    if (res.status === 401) notifyUnauthorized();
    throw new RiteHttpError(`rite-server ${path} failed: ${detail}`, res.status, kindFor(res.status));
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
  change_master_password: async (a) => {
    await json('/api/auth/change-master-password', post({ old: a.old, new: a.new }));
    return null;
  },
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

  list_agent_identities: () => json('/api/ssh/agent-identities'),
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
  server_register: (a) =>
    json(
      '/api/server/register',
      post({
        username: a.username,
        salt: a.salt,
        params: a.params,
        authHash: a.authHash,
        masterSalt: a.masterSalt,
        protectedUserKey: a.protectedUserKey,
        publicKey: a.publicKey,
        protectedPrivateKey: a.protectedPrivateKey,
        ...(a.token ? { token: a.token } : {}),
      }),
    ),
  server_logout: async () => {
    await json('/api/server/logout', { method: 'POST' });
    return null;
  },
  server_me: () => json('/api/server/me'),
  server_change_password: async (a) => {
    await json('/api/server/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        salt: a.salt,
        params: a.params,
        authHash: a.authHash,
        masterSalt: a.masterSalt,
        protectedUserKey: a.protectedUserKey,
        publicKey: a.publicKey,
        protectedPrivateKey: a.protectedPrivateKey,
      }),
    });
    return null;
  },
  // On-demand active health-check. Governance responses (403 off/restricted, 429 rate-limited)
  // surface as typed RiteHttpErrors for the caller to degrade on; success returns the verdicts.
  server_probe_health: (a) => json('/api/healthcheck/probe', post({ targets: a.targets })),

  context_get: () => json('/api/context'),
  context_add_server: (a) => json('/api/context/servers', post({ url: a.url, label: a.label })),
  context_update_server: (a) =>
    json(`/api/context/servers/${encodeURIComponent(String(a.id))}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: a.url, label: a.label }),
    }),
  context_remove_server: async (a) => {
    await json(`/api/context/servers/${encodeURIComponent(String(a.id))}`, { method: 'DELETE' });
    return null;
  },
  context_set_active: async (a) => {
    await json('/api/context/active', post({ server: a.server }));
    return null;
  },
  context_probe: (a) => json('/api/context/probe', post({ url: a.url })),
  context_set_server_icon: async (a) => {
    await json(`/api/context/servers/${encodeURIComponent(String(a.id))}/icon`, post({ icon: a.icon }));
    return null;
  },
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
  admin_set_role: async (a) => {
    await json(`/api/admin/users/${encodeURIComponent(String(a.id))}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: a.role }),
    });
    return null;
  },
  admin_reset_user: async (a) => {
    await json(`/api/admin/users/${encodeURIComponent(String(a.id))}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        salt: a.salt,
        params: a.params,
        authHash: a.authHash,
        masterSalt: a.masterSalt,
        protectedUserKey: a.protectedUserKey,
        publicKey: a.publicKey,
        protectedPrivateKey: a.protectedPrivateKey,
      }),
    });
    return null;
  },
  admin_delete_user: async (a) => {
    await json(`/api/admin/users/${encodeURIComponent(String(a.id))}`, { method: 'DELETE' });
    return null;
  },
  admin_set_instance: async (a) => {
    await json('/api/admin/instance', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: a.name }),
    });
    return null;
  },
  admin_set_session_persistence: async (a) => {
    await json('/api/admin/session-persistence', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: a.enabled }),
    });
    return null;
  },
  admin_set_default_shell: async (a) => {
    await json('/api/admin/default-shell', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shell: a.shell }),
    });
    return null;
  },
  admin_set_quick_ssh: async (a) => {
    await json('/api/admin/quick-ssh', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: a.enabled }),
    });
    return null;
  },
  admin_set_open_registration: async (a) => {
    await json('/api/admin/registration', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: a.enabled }),
    });
    return null;
  },
  admin_set_allow_invitations: async (a) => {
    await json('/api/admin/invitations', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: a.enabled }),
    });
    return null;
  },
  admin_set_confirm_role_change: async (a) => {
    await json('/api/admin/confirm-role-change', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: a.enabled }),
    });
    return null;
  },
  admin_list_enrollment_tokens: () => json('/api/admin/enrollment-tokens'),
  admin_create_enrollment_token: (a) =>
    json('/api/admin/enrollment-tokens', post({ role: a.role, teams: a.teams, expiresInSecs: a.expiresInSecs })),
  admin_revoke_enrollment_token: async (a) => {
    await json(`/api/admin/enrollment-tokens/${encodeURIComponent(String(a.id))}`, { method: 'DELETE' });
    return null;
  },
  admin_set_healthcheck: async (a) => {
    await json('/api/admin/healthcheck', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(a),
    });
    return null;
  },
  admin_set_collection_policy: async (a) => {
    await json('/api/admin/collection-policy', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(a),
    });
    return null;
  },

  // Teams / RBAC (product-model) — keyless rosters (ADR 0016).
  admin_list_teams: () => json('/api/admin/teams'),
  admin_create_team: (a) => json('/api/admin/teams', post({ name: a.name })),
  admin_delete_team: async (a) => {
    await json(`/api/admin/teams/${encodeURIComponent(String(a.id))}`, { method: 'DELETE' });
    return null;
  },

  // Collections governance (admin).
  admin_list_collections: () => json('/api/admin/collections'),
  admin_collection_members: (a) =>
    json(`/api/admin/collections/${encodeURIComponent(String(a.id))}/members`),
  admin_remove_collection_member: async (a) => {
    await json(
      `/api/admin/collections/${encodeURIComponent(String(a.id))}/members/${encodeURIComponent(String(a.userId))}`,
      { method: 'DELETE' },
    );
    return null;
  },
  admin_delete_collection: async (a) => {
    await json(`/api/admin/collections/${encodeURIComponent(String(a.id))}`, { method: 'DELETE' });
    return null;
  },

  // Admin-group escrow (ADR 0016 split-key).
  admin_group_key: () => json('/api/admin/group-key'),
  admin_group_grant: async () => {
    // 404 = this admin holds no grant yet → surface as null, not an error.
    try {
      return await json('/api/admin/group-grant');
    } catch {
      return null;
    }
  },
  admin_list_admins: () => json('/api/admin/admins'),
  admin_set_group_key: async (a) => {
    await json('/api/admin/group-key', post({ epoch: a.epoch, publicKey: a.publicKey, grants: a.grants }));
    return null;
  },
  admin_grant_admin: async (a) => {
    await json('/api/admin/group-grant', post({ userId: a.userId, protectedPrivateKey: a.protectedPrivateKey }));
    return null;
  },
  admin_set_escrow: async (a) => {
    await json(`/api/admin/collections/${encodeURIComponent(String(a.id))}/escrow`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metaKeyGroupEnc: a.metaKeyGroupEnc, groupEpoch: a.groupEpoch }),
    });
    return null;
  },
  admin_add_collection_member: async (a) => {
    await json(`/api/admin/collections/${encodeURIComponent(String(a.id))}/members`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: a.userId, protectedMetaKey: a.protectedMetaKey }),
    });
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
  vault_conn_list: () => json('/api/vault/connections'),
  vault_conn_create: (a) => json('/api/vault/connections', post({ blob: a.blob })),
  vault_conn_update: async (a) => {
    await json(`/api/vault/connections/${encodeURIComponent(String(a.id))}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: a.blob }),
    });
    return null;
  },
  vault_conn_delete: async (a) => {
    await json(`/api/vault/connections/${encodeURIComponent(String(a.id))}`, { method: 'DELETE' });
    return null;
  },

  // Collections — the unified sharing primitive (ADR 0016). Names/items are opaque
  // blobs; the browser seals/unwraps the collection key and encrypts client-side.
  directory_list: () => json('/api/directory'),
  collections_mine: () => json('/api/collections'),
  collections_group_key: () => json('/api/collections/group-key'),
  collection_create: (a) =>
    json(
      '/api/collections',
      post({
        nameEnc: a.nameEnc,
        protectedMetaKey: a.protectedMetaKey,
        protectedItemsKey: a.protectedItemsKey,
        metaKeyGroupEnc: a.metaKeyGroupEnc ?? null,
        groupEpoch: a.groupEpoch ?? null,
      }),
    ),
  collection_update: async (a) => {
    await json(`/api/collections/${encodeURIComponent(String(a.id))}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nameEnc: a.nameEnc }),
    });
    return null;
  },
  collection_delete: async (a) => {
    await json(`/api/collections/${encodeURIComponent(String(a.id))}`, { method: 'DELETE' });
    return null;
  },
  collection_members: (a) => json(`/api/collections/${encodeURIComponent(String(a.id))}/members`),
  collection_add_member: async (a) => {
    await json(
      `/api/collections/${encodeURIComponent(String(a.id))}/members`,
      post({
        userId: a.userId,
        role: a.role,
        protectedMetaKey: a.protectedMetaKey,
        protectedItemsKey: a.protectedItemsKey,
      }),
    );
    return null;
  },
  collection_set_role: async (a) => {
    await json(
      `/api/collections/${encodeURIComponent(String(a.id))}/members/${encodeURIComponent(String(a.userId))}`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: a.role }) },
    );
    return null;
  },
  collection_remove_member: async (a) => {
    await json(
      `/api/collections/${encodeURIComponent(String(a.id))}/members/${encodeURIComponent(String(a.userId))}`,
      { method: 'DELETE' },
    );
    return null;
  },
  collection_items: (a) => json(`/api/collections/${encodeURIComponent(String(a.id))}/items`),
  collection_item_create: (a) =>
    json(`/api/collections/${encodeURIComponent(String(a.id))}/items`, post({ blob: a.blob })),
  collection_item_update: async (a) => {
    await json(
      `/api/collections/${encodeURIComponent(String(a.id))}/items/${encodeURIComponent(String(a.itemId))}`,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: a.blob }) },
    );
    return null;
  },
  collection_item_delete: async (a) => {
    await json(
      `/api/collections/${encodeURIComponent(String(a.id))}/items/${encodeURIComponent(String(a.itemId))}`,
      { method: 'DELETE' },
    );
    return null;
  },
  // Offer-to-team discovery (ADR 0016).
  collections_offered: () => json('/api/collections/offered'),
  collection_set_offer: async (a) => {
    await json(`/api/collections/${encodeURIComponent(String(a.id))}/offer`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ teamId: a.teamId, discoveryLabel: a.discoveryLabel }),
    });
    return null;
  },
  collection_clear_offer: async (a) => {
    await json(`/api/collections/${encodeURIComponent(String(a.id))}/offer`, { method: 'DELETE' });
    return null;
  },
  collection_request_access: async (a) => {
    await json(`/api/collections/${encodeURIComponent(String(a.id))}/request`, { method: 'POST' });
    return null;
  },
  collections_requests: () => json('/api/collections/requests'),
  collection_resolve_request: async (a) => {
    await json(`/api/collections/${encodeURIComponent(String(a.id))}/request`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: a.userId }),
    });
    return null;
  },

  // Per-user library tree (ADR 0016): opaque client-encrypted blob.
  library_get: () => json('/api/user/library'),
  library_set: async (a) => {
    await json('/api/user/library', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: a.blob }),
    });
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
  kbd_interactive_respond: (a) =>
    json('/api/ssh/kbd-interactive/respond', post({ challengeId: a.challengeId, responses: a.responses })),

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
