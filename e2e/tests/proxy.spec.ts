import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// hash-wasm lives in the desktop package (pnpm doesn't hoist it to the repo root), so
// resolve it from there — the same bridge the e2e/*.mjs smoke checks use.
const requireFromApp = createRequire(resolve(__dirname, '../../apps/desktop/index.html'));
const argon2id: (opts: {
  password: string;
  salt: Uint8Array;
  parallelism: number;
  iterations: number;
  memorySize: number;
  hashLength: number;
  outputType: 'hex' | 'binary';
}) => Promise<string & Uint8Array> = requireFromApp('hash-wasm').argon2id;

const hexToBytes = (h: string) =>
  new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));

const REMOTE = 'http://127.0.0.1:1423';

/** A session token straight from the remote, bypassing the mux. */
async function remoteToken(request: import('@playwright/test').APIRequestContext) {
  const pre = await (
    await request.post(`${REMOTE}/api/server/prelogin`, { data: { username: 'envadmin' } })
  ).json();
  const authHash = await argon2id({
    password: 'EnvPass123!',
    salt: hexToBytes(pre.salt),
    parallelism: pre.params.par,
    iterations: pre.params.iter,
    memorySize: pre.params.mem,
    hashLength: 32,
    outputType: 'hex',
  });
  const login = await (
    await request.post(`${REMOTE}/api/server/login`, { data: { username: 'envadmin', authHash } })
  ).json();
  return login.token as string;
}

/**
 * Context multiplexer proxy (ADR 0012 phase 2/3). The local server (:1424) adds
 * the remote accounts server (:1423) to its roster, switches to it, and logs in —
 * the whole /api flow is reverse-proxied to the remote (§2), the remote token
 * stays server-side, and remote terminals stream over the proxied WebSocket (§3).
 */

test.describe.configure({ mode: 'serial' });

test('connect to a remote server through the local proxy', async ({ page }) => {
  await page.goto('/');

  // The multiplexer's own local vault: first-run setup.
  const password = page.locator('#password');
  await expect(password).toBeVisible({ timeout: 15_000 });
  const strong = 'Local-Mux-Str0ng!pass';
  await password.fill(strong);
  await page.locator('#confirmPassword').fill(strong);
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Add the remote to the roster and switch to it. The context hub is native-only
  // (the browser has no shell), so drive the mux's roster/active endpoints directly,
  // then reload — the local server reboots proxied to the remote.
  await page.evaluate(async () => {
    const post = (path: string, body: unknown) =>
      fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const s = await (
      await post('/api/context/servers', { url: 'http://127.0.0.1:1423', label: 'TeamServer' })
    ).json();
    await post('/api/context/active', { server: s.id });
  });
  await page.reload();

  // Now proxied to :1423 → the remote's login (env-bootstrapped admin exists).
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 20_000 });
  await page.locator('#username').fill('envadmin');
  await page.locator('#password').fill('EnvPass123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // The proxied login lands in the remote's workspace — served through the proxy.
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({
    timeout: 30_000,
  });
});

/**
 * A local terminal is the CLIENT's, even when a remote context is active (ADR 0031).
 *
 * This route used to be proxied, so pressing Terminal here opened a shell inside the
 * instance. The rule keyed on the context and never on what the client is — and a browser
 * is the only client with no machine of its own, so the desktop inherited a reading that
 * was only ever true for the web UI.
 *
 * Asserted through the one route that still goes to the instance: `GET /api/terminal` is
 * the instance's roster, proxied. A shell this client opened must therefore be ABSENT from
 * it. Before this change the create was proxied, the session lived on the remote, and the
 * same roster listed it — so the assertion inverts exactly where the behaviour changed.
 */
test('a local terminal in a remote context is served by the client', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill('envadmin');
  await page.locator('#password').fill('EnvPass123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const owned = await page.evaluate(async () => {
    const cr = await fetch('/api/terminal/local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shell: '/usr/bin/bash' }),
    });
    if (!cr.ok) return `create-${cr.status}`;
    const { sessionId } = (await cr.json()) as { sessionId: string };

    // The instance's roster, proxied. Our shell must not be in it.
    const theirs = (await (await fetch('/api/terminal')).json()) as string[];
    return theirs.includes(sessionId) ? 'the instance holds it' : 'ours';
  });

  expect(owned, 'the shell a desktop client asked for runs on that client').toBe('ours');
});

