import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { argon2id } from 'hash-wasm';
import { createRequire } from 'node:module';

/** After an accounts login, everyone lands in the shared workspace (ADR 0014). */
async function expectWorkspace(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Local Terminal' })).toBeVisible({ timeout: 30_000 });
}

/** Open the org-admin management surface (users/teams/connections) from the header. */
async function openAdmin(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible({ timeout: 15_000 });
}

const hexToBytes = (h: string) => new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));

const BASE = 'http://127.0.0.1:1422';

/** Log in via the API (browser-equivalent Argon2id) and return the full result. */
async function loginFull(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<{ token: string; vault: Record<string, string> }> {
  const pre = await (
    await request.post(`${BASE}/api/server/prelogin`, { data: { username } })
  ).json();
  const authHash = await argon2id({
    password,
    salt: hexToBytes(pre.salt),
    parallelism: pre.params.par,
    iterations: pre.params.iter,
    memorySize: pre.params.mem,
    hashLength: 32,
    outputType: 'hex',
  });
  return (
    await request.post(`${BASE}/api/server/login`, { data: { username, authHash } })
  ).json();
}

async function login(request: APIRequestContext, username: string, password: string): Promise<string> {
  return (await loginFull(request, username, password)).token;
}

/** Decrypt a `v1.iv.ct` AES-256-GCM value (the vault wire format) in Node. */
async function aesGcmDecrypt(keyBytes: Uint8Array, token: string): Promise<Uint8Array> {
  const [, ivB64u, ctB64u] = token.split('.');
  const b64u = (s: string) => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u(ivB64u) }, key, b64u(ctB64u));
  return new Uint8Array(pt);
}

/** Encrypt to the `v1.iv.ct` AES-256-GCM vault wire format (in Node). */
async function aesGcmEncrypt(keyBytes: Uint8Array, plaintext: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const b64u = (b: Uint8Array) =>
    Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}

/** Replicate the client key unwrap: password + vault → userKey, privateKey, publicKey. */
async function unlockKeys(password: string, vault: Record<string, string>) {
  const masterKey = await argon2id({
    password,
    salt: hexToBytes(vault.kdfMasterSalt),
    parallelism: 1,
    iterations: 2,
    memorySize: 19456,
    hashLength: 32,
    outputType: 'binary',
  });
  const userKey = await aesGcmDecrypt(masterKey, vault.protectedUserKey);
  const privateKey = await aesGcmDecrypt(userKey, vault.protectedPrivateKey);
  return { userKey, privateKey, publicKey: hexToBytes(vault.publicKey) };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Server-mode auth (ADR 0010) end to end, against a real rite-server in accounts
 * mode. The password is hashed in the browser (real Argon2id WASM) and never
 * sent; the server issues an opaque session. Runs serially: bootstrap the first
 * admin, then sign out and back in (proving prelogin salt → same auth hash).
 */

const ADMIN = { username: 'admin', password: 'AdminPass123!' };

test.describe.configure({ mode: 'serial' });

test('first run bootstraps the admin and lands authenticated', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Create the server administrator')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill(ADMIN.username);
  await page.locator('#password').fill(ADMIN.password);
  await page.getByRole('button', { name: /create administrator/i }).click();

  // Argon2id WASM derivation + bootstrap → the admin lands in the workspace, and
  // the management panels are one click away (ADR 0014 phase 3).
  await expectWorkspace(page);
  await openAdmin(page);
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible({ timeout: 30_000 });
});

test('sign out then sign back in with the same credentials', async ({ page }) => {
  await page.goto('/');

  // The admin now exists → the login form (not bootstrap).
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill(ADMIN.username);
  await page.locator('#password').fill(ADMIN.password);
  const loginResp = page.waitForResponse((r) => r.url().endsWith('/api/server/login') && r.status() === 200);
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // The login carries the per-user vault blob (ADR 0011); a successful landing
  // means the client unwrapped its user key with the password (unwrap is in the
  // login critical path — it would throw otherwise).
  const body = await (await loginResp).json();
  expect(body.vault?.protectedUserKey).toMatch(/^v1\./);
  expect(body.vault?.kdfMasterSalt).toMatch(/^[0-9a-f]+$/);
  // The per-user X25519 keypair (ADR 0013): public key hex + wrapped private key.
  expect(body.vault?.publicKey).toMatch(/^[0-9a-f]{64}$/);
  expect(body.vault?.protectedPrivateKey).toMatch(/^v1\./);
  await expectWorkspace(page);

  // Wrong password is rejected.
  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill(ADMIN.username);
  await page.locator('#password').fill('WrongPassword!');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByText('Invalid username or password')).toBeVisible({ timeout: 30_000 });
});

