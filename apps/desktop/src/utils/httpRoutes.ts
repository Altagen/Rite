/**
 * Maps Tauri command names to rite-server HTTP calls.
 *
 * Each route shapes its response to match exactly what the corresponding Tauri
 * command returns, so the Zod schemas in `utils/tauri.ts` validate identically
 * whether the app runs over Tauri or over HTTP. Commands rite-server does not
 * expose yet throw a clear error. Used only by the HTTP transport.
 */

type Args = Record<string, unknown>;
type Route = (args: Args) => Promise<unknown>;

async function json<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
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
