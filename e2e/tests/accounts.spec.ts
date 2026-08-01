import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// hash-wasm + libsodium live in the desktop package (pnpm doesn't hoist them to the repo
// root), so resolve them from there — the same bridge the e2e/*.mjs smoke checks use.
const requireFromApp = createRequire(resolve(__dirname, '../../apps/desktop/index.html'));
type Argon2id = (opts: {
  password: string;
  salt: Uint8Array;
  parallelism: number;
  iterations: number;
  memorySize: number;
  hashLength: number;
  outputType: 'hex' | 'binary';
}) => Promise<string & Uint8Array>;
const argon2id: Argon2id = requireFromApp('hash-wasm').argon2id;

/** After an accounts login, everyone lands in the shared workspace (ADR 0014). */
async function expectWorkspace(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({ timeout: 30_000 });
}

/** Open the org-admin management surface (users/teams/connections) from the header. */
async function openAdmin(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  // The admin console (rite-admin-console-split) opens on the Overview page with a left nav.
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 15_000 });
}

/** Open the admin console and switch to the Users panel (left-nav). */
async function openAdminUsers(page: Page): Promise<void> {
  await openAdmin(page);
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  await expect(page.getByText('Add a user')).toBeVisible({ timeout: 15_000 });
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
// Carol is admin-provisioned, so she starts on a temp password (must_change_password)
// and sets her own on first UI login (ADR 0010 addendum) — after which CAROL_NEW is hers.
const CAROL_TEMP = 'CarolPass123!';
const CAROL_NEW = 'CarolNew123!';

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
  await openAdminUsers(page);
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
  await openAdminUsers(page);

  // Create a user (its password is Argon2id-hashed in the browser).
  await page.locator('#new-username').fill('carol');
  await page.locator('#new-password').fill(CAROL_TEMP);
  await page.getByRole('button', { name: /add user/i }).click();

  await expect(page.getByText('carol')).toBeVisible({ timeout: 30_000 });
});