test('admin creates a user from the admin panel', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill(ADMIN.username);
  await page.locator('#password').fill(ADMIN.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // Admin lands in the workspace → open the admin surface → the users panel.
  await expectWorkspace(page);
  await openAdmin(page);
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible({ timeout: 30_000 });

  // Create a user (its password is Argon2id-hashed in the browser).
  await page.locator('#new-username').fill('carol');
  await page.locator('#new-password').fill('CarolPass123!');
  await page.getByRole('button', { name: /add user/i }).click();

  await expect(page.getByText('carol')).toBeVisible({ timeout: 30_000 });
});

test('a terminal session is sealed to its owner (multi-user)', async ({ request }) => {
  const admin = await login(request, 'admin', ADMIN.password);
  const carol = await login(request, 'carol', 'CarolPass123!');

  // Admin opens a local terminal → admin owns the session.
  const created = await request.post(`${BASE}/api/terminal/local`, {
    headers: { authorization: `Bearer ${admin}` },
    data: { shell: '/bin/bash' },
  });
  expect(created.ok()).toBeTruthy();
  const { sessionId } = await created.json();

  // Carol (a different user) cannot claim, drive, or even see admin's session.
  const carolClaim = await request.post(`${BASE}/api/terminal/${sessionId}/claim`, {
    headers: { authorization: `Bearer ${carol}` },
  });
  expect(carolClaim.status()).toBe(403);
  const carolInput = await request.post(`${BASE}/api/terminal/${sessionId}/input`, {
    headers: { authorization: `Bearer ${carol}` },
    data: { data: [104, 105] },
  });
  expect(carolInput.status()).toBe(403);
  const carolList = await (
    await request.get(`${BASE}/api/terminal`, { headers: { authorization: `Bearer ${carol}` } })
  ).json();
  expect(carolList).not.toContain(sessionId);

  // The owner still can.
  const adminClaim = await request.post(`${BASE}/api/terminal/${sessionId}/claim`, {
    headers: { authorization: `Bearer ${admin}` },
  });
  expect(adminClaim.status()).toBe(200);
});

test('teams RBAC: org-admin, team-admin, member, non-member (product-model)', async ({
  request,
}) => {
  const admin = await login(request, 'admin', ADMIN.password);
  const carol = await login(request, 'carol', 'CarolPass123!');

  // Carol's user id (org-admin lists users).
  const users = await (await request.get(`${BASE}/api/admin/users`, { headers: auth(admin) })).json();
  const carolId = users.find((u: { username: string }) => u.username === 'carol').id;

  // Org-admin creates a team and adds carol as a plain member.
  const eng = await (
    await request.post(`${BASE}/api/admin/teams`, { headers: auth(admin), data: { name: 'eng' } })
  ).json();
  expect(
    (
      await request.post(`${BASE}/api/teams/${eng.id}/members`, {
        headers: auth(admin),
        data: { userId: carolId, role: 'member' },
      })
    ).status(),
  ).toBe(204);

  // A plain member cannot manage membership.
  expect(
    (
      await request.post(`${BASE}/api/teams/${eng.id}/members`, {
        headers: auth(carol),
        data: { userId: carolId, role: 'admin' },
      })
    ).status(),
  ).toBe(403);

  // Org-admin promotes carol to team-admin → she can now manage her team.
  await request.post(`${BASE}/api/teams/${eng.id}/members`, {
    headers: auth(admin),
    data: { userId: carolId, role: 'admin' },
  });
  expect(
    (
      await request.post(`${BASE}/api/teams/${eng.id}/members`, {
        headers: auth(carol),
        data: { userId: users.find((u: { username: string }) => u.username === 'admin').id, role: 'member' },
      })
    ).status(),
  ).toBe(204);

  // Carol sees the team in her list.
  const carolTeams = await (await request.get(`${BASE}/api/teams`, { headers: auth(carol) })).json();
  expect(carolTeams.some((t: { name: string }) => t.name === 'eng')).toBe(true);

  // A non-member cannot view a team she's not in.
  const ops = await (
    await request.post(`${BASE}/api/admin/teams`, { headers: auth(admin), data: { name: 'ops' } })
  ).json();
  expect(
    (await request.get(`${BASE}/api/teams/${ops.id}/members`, { headers: auth(carol) })).status(),
  ).toBe(403);
});

