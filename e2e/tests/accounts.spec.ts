import { test, expect, type APIRequestContext } from '@playwright/test';
import { argon2id } from 'hash-wasm';
import { createRequire } from 'node:module';

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

  // Argon2id WASM derivation + bootstrap → the admin lands on the users panel.
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
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible({ timeout: 30_000 });

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

  // Admin lands on the users panel.
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