test('a remote terminal streams over the WebSocket proxy', async ({ page, request }) => {
  // The context is already remote (an earlier test switched it); sign in again.
  await page.goto('/');
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill('envadmin');
  await page.locator('#password').fill('EnvPass123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // The session is created DIRECTLY on the remote, with the remote's own token, because
  // nothing the desktop asks for lands there any more (ADR 0031). That is what makes this
  // a test of the bridge: the session is unambiguously the instance's, so the only path its
  // bytes can take to this page is the proxy. It used to ride on `/api/terminal/local`
  // being proxied, which proved the bridge only as long as that was true.
  const token = await remoteToken(request);
  const created = await (
    await request.post(`${REMOTE}/api/terminal/local`, {
      data: { shell: '/usr/bin/bash' },
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  const remoteSessionId = created.sessionId as string;
  expect(remoteSessionId, 'the remote opened a session of its own').toBeTruthy();

  // Drive it through the mux and listen on the proxied /ws — all same-origin to :1424,
  // which bridges to :1423's /ws. The control requests are proxied because this session
  // is not one we hold.
  const result = await page.evaluate(async (sessionId: string) => {
    const post = (path: string, body?: unknown) =>
      fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });

    const ws = new WebSocket(`ws://${location.host}/ws`);
    const got = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 15_000);
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data as string);
          if (m.event === 'terminal-data' && m.payload?.sessionId === sessionId) {
            clearTimeout(timer);
            resolve('got-terminal-data');
          }
        } catch {
          /* ignore */
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve('ws-error');
      };
    });

    await new Promise((r) => (ws.onopen = () => r(null)));
    // Give the proxy time to connect + subscribe to the remote's /ws.
    await new Promise((r) => setTimeout(r, 1000));
    await post(`/api/terminal/${sessionId}/claim`); // drain buffer → stream mode
    await post(`/api/terminal/${sessionId}/input`, {
      data: Array.from(new TextEncoder().encode('echo RITE_WS_PROXY\n')),
    });
    return got;
  }, remoteSessionId);

  expect(result).toBe('got-terminal-data');
});

test('vault connections are stored zero-knowledge on the remote (ADR 0011)', async ({
  page,
  request,
}) => {
  // Sign in through the mux; the client unwraps its vault key and hands it to the
  // local server (syncLocalVault), so the mux can encrypt/decrypt connections.
  await page.goto('/');
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill('envadmin');
  await page.locator('#password').fill('EnvPass123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Create a connection with a distinctive host through the mux (:1424). The mux
  // encrypts it with the held key and stores an opaque blob on the remote.
  const created = await page.evaluate(async () => {
    const r = await fetch('/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'ZK box',
        protocol: 'ssh',
        hostname: 'zk-secret-host',
        port: 22,
        username: 'bob',
        authMethod: { type: 'password', password: 's3cr3t-zk-pw' },
        color: null,
        icon: null,
        folder: null,
        notes: null,
        sshKeepAliveOverride: null,
        sshKeepAliveInterval: null,
      }),
    });
    return { status: r.status, body: await r.json() };
  });
  expect(created.status).toBe(200);
  expect(created.body.hostname).toBe('zk-secret-host');

  // Reading back through the mux decrypts it — the host round-trips.
  const list = await page.evaluate(async () => (await fetch('/api/connections')).json());
  expect(list.some((c: { hostname: string }) => c.hostname === 'zk-secret-host')).toBe(true);

  // Now look at what the REMOTE actually stored: log in directly to :1423 and read
  // its per-user vault store. The blob must be ciphertext — no plaintext host or
  // password anywhere. This is the zero-knowledge guarantee.
  const REMOTE = 'http://127.0.0.1:1423';
  const pre = await (
    await request.post(`${REMOTE}/api/server/prelogin`, { data: { username: 'envadmin' } })
  ).json();
  const authHash = await argon2id({
    password: 'EnvPass123!',
    salt: hexToBytes(pre.salt),
    parallelism: pre.params.par,
    iterations: pre.params.iter,
    memorySize: pre.params.mem,
    hashLength: 32,
    outputType: 'hex',
  });
  const login = await (
    await request.post(`${REMOTE}/api/server/login`, { data: { username: 'envadmin', authHash } })
  ).json();
  const blobs = await (
    await request.get(`${REMOTE}/api/vault/connections`, {
      headers: { authorization: `Bearer ${login.token}` },
    })
  ).json();

  expect(blobs.length).toBeGreaterThan(0);
  for (const row of blobs) {
    expect(row.blob).toMatch(/^v1\./); // versioned AES-256-GCM envelope
  }
  const dump = JSON.stringify(blobs);
  expect(dump).not.toContain('zk-secret-host'); // host is encrypted
  expect(dump).not.toContain('s3cr3t-zk-pw'); // password is encrypted
});