test('team key grant: a granted member unwraps the SAME team key (ADR 0013)', async ({
  request,
}) => {
  const sodium = createRequire(__filename)('libsodium-wrappers');
  await sodium.ready;
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

  // Log in both users and unwrap their real keys (as the client does).
  const adminL = await loginFull(request, 'admin', ADMIN.password);
  const carolL = await loginFull(request, 'carol', 'CarolPass123!');
  const adminK = await unlockKeys(ADMIN.password, adminL.vault);
  const carolK = await unlockKeys('CarolPass123!', carolL.vault);
  const admin = adminL.token;

  const users = await (await request.get(`${BASE}/api/admin/users`, { headers: auth(admin) })).json();
  const id = (name: string) => users.find((u: { username: string }) => u.username === name).id;

  // Org-admin creates a team and adds carol as a member (RBAC).
  const team = await (
    await request.post(`${BASE}/api/admin/teams`, { headers: auth(admin), data: { name: 'crypto-eng' } })
  ).json();
  await request.post(`${BASE}/api/teams/${team.id}/members`, {
    headers: auth(admin),
    data: { userId: id('carol'), role: 'member' },
  });
  await request.post(`${BASE}/api/teams/${team.id}/members`, {
    headers: auth(admin),
    data: { userId: id('admin'), role: 'admin' },
  });

  // Admin generates a random team key, inits it (sealed to self), then grants it
  // to carol (sealed to carol's public key from the member list).
  const teamKey = sodium.randombytes_buf(32) as Uint8Array;
  await request.post(`${BASE}/api/teams/${team.id}/members/${id('admin')}/key`, {
    headers: auth(admin),
    data: { protectedTeamKey: b64(sodium.crypto_box_seal(teamKey, adminK.publicKey)) },
  });
  const members = await (
    await request.get(`${BASE}/api/teams/${team.id}/members`, { headers: auth(admin) })
  ).json();
  const carolPub = hexToBytes(members.find((m: { userId: string }) => m.userId === id('carol')).publicKey);
  expect(
    (
      await request.post(`${BASE}/api/teams/${team.id}/members/${id('carol')}/key`, {
        headers: auth(admin),
        data: { protectedTeamKey: b64(sodium.crypto_box_seal(teamKey, carolPub)) },
      })
    ).status(),
  ).toBe(204);

  // Carol fetches her teams, opens her sealed team key with her private key →
  // it is byte-identical to the key admin generated. Zero-knowledge sharing works.
  const carolTeams = await (await request.get(`${BASE}/api/teams`, { headers: auth(carolL.token) })).json();
  const mine = carolTeams.find((t: { id: string }) => t.id === team.id);
  const opened = sodium.crypto_box_seal_open(unb64(mine.protectedTeamKey), carolK.publicKey, carolK.privateKey);
  expect(Buffer.from(opened).equals(Buffer.from(teamKey))).toBe(true);

  // Authz: a member who is not a team-admin cannot grant keys (carol is a member).
  expect(
    (
      await request.post(`${BASE}/api/teams/${team.id}/members/${id('admin')}/key`, {
        headers: auth(carolL.token),
        data: { protectedTeamKey: 'x' },
      })
    ).status(),
  ).toBe(403);
});