test('a terminal session is sealed to its owner (multi-user)', async ({ request }) => {
  const admin = await login(request, 'admin', ADMIN.password);
  const carol = await login(request, 'carol', CAROL_TEMP);

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
  const carol = await login(request, 'carol', CAROL_TEMP);

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

test('web member workspace: personal connections, zero-knowledge, server-execute (ADR 0014)', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill('carol');
  await page.locator('#password').fill(CAROL_TEMP);
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // First login for an admin-provisioned account (must_change_password): the app forces a
  // self-chosen password before anything else — this mints carol a FRESH keypair (ADR 0010
  // addendum), so the admin-known temp password can no longer derive her vault key.
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('A password only you know').fill(CAROL_NEW);
  await page.getByPlaceholder('Type it again').fill(CAROL_NEW);
  await page.getByRole('button', { name: /set password & continue/i }).click();

  // Now a member lands in the shared workspace (ADR 0014), not the admin panels.
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({ timeout: 30_000 });

  // Create a personal connection: no loose machines (ADR 0016), so add it into the
  // synthetic "Personal" collection (backed by the per-user vault). The browser
  // seals it with the user key (ADR 0011) and the server only ever sees ciphertext.
  await page.getByRole('button', { name: 'Add to collection' }).first().click();
  await page.getByRole('button', { name: 'New machine here' }).click();
  await expect(page.getByRole('heading', { name: 'New Connection' })).toBeVisible();
  await page.getByPlaceholder('My Server').fill('my-web-box');
  await page.getByPlaceholder('example.com or 192.168.1.1').fill('web-secret-host');
  await page.getByPlaceholder('user').fill('deployer');
  await page.getByPlaceholder('Enter password...').fill('web-secret-pw');
  await page.getByRole('button', { name: 'Save Connection' }).click();

  // It comes back decrypted in the sidebar (a full browser round-trip via the vault).
  await expect(page.getByText('my-web-box')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('deployer@web-secret-host:22')).toBeVisible();

  // Personal is now a real 1-member collection (ADR 0016 "no loose machines"): the machine
  // is a collection item, and the server stored only ciphertext. Carol has just Personal here
  // (the shared 'Prod' collection is created by a later test), so it's her only collection.
  const token = await login(request, 'carol', CAROL_NEW);
  const cols = await (await request.get(`${BASE}/api/collections`, { headers: auth(token) })).json();
  expect(cols.length).toBeGreaterThan(0);
  const stored = await (
    await request.get(`${BASE}/api/collections/${cols[0].id}/items`, { headers: auth(token) })
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

test('collections: shared zero-knowledge with roles + RBAC (ADR 0016)', async ({ request }) => {
  const sodium = requireFromApp('libsodium-wrappers');
  await sodium.ready;
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

  const adminL = await loginFull(request, 'admin', ADMIN.password);
  const carolL = await loginFull(request, 'carol', CAROL_NEW);
  const adminK = await unlockKeys(ADMIN.password, adminL.vault);
  const carolK = await unlockKeys(CAROL_NEW, carolL.vault);

  // The org directory feeds the member picker (id + username + public key).
  const dir = await (await request.get(`${BASE}/api/directory`, { headers: auth(adminL.token) })).json();
  const carol = dir.find((u: { username: string }) => u.username === 'carol');
  const adminId = dir.find((u: { username: string }) => u.username === 'admin').id;
  expect(carol.publicKey).toMatch(/^[0-9a-f]{64}$/);

  // Split-key model (ADR 0016): a metaKey (name/colour) + an itemsKey (machines), each sealed
  // to the creator. The name is encrypted with metaKey, items with itemsKey — so name access
  // and machine access can be granted independently.
  const metaKey = sodium.randombytes_buf(32) as Uint8Array;
  const itemsKey = sodium.randombytes_buf(32) as Uint8Array;
  const seal = (key: Uint8Array, pub: Uint8Array) => b64(sodium.crypto_box_seal(key, pub));
  const nameEnc = await aesGcmEncrypt(metaKey, enc({ name: 'Prod', color: '#f7768e' }));
  const created = await request.post(`${BASE}/api/collections`, {
    headers: auth(adminL.token),
    data: {
      nameEnc,
      protectedMetaKey: seal(metaKey, adminK.publicKey),
      protectedItemsKey: seal(itemsKey, adminK.publicKey),
      metaKeyGroupEnc: null,
      groupEpoch: null,
    },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();

  const itemBlob = await aesGcmEncrypt(itemsKey, enc({ name: 'web-01', host: 'coll-secret-host', user: 'deploy', port: 22 }));
  expect(
    (await request.post(`${BASE}/api/collections/${id}/items`, { headers: auth(adminL.token), data: { blob: itemBlob } })).status(),
  ).toBe(201);

  // A non-member (carol, not added yet) cannot read.
  expect((await request.get(`${BASE}/api/collections/${id}/items`, { headers: auth(carolL.token) })).status()).toBe(403);

  // Admin shares with carol as a VIEWER, sealing BOTH keys to her directory public key.
  expect(
    (await request.post(`${BASE}/api/collections/${id}/members`, {
      headers: auth(adminL.token),
      data: {
        userId: carol.id,
        role: 'viewer',
        protectedMetaKey: seal(metaKey, hexToBytes(carol.publicKey)),
        protectedItemsKey: seal(itemsKey, hexToBytes(carol.publicKey)),
      },
    })).status(),
  ).toBe(204);

  // Carol lists her collections, unwraps HER sealed keys → byte-identical, decrypts name + items.
  const mine = (await (await request.get(`${BASE}/api/collections`, { headers: auth(carolL.token) })).json()).find(
    (c: { id: string }) => c.id === id,
  );
  const carolMetaKey = sodium.crypto_box_seal_open(unb64(mine.protectedMetaKey), carolK.publicKey, carolK.privateKey);
  const carolItemsKey = sodium.crypto_box_seal_open(unb64(mine.protectedItemsKey), carolK.publicKey, carolK.privateKey);
  expect(Buffer.from(carolMetaKey).equals(Buffer.from(metaKey))).toBe(true);
  expect(Buffer.from(carolItemsKey).equals(Buffer.from(itemsKey))).toBe(true);
  expect(mine.role).toBe('viewer');
  expect(dec(await aesGcmDecrypt(carolMetaKey, mine.nameEnc)).name).toBe('Prod');
  const items = await (await request.get(`${BASE}/api/collections/${id}/items`, { headers: auth(carolL.token) })).json();
  expect(dec(await aesGcmDecrypt(carolItemsKey, items[0].blob)).host).toBe('coll-secret-host');

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
      data: { userId: carol.id, role: 'owner', protectedMetaKey: 'x', protectedItemsKey: 'x' },
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