test('client-execute: a saved connection opens SSH locally and streams over the mux /ws', async ({
  page,
}) => {
  // Sign in through the mux (unlocks the vault). The connection is encrypted, so
  // the remote cannot open SSH — the only way this works is client-execute: the
  // local server decrypts the creds and opens SSH from its own network position.
  await page.goto('/');
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill('envadmin');
  await page.locator('#password').fill('EnvPass123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const output = await page.evaluate(async () => {
    const post = (path: string, body?: unknown) =>
      fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });

    // Save an encrypted connection to the harness sshd (127.0.0.1:2222).
    const cr = await post('/api/connections', {
      name: 'CE box',
      protocol: 'ssh',
      hostname: '127.0.0.1',
      port: 2222,
      username: 'riteuser',
      authMethod: { type: 'password', password: 'ritepass123' },
      color: null,
      icon: null,
      folder: null,
      notes: null,
      sshKeepAliveOverride: null,
      sshKeepAliveInterval: null,
    });
    if (!cr.ok) return `create-conn-${cr.status}`;
    const conn = (await cr.json()) as { id: string };

    // Open it — client-execute: SSH runs on the local (mux) server.
    const sr = await post('/api/terminal/ssh', { connectionId: conn.id });
    if (!sr.ok) return `ssh-${sr.status}`;
    const { sessionId } = (await sr.json()) as { sessionId: string };

    const ws = new WebSocket(`ws://${location.host}/ws`);
    const seen = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 25_000);
      let buf = '';
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data as string);
          if (m.event === 'terminal-data' && m.payload?.sessionId === sessionId) {
            buf += atob(m.payload.data as string);
            if (buf.includes('RITE_CLIENT_EXEC_OK')) {
              clearTimeout(timer);
              resolve('marker-seen');
            }
          }
        } catch {
          /* ignore */
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve('ws-error');
      };
    });

    await new Promise((r) => (ws.onopen = () => r(null)));
    await new Promise((r) => setTimeout(r, 2000)); // let SSH connect + the proxy subscribe
    await post(`/api/terminal/${sessionId}/claim`);
    await post(`/api/terminal/${sessionId}/input`, {
      data: Array.from(new TextEncoder().encode('echo RITE_CLIENT_EXEC_OK\n')),
    });
    return seen;
  });

  expect(output).toBe('marker-seen');
});

/**
 * An attached client honours `clients: false` — and this is the half that is *policy*,
 * not enforcement (ADR 0019 §6).
 *
 * The distinction only exists here. A desktop client holds the decrypted host and its own
 * network path: `terminal_stays_local` routes its exec to its OWN local server, so the
 * remote never sees the request and could not refuse it if it wanted to. What the official
 * client does is obey: it hides the two cards and says who refused. A modified client
 * could ignore that, exactly as ADR 0017 says of active health-checks — which is why the
 * admin copy sells this as stopped traffic and a recorded intent, not as prevention.
 *
 * So the assertion is about the client's behaviour, and the proof that it is policy is
 * that no request leaves at all: there is nothing for the remote to have refused.
 */
test('an attached client obeys clients:false, and it is the client that obeys (ADR 0019)', async ({
  page,
}) => {
  // The gate asks which shell this is, and the answer picks which half of the policy
  // applies. In a browser-driven test that answer has to be injected — the launch token
  // is what the native shell puts there (ADR 0009/0014).
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__RITE_TOKEN__ = 'e2e-attached-client';
  });

  await page.goto('/');
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill('envadmin');
  await page.locator('#password').fill('EnvPass123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // The remote admin refuses attached clients. Sent through the mux, as this client's
  // own admin console would: /api is reverse-proxied to the remote, which holds the policy.
  const set = async (clients: boolean) =>
    page.evaluate(
      (allow) =>
        fetch('/api/admin/dashboard-policy', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ webui: true, clients: allow, minInterval: 30 }),
        }).then((r) => r.status),
      clients,
    );
  expect(await set(false)).toBe(204);

  // A machine on the harness sshd, saved through the mux (encrypted on the remote).
  const created = await page.evaluate(async () => {
    const r = await fetch('/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'policy-client-box',
        protocol: 'ssh',
        hostname: '127.0.0.1',
        port: 2222,
        username: 'riteuser',
        authMethod: { type: 'password', password: 'ritepass123' },
        color: null,
        icon: null,
        folder: null,
        notes: null,
        sshKeepAliveOverride: null,
        sshKeepAliveInterval: null,
      }),
    });
    return r.status;
  });
  expect(created, 'the machine should be saved on the remote').toBeLessThan(300);

  const execs: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/terminal/exec')) execs.push(r.url());
  });

  await page.reload();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByText('policy-client-box').first().click();

  // The dashboard opens, minus the two cards that would have run something.
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('Containers and services are not being checked')).toBeVisible();
  await expect(
    page.getByText('This server turns off container and service checks for this client.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Containers', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Services', exact: true })).toHaveCount(0);
  // Port forwarding is untouched: refusing to probe is not refusing the dashboard.
  await expect(page.getByRole('heading', { name: 'Port forwarding', exact: true })).toBeVisible();

  // And nothing was asked of anyone — the client simply did not send it. That is what
  // "policy, not enforcement" means in practice.
  expect(execs, 'an obeying client sends no probe at all').toEqual([]);

  // Allowed again: the same client probes, from its own network position.
  expect(await set(true)).toBe(204);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByText('policy-client-box').first().click();
  await expect(page.getByRole('heading', { name: 'Containers', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  // Polled, not snapshotted: the card renders and *then* probes, so the heading being
  // visible does not mean the request has left yet. Asserting on the array right here
  // reads an empty list whenever the machine is a few milliseconds slow — which is
  // what it did, twice, on an otherwise green gate.
  await expect
    .poll(() => execs.length, { message: 'and now it does send one', timeout: 15_000 })
    .toBeGreaterThan(0);
});