test('team connections are shared zero-knowledge (ADR 0013 phase 4)', async ({ request }) => {
  const sodium = createRequire(__filename)('libsodium-wrappers');
  await sodium.ready;
  const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

  // Both users are key-holders of 'crypto-eng' (from the previous test). Unwrap
  // each one's team key from their sealed copy.
  const adminL = await loginFull(request, 'admin', ADMIN.password);
  const carolL = await loginFull(request, 'carol', 'CarolPass123!');
  const adminK = await unlockKeys(ADMIN.password, adminL.vault);
  const carolK = await unlockKeys('CarolPass123!', carolL.vault);
  const teamKeyFor = async (token: string, keys: { publicKey: Uint8Array; privateKey: Uint8Array }) => {
    const teams = await (await request.get(`${BASE}/api/teams`, { headers: auth(token) })).json();
    const t = teams.find((x: { name: string }) => x.name === 'crypto-eng');
    return sodium.crypto_box_seal_open(unb64(t.protectedTeamKey), keys.publicKey, keys.privateKey) as Uint8Array;
  };
  const adminTeamKey = await teamKeyFor(adminL.token, adminK);
  const carolTeamKey = await teamKeyFor(carolL.token, carolK);
  const teamId = (
    await (await request.get(`${BASE}/api/teams`, { headers: auth(adminL.token) })).json()
  ).find((x: { name: string }) => x.name === 'crypto-eng').id;

  // Admin adds a connection to the team, encrypted with the team key.
  const conn = {
    name: 'Prod DB',
    protocol: 'ssh',
    hostname: 'team-secret-host',
    port: 22,
    username: 'svc',
    authMethod: { type: 'password', password: 'team-shared-pw' },
    color: null,
    icon: null,
    folder: null,
    notes: null,
    sshKeepAliveOverride: null,
    sshKeepAliveInterval: null,
  };
  const blob = await aesGcmEncrypt(adminTeamKey, new TextEncoder().encode(JSON.stringify(conn)));
  const created = await request.post(`${BASE}/api/teams/${teamId}/connections`, {
    headers: auth(adminL.token),
    data: { blob },
  });
  expect(created.status()).toBe(201);

  // Carol (a fellow member) reads it and decrypts with HER team key → same plaintext.
  const list = await (
    await request.get(`${BASE}/api/teams/${teamId}/connections`, { headers: auth(carolL.token) })
  ).json();
  expect(list.length).toBeGreaterThan(0);
  const pt = await aesGcmDecrypt(carolTeamKey, list[0].blob);
  const decoded = JSON.parse(new TextDecoder().decode(pt));
  expect(decoded.hostname).toBe('team-secret-host');
  expect(decoded.authMethod.password).toBe('team-shared-pw');

  // The server stored only ciphertext — no plaintext host or password.
  expect(list[0].blob).toMatch(/^v1\./);
  const dump = JSON.stringify(list);
  expect(dump).not.toContain('team-secret-host');
  expect(dump).not.toContain('team-shared-pw');

  // A non-member (own a fresh team carol isn't in) is refused.
  const solo = await (
    await request.post(`${BASE}/api/admin/teams`, { headers: auth(adminL.token), data: { name: 'solo' } })
  ).json();
  expect(
    (await request.get(`${BASE}/api/teams/${solo.id}/connections`, { headers: auth(carolL.token) })).status(),
  ).toBe(403);
});

test('teams UI: admin creates a team, adds a member, grants the key', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill('admin');
  await page.locator('#password').fill(ADMIN.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expectWorkspace(page);
  await openAdmin(page);
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible({ timeout: 30_000 });

  // Switch to the Teams tab and create a team (the client generates a team key,
  // seals it to the admin — first key-holder — via the real sealbox crypto).
  await page.getByRole('button', { name: 'teams' }).click();
  await expect(page.getByRole('heading', { name: 'Teams' })).toBeVisible();
  await page.locator('#new-team').fill('ui-team');
  await page.getByRole('button', { name: /create team/i }).click();
  await page.getByRole('button', { name: 'ui-team' }).click();

  // Add carol as a member — she starts with no key access.
  await page.locator('#add-member').selectOption({ label: 'carol' });
  await page.getByRole('button', { name: /^add$/i }).click();
  await expect(page.getByRole('cell', { name: 'carol' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /grant key/i })).toHaveCount(1);

  // Grant carol the team key (admin unwraps its key and re-seals to carol).
  await page.getByRole('button', { name: /grant key/i }).click();
  // No member is left without a key → no grant buttons remain.
  await expect(page.getByRole('button', { name: /grant key/i })).toHaveCount(0);
});

