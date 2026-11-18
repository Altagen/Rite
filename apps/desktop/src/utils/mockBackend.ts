/**
 * Browser mock backend for the Vite dev preview.
 *
 * `pnpm dev:frontend` runs the app with no Rust backend, so real calls would
 * fail. This module provides schema-valid mock responses (via `mockInvoke`) so
 * the UI is fully browsable and iterable standalone. It is a pure dev/preview
 * aid: the Http transport is used everywhere the real backend is present.
 */

const now = () => Math.floor(Date.now() / 1000);

/**
 * A LOCAL VAULT'S CONTENTS, invented.
 *
 * These are the fixtures `design/mock/full-data.js` used to carry, moved to where they
 * feed the real components instead of a parallel drawing of them. Mutable, because the
 * preview is for clicking around: creating a machine has to show up in the library.
 */
let localCollections: {
  id: string;
  name: string;
  color: string | null;
  createdAt: number;
  folders: { name: string; color: string | null }[];
  hc: boolean | null;
  labels: (string | { label: string; color?: string; description?: string })[];
  hasBoard: boolean;
}[] = [
  {
    id: 'lc-1',
    name: 'Production',
    color: '#f7768e',
    createdAt: now() - 86_400 * 30,
    folders: [{ name: 'Web servers', color: '#7c9cf5' }],
    hc: null,
    // Both stored shapes, because a word nobody coloured is a bare string and the
    // picker has to read either — see `store/labelsFormat.ts`.
    labels: ['eu-west', { label: 'pci', color: '#f7768e', description: 'Card data in scope' }],
    hasBoard: false,
  },
  {
    id: 'lc-2',
    name: 'Home lab',
    color: '#9ece6a',
    createdAt: now() - 86_400 * 9,
    folders: [],
    hc: null,
    labels: [],
    hasBoard: false,
  },
];

let localMachines: (MockConnection & { collectionId: string; labels?: string[] })[] = [];

/** The instance vocabulary, which Settings edits and every picker is offered. */
let instanceWords: { label: string; color?: string; description?: string }[] = [
  { label: 'pci', color: '#f7768e', description: 'Card data in scope' },
  { label: 'prod', color: '#e5b567', description: 'Serving real traffic' },
  { label: 'eu-west' },
];

/** The marks document: a conversation's name, colour and labels (ADR 0022 §6). */
let marksDoc = JSON.stringify({
  version: 1,
  marks: [
    { machine: '@local', tool: 'claude', id: 'c-1', name: 'The queue work', labels: ['prod'] },
  ],
});

// Dev harness (see utils/devHarness): when a `?harness` surface is requested, the mock
// behaves as a shared server so the accounts/admin screens render standalone. The flag is
// mirrored to sessionStorage because our navigate() drops the query on the first hop.
const harnessOn = () => {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(location.search).has('harness')) return true;
  try {
    return sessionStorage.getItem('rite-dev-harness') !== null;
  } catch {
    return false;
  }
};

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