test('web member workspace: personal + team connections, zero-knowledge, server-execute (ADR 0014)', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill('carol');
  await page.locator('#password').fill('CarolPass123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // A member lands in the shared workspace (ADR 0014), not the admin panels.
  await expect(page.getByRole('button', { name: 'Local Terminal' })).toBeVisible({ timeout: 30_000 });

  // Create a personal connection through the form: the browser seals it with the
  // user key (ADR 0011) and the server only ever sees ciphertext.
  await page.getByRole('button', { name: 'Add to library' }).click();
  await page.getByRole('button', { name: 'New machine…' }).click();
  await expect(page.getByRole('heading', { name: 'New Connection' })).toBeVisible();
  await page.getByPlaceholder('My Server').fill('my-web-box');
  await page.getByPlaceholder('example.com or 192.168.1.1').fill('web-secret-host');
  await page.getByPlaceholder('user').fill('deployer');
  await page.getByPlaceholder('Enter password...').fill('web-secret-pw');
  await page.getByRole('button', { name: 'Save Connection' }).click();

  // It comes back decrypted in the sidebar (a full browser round-trip via the vault).
  await expect(page.getByText('my-web-box')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('deployer@web-secret-host:22')).toBeVisible();

  // Team-shared connections merge into the same workspace — carol holds the
  // crypto-eng key (granted earlier), so 'Prod DB' decrypts and shows up here too.
  await expect(page.getByText('Prod DB')).toBeVisible();

  // The server stored only ciphertext for the personal connection.
  const token = await login(request, 'carol', 'CarolPass123!');
  const stored = await (
    await request.get(`${BASE}/api/vault/connections`, { headers: auth(token) })
  ).json();
  expect(stored.length).toBeGreaterThan(0);
  expect(stored[0].blob).toMatch(/^v1\./);
  const dump = JSON.stringify(stored);
  expect(dump).not.toContain('web-secret-host');
  expect(dump).not.toContain('web-secret-pw');

  // Opening the connection hands the browser-decrypted target to the server to run
  // SSH (server-execute) — the request carries the plaintext host, never stored.
  const quickSsh = page.waitForRequest(
    (r) => r.url().endsWith('/api/terminal/quick-ssh') && r.method() === 'POST',
  );
  await page.getByText('my-web-box').dblclick();
  const req = await quickSsh;
  expect((req.postDataJSON() as { host: string }).host).toBe('web-secret-host');
});

test('team connections UI: a shared connection is added and decrypted (ADR 0013 4b)', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill('admin');
  await page.locator('#password').fill(ADMIN.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expectWorkspace(page);
  await openAdmin(page);
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible({ timeout: 30_000 });

  // Connections tab → the team the admin holds a key for (from the teams UI test).
  await page.getByRole('button', { name: 'connections' }).click();
  await expect(page.getByRole('heading', { name: 'Team connections' })).toBeVisible();
  await page.getByRole('button', { name: 'ui-team' }).click();

  // Add a shared connection — the browser encrypts it with the team key.
  await page.locator('#tc-name').fill('shared-db');
  await page.locator('#tc-hostname').fill('shared-host');
  await page.locator('#tc-username').fill('svc');
  await page.locator('#tc-password').fill('sh-pw');
  await page.getByRole('button', { name: /^add$/i }).click();

  // It comes back decrypted (browser round-trip through the encrypted store).
  await expect(page.getByText('shared-db')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('svc@shared-host:22')).toBeVisible();
});