/** A layout that exercises the shape without assuming the dev mock has any machine. */
let mockLayoutsFile = `[[layout]]
name = "Deploy watch"

  [[layout.pane]]
  command = "top"

  [[layout.pane]]
  command = "df -h"
`;

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
  args?: Record<string, unknown>,
): Promise<unknown> {
  const a = args ?? {};
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
    case 'change_master_password':
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

    // The layouts file. The dev mock has no filesystem, so it behaves like a server:
    // the text is kept in memory and there is no path to show.
    case 'get_layouts':
      return { text: mockLayoutsFile, path: null };
    case 'set_layouts':
      mockLayoutsFile = String(args?.text ?? '');
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
      mockConnections = mockConnections.map((existing) => (existing.id === c.id ? c : existing));
      return c;
    }
    case 'delete_connection':
      mockConnections = mockConnections.filter((c) => c.id !== args?.id);
      return null;
    case 'get_default_ssh_config_path':
      return '~/.ssh/config';
    case 'parse_ssh_config':
      return [];
    case 'accept_host_key':
    case 'reject_host_key':
      return null;
    case 'kbd_interactive_respond':
      // The mock has no live SSH auth flow; acknowledge so callers don't error.
      return { ok: true };

    // --- Server accounts ---
    // Default: behave as a local vault (no accounts). Under the dev harness (?harness=…) behave
    // as a shared server so the accounts/admin surfaces are browsable in the backend-less mock.
    case 'server_capabilities':
      return {
        version: '0.0.0-mock',
        commit: 'mock',
        builtAt: '2026-01-01',
        apiVersion: 1,
        minClient: '0.1.2',
      };
    case 'server_mode':
      return {
        accounts: harnessOn(),
        needsBootstrap: false,
        instanceName: harnessOn() ? 'Acme Corp' : null,
        sessionPersistence: true,
        defaultShell: 'bash',
        shells: ['bash', 'sh'],
        allowShellChoice: false,
        allowSecretStorage: true,
        allowSecretReveal: true,
        allowQuickSsh: false,
        openRegistration: false,
        allowInvitations: true,
        confirmRoleChange: false,
        healthcheck: {
          passiveStatus: true,
          active: 'off',
          methods: ['tcp-connect'],
          restrictUsers: [],
          minInterval: 60,
        },
        dashboardPolicy: { webui: true, clients: true, minInterval: 30 },
        agentPolicy: { webui: true, clients: true },
        managed: {},
        collectionPolicy: {
          allowCreate: true,
          allowSharingOutsideTeams: true,
          maxMembers: 0,
          defaultRole: 'viewer',
        },
      };
    case 'admin_set_instance':
    case 'admin_set_session_persistence':
    case 'admin_set_default_shell':
    case 'admin_set_shell_choice':
    case 'admin_set_host_key_mode':
    case 'admin_set_secret_storage':
    case 'admin_set_secret_reveal':
    case 'admin_set_quick_ssh':
    case 'admin_set_open_registration':
    case 'admin_set_allow_invitations':
    case 'admin_set_confirm_role_change':
    case 'admin_set_healthcheck':
    case 'admin_set_dashboard_policy':
    case 'admin_set_agent_policy':
    case 'admin_set_layouts_policy':
    case 'admin_set_collection_policy':
    case 'admin_revoke_enrollment_token':
      return null;
    case 'admin_list_enrollment_tokens':
      return [];
    case 'admin_create_enrollment_token':
      return {
        token: 'rite_mockmocktoken',
        info: {
          id: 'tok-mock',
          prefix: 'rite_mock',
          role: String(args?.role ?? 'user'),
          teams: (args?.teams as unknown[] | undefined) ?? [],
          expiresAt: null,
          createdAt: now(),
          consumedAt: null,
        },
      };
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
    case 'server_register':
      return {
        token: 'mock-session',
        user: {
          id: 'mock-user',
          username: String(args?.username ?? 'user'),
          role: 'user',
          status: 'active',
          createdAt: now(),
        },
        vault: null,
      };
    case 'server_change_password':
    case 'server_logout':
      return null;
    case 'server_probe_health': {
      // No real sockets in the mock: report each target reachable (icmp reads unsupported)
      // with a plausible latency so the active-probe UI can be exercised.
      const targets = (args?.targets as { id: string; method?: string }[] | undefined) ?? [];
      return {
        results: targets.map((t) => ({
          id: t.id,
          status: t.method === 'icmp' ? 'unsupported' : 'up',
          latencyMs: t.method === 'icmp' ? null : 8 + Math.floor(Math.random() * 40),
        })),
      };
    }
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
    case 'admin_list_users': {
      const day = 86400;
      return [
        {
          id: 'mock-admin',
          username: 'alex',
          role: 'admin',
          status: 'active',
          createdAt: now() - 270 * day,
          mustChangePassword: false,
        },
        {
          id: 'mock-carol',
          username: 'carol',
          role: 'user',
          status: 'active',
          createdAt: now() - 200 * day,
          mustChangePassword: false,
        },
        {
          id: 'mock-dan',
          username: 'dan',
          role: 'user',
          status: 'active',
          createdAt: now() - 160 * day,
          mustChangePassword: false,
        },
        {
          id: 'mock-erin',
          username: 'erin',
          role: 'user',
          status: 'active',
          createdAt: now() - 5 * day,
          mustChangePassword: true,
        },
        {
          id: 'mock-frank',
          username: 'frank',
          role: 'user',
          status: 'disabled',
          createdAt: now() - 2 * day,
          mustChangePassword: false,
        },
      ];
    }
    case 'admin_create_user':
      return {
        id: `mock-${Math.random().toString(36).slice(2, 8)}`,
        username: String(args?.username ?? 'user'),
        role: String(args?.role ?? 'user'),
        status: 'active',
        createdAt: now(),
      };
    case 'admin_set_status':
    case 'admin_reset_user':
    case 'admin_delete_user':
      return null;

    // --- Teams (rich under the harness so the admin Teams surface renders) ---
    case 'admin_list_teams': {
      const day = 86400;
      return [
        { id: 'team-eng', name: 'Eng', createdAt: now() - 200 * day },
        { id: 'team-ops', name: 'Ops', createdAt: now() - 150 * day },
        { id: 'team-design', name: 'Design', createdAt: now() - 100 * day },
      ];
    }
    case 'team_members':
      return [
        { userId: 'mock-admin', username: 'alex', role: 'admin', publicKey: null },
        { userId: 'mock-carol', username: 'carol', role: 'admin', publicKey: null },
        { userId: 'mock-dan', username: 'dan', role: 'member', publicKey: null },
      ];
    case 'teams_mine':
    case 'vault_conn_list':
      return [];
    case 'vault_conn_create':
      return {
        id: `vc-${Math.random().toString(36).slice(2, 8)}`,
        blob: String(args?.blob ?? ''),
        createdAt: now(),
        updatedAt: now(),
      };
    case 'vault_conn_update':
    case 'vault_conn_delete':
      return null;
    case 'admin_create_team':
      return {
        id: `team-${Math.random().toString(36).slice(2, 8)}`,
        name: String(args?.name ?? ''),
        createdAt: now(),
      };
    case 'admin_delete_team':
    case 'team_add_member':
    case 'team_remove_member':
      return null;

    // --- Admin collection governance (rich under the harness) ---
    // c-perso is a solo collection (1 member) → the governance list must exclude it.
    case 'admin_list_collections': {
      const day = 86400;
      const mk = (id: string, members: number, items: number, ageDays: number) => ({
        id,
        createdAt: now() - ageDays * day,
        memberCount: members,
        itemCount: items,
        nameEnc: '',
        metaKeyGroupEnc: null,
        groupEpoch: null,
      });
      return [
        mk('c-infra', 4, 1, 180),
        mk('c-prod', 3, 3, 150),
        mk('c-db', 2, 2, 120),
        mk('c-perso', 1, 2, 90),
      ];
    }
    case 'admin_collection_members':
      return [
        {
          userId: 'mock-admin',
          username: 'alex',
          role: 'owner',
          publicKey: null,
          hasItemsKey: true,
        },
        {
          userId: 'mock-carol',
          username: 'carol',
          role: 'editor',
          publicKey: null,
          hasItemsKey: true,
        },
        {
          userId: 'mock-dan',
          username: 'dan',
          role: 'viewer',
          publicKey: null,
          hasItemsKey: false,
        },
      ];
    case 'admin_list_admins':
      return [];

    // --- Collections (ADR 0016; dev mock: empty) ---
    case 'directory_list':
    case 'collections_mine':
    case 'collection_members':
    case 'collection_items':
    case 'collections_offered':
      return [];
    // Notifications (access requests). Rich under the harness so the bell + Notifications
    // page (pagination) are exercisable; otherwise empty like the rest of the dev mock.
    case 'collections_requests': {
      if (!harnessOn()) return [];
      const teams = ['Eng', 'Ops', 'Design', null];
      const names = [
        'carol',
        'dan',
        'erin',
        'frank',
        'grace',
        'heidi',
        'ivan',
        'judy',
        'mallory',
        'niaj',
        'olivia',
      ];
      return names.map((u, i) => ({
        collectionId: `c-${i % 3}`,
        userId: `mock-${u}`,
        username: u,
        publicKey: null,
        teamName: teams[i % teams.length],
        createdAt: now() - i * 3600,
      }));
    }
    case 'collection_create':
      return { id: `col-${Math.random().toString(36).slice(2, 8)}` };
    case 'collection_item_create':
      return {
        id: `ci-${Math.random().toString(36).slice(2, 8)}`,
        blob: String(args?.blob ?? ''),
        createdAt: now(),
        updatedAt: now(),
      };
    case 'collection_update':
    case 'collection_delete':
    case 'collection_add_member':
    case 'collection_set_role':
    case 'collection_remove_member':
    case 'collection_item_update':
    case 'collection_item_delete':
    case 'collection_set_board':
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

    // --- Account layouts (ADR 0027; dev mock: no account, so no blob) ---
    case 'user_layouts_get':
      return { blob: null, updatedAt: null };
    case 'user_layouts_set':
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
    case 'context_update_server':
      return {
        id: String(args?.id ?? ''),
        url: String(args?.url ?? ''),
        label: String(args?.label || args?.url || ''),
      };
    case 'context_remove_server':
    case 'context_set_active':
    case 'context_pin_server':
    case 'context_set_server_icon':
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
    case 'list_agent_identities':
      // Mirrors the design mock's AGENT fixture (a plain key + a hardware key).
      return [
        {
          name: 'id_ed25519',
          fingerprint: 'SHA256:aB3k9…Qz',
          algo: 'ssh-ed25519',
          hardware: false,
        },
        {
          name: 'YubiKey 5C',
          fingerprint: 'SHA256:xY9m2…Lp',
          algo: 'sk-ssh-ed25519@openssh.com',
          hardware: true,
        },
      ];
    case 'connect_terminal':
    case 'connect_local_terminal':
    case 'run_preconnect':
    case 'quick_ssh_connect':
      return `mock-session-${Math.random().toString(36).slice(2, 8)}`;
    case 'start_forward':
    case 'start_quick_forward':
      return {
        id: `mock-fwd-${Math.random().toString(36).slice(2, 8)}`,
        // The quick variant has no connection id — the target travels on the request.
        connectionId: (args?.connectionId as string) ?? '',
        bindHost: (args?.bindHost as string) ?? '127.0.0.1',
        localPort: (args?.localPort as number) ?? 0,
        remoteHost: (args?.remoteHost as string) ?? '',
        remotePort: (args?.remotePort as number) ?? 0,
      };
    case 'stop_forward':
      return null;
    case 'list_forwards':
      return [];
    case 'machine_exec':
    case 'machine_exec_quick': {
      // Demo detection output so the dashboard's Containers/Services cards render
      // under the dev mock. Shape matches machineProbe's parsers.
      const cmd = String(args?.command ?? '');
      if (cmd.includes(' stats ')) {
        return {
          stdout: [
            'web|0.4%|82MiB / 2GiB',
            'api|2.1%|318MiB / 2GiB',
            'worker|1.3%|204MiB / 2GiB',
            'redis|0.2%|12MiB / 2GiB',
            'migrate|0.00%|0B / 2GiB',
          ].join('\n'),
          stderr: '',
          exitStatus: 0,
        };
      }
      if (cmd.includes('systemctl show')) {
        const blk = (id: string, mem: string, ts: string) =>
          `Id=${id}\nMemoryCurrent=${mem}\nActiveEnterTimestamp=${ts}`;
        return {
          stdout: [
            blk('nginx.service', '14876672', 'Tue 2026-08-18 14:00:00 UTC'),
            blk('app.service', '195493888', 'Tue 2026-08-18 14:02:00 UTC'),
            blk('postgresql.service', '536870912', 'Mon 2026-08-11 09:00:00 UTC'),
            blk('backup.service', '[not set]', ''),
            blk('docker.service', '101457920', 'Mon 2026-08-11 09:00:00 UTC'),
          ].join('\n\n'),
          stderr: '',
          exitStatus: 0,
        };
      }
      if (cmd.includes('systemctl')) {
        return {
          stdout: [
            'nginx.service loaded active running A high performance web server',
            'app.service loaded active running Acme API',
            'postgresql.service loaded active running PostgreSQL RDBMS',
            'docker.service loaded active running Docker Application Container',
            'backup.service loaded failed failed Nightly backup',
            'ufw.service loaded inactive dead Uncomplicated firewall',
          ].join('\n'),
          stderr: '',
          exitStatus: 0,
        };
      }
      return {
        stdout: [
          '__rt__ docker',
          'web|nginx:1.27|running|0.0.0.0:80->80/tcp|3 days ago',
          'api|acme/api:2.4.1|running|8080->8080|3 days ago',
          'worker|acme/api:2.4.1|running||3 days ago',
          'redis|redis:7-alpine|running|6379->6379|8 days ago',
          'migrate|acme/api:2.4.1|exited||3 days ago',
        ].join('\n'),
        stderr: '',
        exitStatus: 0,
      };
    }
    case 'agent_probe':
    case 'agent_probe_quick':
    case 'agent_probe_local': {
      // Demo discovery output, so the manager renders under the dev mock with no host.
      //
      // The sections are built from the COMMAND rather than from a fixed order: a probe
      // names a tool by its position in the adapter list, so answering positions 0 and 1
      // blindly would label demo rows with whichever adapters happen to be enabled. The
      // command carries `__tool__ <index>` followed by `command -v <bin>`, so the pair is
      // read back out of it and each section answers for the binary it actually asked
      // about. The marker is matched loosely on purpose: the script is wrapped in
      // `sh -c '…'`, so every single quote inside it arrives as `'\''`.
      const cmd = String(args?.command ?? '');
      const demo: Record<string, string[]> = {
        claude: [
          '/home/demo/.claude/projects/-srv-acme-api/3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11.jsonl',
          '/home/demo/.claude/projects/-srv-acme-api/b7d2e4a1-90c6-4f38-8b15-3e9a0d6c2f77.jsonl',
          '/home/demo/.claude/projects/-srv-acme-web/c0a51d93-2e77-4b06-91ff-5d4c8b7e3a20.jsonl',
        ],
        codex: [
          '/home/demo/.codex/sessions/2026/11/02/rollout-2026-11-02T09-14-07-01a1a05b-31b7-7b11-b3b8-35333cf07b0b.jsonl',
        ],
        grok: [
          '/home/demo/.grok/sessions/%2Fsrv%2Facme%2Fapi/019fdcfe-08ee-7ca3-aaae-02470f138ad1/chat_history.jsonl',
        ],
      };
      const out: string[] = [];
      for (const m of cmd.matchAll(/__tool__ (\d+)[^\n]*\n\s*if command -v (\S+) /g)) {
        const [, index, bin] = m;
        out.push(`__tool__ ${index}`);
        const lines = demo[bin];
        if (!lines) {
          out.push('__missing__');
          continue;
        }
        out.push(`__version__ ${bin} 1.0.0 (demo)`);
        out.push(`__body__ 0 ${lines.length}`, ...lines);
      }
      return { stdout: out.join('\n'), stderr: '', exitStatus: 0 };
    }
    case 'connect_local_program':
      // The browser preview has no PTY, so resuming an agent on this machine returns an
      // id and nothing streams — the same shape `connect_local_terminal` already has
      // here, and the pane renders rather than throwing.
      return crypto.randomUUID();
    case 'claim_session_output':
      return '';
    case 'send_terminal_input':
    case 'resize_terminal':
    case 'disconnect_terminal':
      return null;

    // ── A LOCAL VAULT (ADR 0018), which the preview had none of ─────────────────
    //
    // Everything below is what `design/mock/` used to draw by hand. The screens are the
    // REAL components; only the answers are invented. A hand-drawn copy of a screen goes
    // stale the week somebody changes the screen, and this cannot: there is one
    // implementation and the preview is it.
    case 'local_collections':
      return localCollections;
    case 'local_machines':
      return localMachines.filter((m) => m.collectionId === (a.collectionId as string));
    case 'local_create_collection': {
      const made = {
        id: `lc-${localCollections.length + 1}`,
        name: (a.name as string) ?? 'New collection',
        color: (a.color as string) ?? null,
        createdAt: now(),
        folders: [],
        hc: null,
        labels: [],
        hasBoard: false,
      };
      localCollections.push(made);
      return made;
    }
    case 'local_update_collection': {
      const c = localCollections.find((x) => x.id === a.id);
      if (c) {
        if (typeof a.name === 'string') c.name = a.name;
        if (a.labels !== undefined) c.labels = a.labels as typeof c.labels;
      }
      return { ok: !!c };
    }
    case 'local_delete_collection':
      localCollections = localCollections.filter((c) => c.id !== a.id);
      return { ok: true };
    case 'local_create_machine': {
      const id = `lm-${localMachines.length + 1}`;
      localMachines.push({
        ...(a.record as Record<string, unknown>),
        id,
        collectionId: a.collectionId as string,
      } as (typeof localMachines)[number]);
      return { id };
    }
    case 'local_update_machine': {
      const m = localMachines.find((x) => x.id === a.item);
      if (m) Object.assign(m, a.record as Record<string, unknown>);
      return { ok: !!m };
    }
    case 'local_delete_machine':
      localMachines = localMachines.filter((m) => m.id !== a.item);
      return { ok: true };
    case 'local_machine_secret':
      return { password: 'not-a-real-password' };
    case 'local_board':
      return { text: null };
    case 'local_set_board':
      return null;

    // ── Labels and marks, the documents the pickers read ────────────────────────
    case 'labels_get':
      return { labels: instanceWords, support: 'vault' };
    case 'labels_set':
      instanceWords = (a.labels as typeof instanceWords) ?? [];
      return null;
    case 'get_marks':
    case 'user_marks_get':
      return { text: marksDoc, path: null };
    case 'set_marks':
    case 'user_marks_set':
      marksDoc = (a.text as string) ?? (a.value as string) ?? marksDoc;
      return null;

    // ── Managing an agent conversation. Answers like a command that did nothing and
    //    said so cleanly: the preview has no machine to remove a file on.
    case 'agent_manage':
    case 'agent_manage_local':
    case 'agent_manage_quick':
      return { stdout: '', stderr: '', exitStatus: 0 };

    default:
      console.warn(`[mockBackend] unhandled command: ${command}`);
      return null;
  }
}