test('collections: shared zero-knowledge with roles + RBAC (ADR 0016)', async ({ request }) => {
  const sodium = createRequire(__filename)('libsodium-wrappers');
  await sodium.ready;
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

  const adminL = await loginFull(request, 'admin', ADMIN.password);
  const carolL = await loginFull(request, 'carol', 'CarolPass123!');
  const adminK = await unlockKeys(ADMIN.password, adminL.vault);
  const carolK = await unlockKeys('CarolPass123!', carolL.vault);

  // The org directory feeds the member picker (id + username + public key).
  const dir = await (await request.get(`${BASE}/api/directory`, { headers: auth(adminL.token) })).json();
  const carol = dir.find((u: { username: string }) => u.username === 'carol');
  const adminId = dir.find((u: { username: string }) => u.username === 'admin').id;
  expect(carol.publicKey).toMatch(/^[0-9a-f]{64}$/);

  // Admin creates a collection: a random collection key; the name + an item are
  // encrypted with it; the key is sealed to admin's own public key.
  const collKey = sodium.randombytes_buf(32) as Uint8Array;
  const nameEnc = await aesGcmEncrypt(collKey, enc({ name: 'Prod', color: '#f7768e' }));
  const created = await request.post(`${BASE}/api/collections`, {
    headers: auth(adminL.token),
    data: { nameEnc, protectedCollectionKey: b64(sodium.crypto_box_seal(collKey, adminK.publicKey)) },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();

  const itemBlob = await aesGcmEncrypt(collKey, enc({ name: 'web-01', host: 'coll-secret-host', user: 'deploy', port: 22 }));
  expect(
    (await request.post(`${BASE}/api/collections/${id}/items`, { headers: auth(adminL.token), data: { blob: itemBlob } })).status(),
  ).toBe(201);

  // A non-member (carol, not added yet) cannot read.
  expect((await request.get(`${BASE}/api/collections/${id}/items`, { headers: auth(carolL.token) })).status()).toBe(403);

  // Admin shares with carol as a VIEWER, sealing the key to her directory public key.
  expect(
    (await request.post(`${BASE}/api/collections/${id}/members`, {
      headers: auth(adminL.token),
      data: { userId: carol.id, role: 'viewer', protectedCollectionKey: b64(sodium.crypto_box_seal(collKey, hexToBytes(carol.publicKey))) },
    })).status(),
  ).toBe(204);

  // Carol lists her collections, unwraps HER sealed key → byte-identical, decrypts.
  const mine = (await (await request.get(`${BASE}/api/collections`, { headers: auth(carolL.token) })).json()).find(
    (c: { id: string }) => c.id === id,
  );
  const carolCollKey = sodium.crypto_box_seal_open(unb64(mine.protectedCollectionKey), carolK.publicKey, carolK.privateKey);
  expect(Buffer.from(carolCollKey).equals(Buffer.from(collKey))).toBe(true);
  expect(mine.role).toBe('viewer');
  expect(dec(await aesGcmDecrypt(carolCollKey, mine.nameEnc)).name).toBe('Prod');
  const items = await (await request.get(`${BASE}/api/collections/${id}/items`, { headers: auth(carolL.token) })).json();
  expect(dec(await aesGcmDecrypt(carolCollKey, items[0].blob)).host).toBe('coll-secret-host');

  // Zero-knowledge: the server stored only ciphertext (name + items).
  expect(mine.nameEnc).toMatch(/^v1\./);
  expect(JSON.stringify(items)).not.toContain('coll-secret-host');

  // RBAC: a viewer can neither write items…
  expect(
    (await request.post(`${BASE}/api/collections/${id}/items`, { headers: auth(carolL.token), data: { blob: itemBlob } })).status(),
  ).toBe(403);
  // …nor manage membership.
  expect(
    (await request.post(`${BASE}/api/collections/${id}/members`, {
      headers: auth(carolL.token),
      data: { userId: carol.id, role: 'owner', protectedCollectionKey: 'x' },
    })).status(),
  ).toBe(403);

  // Promote carol to editor → she can now write.
  expect(
    (await request.patch(`${BASE}/api/collections/${id}/members/${carol.id}`, { headers: auth(adminL.token), data: { role: 'editor' } })).status(),
  ).toBe(204);
  expect(
    (await request.post(`${BASE}/api/collections/${id}/items`, { headers: auth(carolL.token), data: { blob: itemBlob } })).status(),
  ).toBe(201);

  // The last owner (admin) can't be demoted → the ≥1-owner invariant.
  expect(
    (await request.patch(`${BASE}/api/collections/${id}/members/${adminId}`, { headers: auth(adminL.token), data: { role: 'editor' } })).status(),
  ).toBe(409);
});
