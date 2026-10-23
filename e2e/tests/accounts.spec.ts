import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
// The harness's key pairs and sshd coordinates, shared with the local-vault specs.
import { SSH } from './support/localVault';
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
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/** Sign out through the profile pastille menu in the header. */
async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^AD / }).click();
  await page.getByRole('button', { name: /sign out/i }).click();
}

/** Open the org-admin management surface (users/teams/connections) from the header. */
async function openAdmin(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  // The admin console (rite-admin-console-split) opens on the Overview page with a left nav.
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 15_000 });
}

/**
 * Leave the console the way a user does.
 *
 * It used to carry a ✕, and five tests clicked it. The console now takes the same bar as
 * every other overlay page, so the way back is the nav's named first entry — scoped to the
 * overlay's own header, because the workspace's bar is still mounted behind it and every
 * header locator would match twice.
 */
async function closeAdmin(page: Page): Promise<void> {
  await page
    .locator('.fixed.inset-0.z-50 > header.m-appbar')
    .getByRole('button', { name: 'Terminals', exact: true })
    .click();
}

/** Open the admin console and switch to the Users panel (left-nav). */
async function openAdminUsers(page: Page): Promise<void> {
  await openAdmin(page);
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  await expect(page.getByText('Add a user')).toBeVisible({ timeout: 15_000 });
}

const hexToBytes = (h: string) =>
  new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));

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
  return (await request.post(`${BASE}/api/server/login`, { data: { username, authHash } })).json();
}

async function login(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<string> {
  return (await loginFull(request, username, password)).token;
}

/** Decrypt a `v1.iv.ct` AES-256-GCM value (the vault wire format) in Node. */
async function aesGcmDecrypt(keyBytes: Uint8Array, token: string): Promise<Uint8Array> {
  const [, ivB64u, ctB64u] = token.split('.');
  const b64u = (s: string) =>
    new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
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
/** What `ssh-keygen -lf e2e/.keys/e2e_plain.pub` prints: the identity the form must show. */
const KEY_FINGERPRINT = 'SHA256:Zn1iECukTpW09hzo2CB3mS7btkQCoAcng/jgosVrWh0';
const CAROL_TEMP = 'CarolPass123!';
const CAROL_NEW = 'CarolNew123!';

test.describe.configure({ mode: 'serial' });

test('first run bootstraps the admin and lands authenticated', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Create the server administrator')).toBeVisible({ timeout: 15_000 });

  // The administrator is named by convention, not by whoever opens the instance first
  // (utils/adminUsername.ts): the field shows `admin` so a newcomer knows which account
  // this is, and refuses to be edited so the one account an instance cannot be opened
  // without cannot be created under a name nobody meant to type.
  const name = page.locator('#username');
  await expect(name).toHaveValue(ADMIN.username);
  await expect(name).toHaveAttribute('readonly', '');
  await expect(page.getByText('Fixed name for the administrator account.')).toBeVisible();

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
  const loginResp = page.waitForResponse(
    (r) => r.url().endsWith('/api/server/login') && r.status() === 200,
  );
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

  // Wrong password is rejected. Sign out lives in the profile pastille's menu now
  // (ProfilePastille replaced the standalone gear + sign-out in a server session).
  await signOut(page);
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
  const users = await (
    await request.get(`${BASE}/api/admin/users`, { headers: auth(admin) })
  ).json();
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
        data: {
          userId: users.find((u: { username: string }) => u.username === 'admin').id,
          role: 'member',
        },
      })
    ).status(),
  ).toBe(204);

  // Carol sees the team in her list.
  const carolTeams = await (
    await request.get(`${BASE}/api/teams`, { headers: auth(carol) })
  ).json();
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
  await expect(page.getByRole('heading', { name: 'Set a personal password' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByPlaceholder('A password known to nobody else').fill(CAROL_NEW);
  await page.getByPlaceholder('Confirmation').fill(CAROL_NEW);
  await page.getByRole('button', { name: /set password & continue/i }).click();

  // Now a member lands in the shared workspace (ADR 0014), not the admin panels.
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Create a personal connection: no loose machines (ADR 0016), so add it into the
  // synthetic "Personal" collection (backed by the per-user vault). The browser
  // seals it with the user key (ADR 0011) and the server only ever sees ciphertext.
  await page.getByRole('button', { name: 'Add to collection' }).first().click();
  await page.getByRole('button', { name: 'New machine here' }).click();
  await expect(page.getByRole('heading', { name: 'New Connection' })).toBeVisible();
  await page.getByPlaceholder('My Server').fill('my-web-box');
  await page.getByPlaceholder('example.com or 192.168.1.1').fill('web-secret-host');
  await page.getByPlaceholder('user').fill('deployer');
  await page.getByPlaceholder('Password', { exact: true }).fill('web-secret-pw');
  // Ticked deliberately: this test's point is that a password Rite DOES keep never leaves
  // the browser in the clear, which it asserts against the stored blob below. Since ADR
  // 0024 §4 covers passwords, the box is unticked by default and an unstored password
  // would make that assertion pass on a record that holds no password at all.
  await page.getByTestId('auth-remember-password').check();
  await page.getByRole('button', { name: 'Save Connection' }).click();

  // It comes back decrypted in the sidebar (a full browser round-trip via the vault).
  await expect(page.getByText('my-web-box')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('deployer@web-secret-host:22')).toBeVisible();

  // Personal is now a real 1-member collection (ADR 0016 "no loose machines"): the machine
  // is a collection item, and the server stored only ciphertext. Carol has just Personal here
  // (the shared 'Prod' collection is created by a later test), so it's her only collection.
  const token = await login(request, 'carol', CAROL_NEW);
  const cols = await (
    await request.get(`${BASE}/api/collections`, { headers: auth(token) })
  ).json();
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
  const dir = await (
    await request.get(`${BASE}/api/directory`, { headers: auth(adminL.token) })
  ).json();
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

  const itemBlob = await aesGcmEncrypt(
    itemsKey,
    enc({ name: 'web-01', host: 'coll-secret-host', user: 'deploy', port: 22 }),
  );
  expect(
    (
      await request.post(`${BASE}/api/collections/${id}/items`, {
        headers: auth(adminL.token),
        data: { blob: itemBlob },
      })
    ).status(),
  ).toBe(201);

  // A non-member (carol, not added yet) cannot read.
  expect(
    (
      await request.get(`${BASE}/api/collections/${id}/items`, { headers: auth(carolL.token) })
    ).status(),
  ).toBe(403);

  // Admin shares with carol as a VIEWER, sealing BOTH keys to her directory public key.
  expect(
    (
      await request.post(`${BASE}/api/collections/${id}/members`, {
        headers: auth(adminL.token),
        data: {
          userId: carol.id,
          role: 'viewer',
          protectedMetaKey: seal(metaKey, hexToBytes(carol.publicKey)),
          protectedItemsKey: seal(itemsKey, hexToBytes(carol.publicKey)),
        },
      })
    ).status(),
  ).toBe(204);

  // Carol lists her collections, unwraps HER sealed keys → byte-identical, decrypts name + items.
  const mine = (
    await (await request.get(`${BASE}/api/collections`, { headers: auth(carolL.token) })).json()
  ).find((c: { id: string }) => c.id === id);
  const carolMetaKey = sodium.crypto_box_seal_open(
    unb64(mine.protectedMetaKey),
    carolK.publicKey,
    carolK.privateKey,
  );
  const carolItemsKey = sodium.crypto_box_seal_open(
    unb64(mine.protectedItemsKey),
    carolK.publicKey,
    carolK.privateKey,
  );
  expect(Buffer.from(carolMetaKey).equals(Buffer.from(metaKey))).toBe(true);
  expect(Buffer.from(carolItemsKey).equals(Buffer.from(itemsKey))).toBe(true);
  expect(mine.role).toBe('viewer');
  expect(dec(await aesGcmDecrypt(carolMetaKey, mine.nameEnc)).name).toBe('Prod');
  const items = await (
    await request.get(`${BASE}/api/collections/${id}/items`, { headers: auth(carolL.token) })
  ).json();
  expect(dec(await aesGcmDecrypt(carolItemsKey, items[0].blob)).host).toBe('coll-secret-host');

  // Zero-knowledge: the server stored only ciphertext (name + items).
  expect(mine.nameEnc).toMatch(/^v1\./);
  expect(JSON.stringify(items)).not.toContain('coll-secret-host');

  // RBAC: a viewer can neither write items…
  expect(
    (
      await request.post(`${BASE}/api/collections/${id}/items`, {
        headers: auth(carolL.token),
        data: { blob: itemBlob },
      })
    ).status(),
  ).toBe(403);
  // …nor manage membership.
  expect(
    (
      await request.post(`${BASE}/api/collections/${id}/members`, {
        headers: auth(carolL.token),
        data: { userId: carol.id, role: 'owner', protectedMetaKey: 'x', protectedItemsKey: 'x' },
      })
    ).status(),
  ).toBe(403);

  // Promote carol to editor → she can now write.
  expect(
    (
      await request.patch(`${BASE}/api/collections/${id}/members/${carol.id}`, {
        headers: auth(adminL.token),
        data: { role: 'editor' },
      })
    ).status(),
  ).toBe(204);
  expect(
    (
      await request.post(`${BASE}/api/collections/${id}/items`, {
        headers: auth(carolL.token),
        data: { blob: itemBlob },
      })
    ).status(),
  ).toBe(201);

  // The last owner (admin) can't be demoted → the ≥1-owner invariant.
  expect(
    (
      await request.patch(`${BASE}/api/collections/${id}/members/${adminId}`, {
        headers: auth(adminL.token),
        data: { role: 'editor' },
      })
    ).status(),
  ).toBe(409);
});

test('active health-check UI: Check marks an unreachable machine down (ADR 0017)', async ({
  page,
  request,
}) => {
  // Admin turns on on-demand probing for the whole server.
  const admin = await login(request, 'admin', ADMIN.password);
  expect(
    (
      await request.patch(`${BASE}/api/admin/healthcheck`, {
        headers: auth(admin),
        data: {
          passiveStatus: true,
          active: 'on-demand',
          methods: ['tcp-connect'],
          restrictUsers: [],
          minInterval: 60,
        },
      })
    ).status(),
  ).toBe(204);

  // Carol signs in (a fresh mode pull picks up the policy) and lands in the workspace.
  await page.goto('/');
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill('carol');
  await page.locator('#password').fill(CAROL_NEW);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Open her Personal collection into the main view — it holds my-web-box (an unreachable host
  // saved earlier). The governed Check button appears because active probing is on.
  await page.locator('.m-nm', { hasText: 'Personal' }).first().click();
  const check = page.getByRole('button', { name: /check/i });
  await expect(check).toBeVisible({ timeout: 15_000 });
  await check.click();

  // The server probes the machine's host (unresolvable) → the pastille resolves to "No response".
  await expect(page.locator('[title*="No response"]').first()).toBeVisible({ timeout: 20_000 });
});

// ---------------------------------------------------------------------------
// Wave-1 features on the accounts path (collections)
// ---------------------------------------------------------------------------
//
// A collection machine is ciphertext to the server, so it is opened through the
// ad-hoc ("quick") endpoints with the browser handing over the decrypted target.
// Those endpoints used to carry the target and nothing else, so a jump host set
// on such a machine was saved, displayed, then silently dropped at connect time,
// and a port forward had no endpoint to call at all. What matters here is the
// request that leaves the browser: it must carry the hops the user configured.

/** Sign carol into the workspace (her password is CAROL_NEW by this point). */
/** Sign in as the administrator, bootstrapping the instance if this is the first test. */
async function signInAdmin(page: Page): Promise<void> {
  await page.goto('/');
  if (
    await page
      .getByText('Create the server administrator')
      .isVisible()
      .catch(() => false)
  ) {
    // The name is not a field on this screen (utils/adminUsername.ts): `admin`, locked.
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /create administrator/i }).click();
  } else {
    await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
    await page.locator('#username').fill(ADMIN.username);
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
  }
  await expectWorkspace(page);
}

async function signInCarol(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill('carol');
  await page.locator('#password').fill(CAROL_NEW);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expectWorkspace(page);
}

/** Add a machine to Personal through the UI (no loose machines, ADR 0016). */
async function addMachine(
  page: Page,
  opts: {
    name: string;
    host: string;
    user: string;
    password: string;
    /** Defaults to the form's 22. Set it to reach the harness sshd on 2222. */
    port?: number;
    jump?: { name: string; user: string; host: string };
  },
): Promise<void> {
  await page.getByRole('button', { name: 'Add to collection' }).first().click();
  await page.getByRole('button', { name: 'New machine here' }).click();
  await expect(page.getByRole('heading', { name: 'New Connection' })).toBeVisible();
  await page.getByPlaceholder('My Server').fill(opts.name);
  await page.getByPlaceholder('example.com or 192.168.1.1').fill(opts.host);
  if (opts.port !== undefined)
    await page.locator('input[type="number"]').first().fill(String(opts.port));
  await page.getByPlaceholder('user').fill(opts.user);
  await page.getByPlaceholder('Password', { exact: true }).fill(opts.password);
  // Every caller of this helper wants a machine that connects, so it keeps its password.
  // Unticked is the default since ADR 0024 §4 covers passwords, and a machine that keeps
  // none asks at connect time — which is its own test, not an accident in these.
  await page.getByTestId('auth-remember-password').check();
  if (opts.jump) {
    // The picker lists every other readable machine, grouped by collection, and
    // labels each one "<name> — <user>@<host>".
    const { name, user, host } = opts.jump;
    await page.getByLabel(/Jump host/).selectOption({ label: `${name} — ${user}@${host}` });
  }
  await page.getByRole('button', { name: 'Save Connection' }).click();
  await expect(page.getByText(opts.name)).toBeVisible({ timeout: 15_000 });
}

test('a jump host on a collection machine travels with the connect request', async ({ page }) => {
  await signInCarol(page);

  await addMachine(page, {
    name: 'zk-bastion',
    host: 'bastion-secret-host',
    user: 'jumper',
    password: 'bastion-secret-pw',
  });
  await addMachine(page, {
    name: 'zk-behind-jump',
    host: 'target-secret-host',
    user: 'deployer',
    password: 'target-secret-pw',
    jump: { name: 'zk-bastion', user: 'jumper', host: 'bastion-secret-host' },
  });

  const quickSsh = page.waitForRequest(
    (r) => r.url().endsWith('/api/terminal/quick-ssh') && r.method() === 'POST',
  );
  await page.getByText('zk-behind-jump').dblclick();
  const body = (await quickSsh).postDataJSON() as {
    host: string;
    jumps: { host: string; username: string; authMethod: { type: string; password?: string } }[];
  };

  // The target as before…
  expect(body.host).toBe('target-secret-host');
  // …and the hop the server cannot resolve for itself, decrypted by the browser.
  expect(body.jumps).toHaveLength(1);
  expect(body.jumps[0].host).toBe('bastion-secret-host');
  expect(body.jumps[0].username).toBe('jumper');
  expect(body.jumps[0].authMethod.password).toBe('bastion-secret-pw');
});

test('a port forward on a collection machine carries its target and hops', async ({ page }) => {
  await signInCarol(page);

  // Single click opens the machine's dashboard; forwards are managed from there.
  await page.getByText('zk-behind-jump').first().click();
  await page.getByRole('button', { name: /manage/i }).click();
  const dialog = page.getByRole('dialog', { name: 'Port forwarding' });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Local port').fill('15999');
  await dialog.getByLabel('Remote host').fill('db.internal');
  await dialog.getByLabel('Remote port').fill('5432');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();

  const quickFwd = page.waitForRequest(
    (r) => r.url().endsWith('/api/forwards/quick') && r.method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  const body = (await quickFwd).postDataJSON() as {
    host: string;
    remoteHost: string;
    remotePort: number;
    jumps: { host: string }[];
  };

  // The vault path would send only a connection id; here the whole target travels,
  // because the server holds nothing but ciphertext for this machine.
  expect(body.host).toBe('target-secret-host');
  expect(body.remoteHost).toBe('db.internal');
  expect(body.remotePort).toBe(5432);
  expect(body.jumps[0].host).toBe('bastion-secret-host');
});

/** Open the Personal collection's Board from its row menu in the library. */
async function openPersonalBoard(page: Page): Promise<void> {
  const row = page.locator('[class*="m-nm"]', { hasText: 'Personal' }).first();
  await row.hover();
  await page.getByRole('button', { name: 'Collection menu' }).first().click();
  await page.getByRole('button', { name: /Board/ }).click();
}

test('a collection Board round-trips its cards, and the server only sees ciphertext', async ({
  page,
  request,
}) => {
  await signInCarol(page);

  // The Board hangs off the collection's ⋯ menu in the library.
  await openPersonalBoard(page);

  const board = page.getByRole('dialog', { name: 'Board' });
  await expect(board).toBeVisible({ timeout: 15_000 });
  await expect(
    board.getByText('No cards yet — add a Link, Note, Action or Live view.'),
  ).toBeVisible();

  await board.getByRole('button', { name: /Add card/ }).click();
  // Menu entries spell out what each card type is ("Link — a styled button").
  await board.getByRole('button', { name: /Link — / }).click();
  // The card form is its own overlay stacked above the board, not a child of it.
  await page.getByLabel('Title').fill('Runbook');
  await page.getByLabel('URL').fill('https://runbook.secret.example/deploy');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(board.getByText('Runbook', { exact: true })).toBeVisible();

  // Re-opening decrypts it back — the card really persisted, it isn't local state.
  await board.getByRole('button', { name: 'Done' }).click();
  await page.reload();
  await expectWorkspace(page);
  await openPersonalBoard(page);
  await expect(
    page.getByRole('dialog', { name: 'Board' }).getByText('Runbook', { exact: true }),
  ).toBeVisible({ timeout: 15_000 });

  // Zero-knowledge: the stored board is a ciphertext blob, not the URL.
  const token = await login(request, 'carol', CAROL_NEW);
  const cols = (await (
    await request.get(`${BASE}/api/collections`, { headers: auth(token) })
  ).json()) as {
    id: string;
    boardEnc?: string | null;
  }[];
  const withBoard = cols.find((c) => c.boardEnc);
  expect(withBoard, 'the board should be stored on the collection').toBeTruthy();
  expect(withBoard!.boardEnc!).toMatch(/^v1\./);
  expect(withBoard!.boardEnc!).not.toContain('runbook.secret.example');
});

/**
 * The server's half of the dashboard gate, seen from a browser (ADR 0019 §3, §6).
 *
 * In the web UI a refusal is *enforcement*, not a preference: the browser cannot open SSH,
 * this server runs the command, so `webui: false` means the cards run for nobody. What has
 * to hold here is that the client obeys a policy it pulled from the server, that it drops
 * only the two cards that execute on a host, and that it says which side refused — the
 * refusal a user cannot undo is the one worth naming.
 */
test('dashboard policy: webui:false hides the probing cards and names the server (ADR 0019)', async ({
  page,
  request,
}) => {
  const admin = await login(request, 'admin', ADMIN.password);
  const setPolicy = (webui: boolean) =>
    request.patch(`${BASE}/api/admin/dashboard-policy`, {
      headers: auth(admin),
      data: { webui, clients: true, minInterval: 30 },
    });

  const card = (name: string) => page.getByRole('heading', { name, exact: true });

  // Default (nothing configured): the machine carol already owns shows both cards.
  await signInCarol(page);
  await page.getByText('zk-behind-jump').first().click();
  await expect(card('Overview')).toBeVisible({ timeout: 30_000 });
  await expect(card('Containers')).toBeVisible();
  await expect(card('Services')).toBeVisible();

  // The admin refuses the web UI — and the open page obeys *without being reloaded*. The
  // server broadcasts `policy-updated` and the client re-pulls its mode (App.tsx), which
  // is the whole point: turning the cards off takes effect while the admin is watching,
  // not at whatever moment each user next happens to reload.
  expect((await setPolicy(false)).status()).toBe(204);
  await expect(page.getByText('Containers and services are not being checked')).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByText(
      'This server turns off container and service checks in the web UI, so they run for nobody here.',
    ),
  ).toBeVisible();
  await expect(card('Containers')).toHaveCount(0);
  await expect(card('Services')).toHaveCount(0);
  // Refusing to probe is not refusing the dashboard.
  await expect(card('Overview')).toBeVisible();
  await expect(card('Port forwarding')).toBeVisible();

  // And back, live again — so the rest of the suite sees an unrestricted server.
  expect((await setPolicy(true)).status()).toBe(204);
  await expect(card('Containers')).toBeVisible({ timeout: 30_000 });
});

/**
 * The cards refresh on their own, at the cadence the server allows (ADR 0019 §3).
 *
 * This is the only test in the suite that waits on wall-clock seconds, and it does so on
 * purpose: `minInterval` is a promise about traffic, and a promise about traffic can only
 * be checked by watching traffic. The policy asks for 1s and the client refuses to go
 * under its own 15s floor — so a second probe arriving between 15s and 25s proves both
 * halves at once: that polling happens at all, and that the server cannot talk the client
 * into hammering a host.
 */
test('the probing cards refresh on their own, never faster than the client floor', async ({
  page,
  request,
}) => {
  // Waiting out a 15s floor does not fit in the default 30s budget, and shortening the
  // floor to fit would be testing a different promise than the one we make.
  test.setTimeout(120_000);
  const admin = await login(request, 'admin', ADMIN.password);
  expect(
    (
      await request.patch(`${BASE}/api/admin/dashboard-policy`, {
        headers: auth(admin),
        data: { webui: true, clients: true, minInterval: 1 },
      })
    ).status(),
  ).toBe(204);

  await signInCarol(page);
  // A host that ANSWERS. The spec's other machines point at deliberately unresolvable
  // names (the point there is what travels in the request, not what comes back), and on
  // those every probe ends in a connect timeout — long enough to look like a refresh
  // interval and hide the absence of one.
  await addMachine(page, {
    name: 'probe-cadence',
    host: '127.0.0.1',
    port: 2222,
    user: 'riteuser',
    password: 'ritepass123',
  });

  const execs: number[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/terminal/exec-quick')) execs.push(Date.now());
  });

  await page.getByText('probe-cadence').first().click();
  await expect(page.getByRole('heading', { name: 'Containers', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  // The two cards each probe once on open, and those answer quickly.
  await expect.poll(() => execs.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  const opened = execs.length;
  const settled = execs[opened - 1];

  // …then again on their own, without anyone touching the page. The server asked for 1s;
  // the client refuses to go under its own 15s floor, so this gap proves both halves:
  // that polling happens at all, and that a server cannot talk a client into hammering
  // a host.
  await expect
    .poll(() => execs.length, { timeout: 60_000, intervals: [500] })
    .toBeGreaterThan(opened);
  const gap = execs[opened] - settled;
  expect(
    gap,
    `an automatic refresh ${gap}ms after the last one must respect the 15s floor`,
  ).toBeGreaterThanOrEqual(13_000);

  // Put the policy back for anything that runs after this.
  await request.patch(`${BASE}/api/admin/dashboard-policy`, {
    headers: auth(admin),
    data: { webui: true, clients: true, minInterval: 30 },
  });
});

/**
 * An overlay page carries the nav, and the nav is also the way back.
 *
 * Teams, Collections and the console are pages you travel between, and an overlay's bar
 * used to hold a ✕ and the identity pastille and nothing else: every hop was Close, then
 * find the button you had just left. The bar is the emptiest one in the app, so the nav
 * rides along — and its first entry, "Terminals", replaced the ✕ rather than joining it.
 * A nav of four destinations says where you are going; a Close only says "not here".
 *
 * `design/mock/full-data.js` (`overlayNavHTML`) is the same list in the prototype, and
 * `mock.spec.ts` holds it to the same rules.
 */
test('an overlay page carries the nav, which is also the way back', async ({ page }) => {
  // Wide enough that OverflowNav keeps the entries inline: this test is about what the
  // bar offers, not about when it folds into "⋯".
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  // Independent of what ran before: bootstrap on a fresh server, sign in otherwise.
  if (
    await page
      .getByText('Create the server administrator')
      .isVisible()
      .catch(() => false)
  ) {
    // The name is not a field on this screen (utils/adminUsername.ts): `admin`, locked.
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /create administrator/i }).click();
  } else {
    await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
    await page.locator('#username').fill(ADMIN.username);
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
  }
  await expectWorkspace(page);

  // The workspace's own bar has no "Terminals" entry: it would name the page you are
  // looking at. The way back exists only where there is somewhere to come back from.
  await expect(page.getByRole('button', { name: 'Terminals', exact: true })).toHaveCount(0);

  // The overlay's own bar, not the workspace's behind it.
  const bar = page.locator('.fixed.inset-0.z-50 > header.m-appbar');
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await expect(bar).toHaveCount(1);

  // The page you are on is marked, and goes nowhere. Dropping the entry instead would
  // shift the other two under the cursor on every hop.
  const here = bar.locator('[aria-current="page"]');
  await expect(here).toHaveCount(1);
  await expect(here).toHaveText(/Collections/);
  await expect(here).toHaveClass(/nav-on/);
  // Marked, and it looks it: `navigate()` already no-ops on the path you are on, so the
  // cursor is the part a reader can see.
  await expect(here).toHaveCSS('cursor', 'default');

  // One hop, no Close in between — the whole point.
  await bar.getByRole('button', { name: 'Teams', exact: true }).click();
  await expect(
    page.locator('.fixed.inset-0.z-50 > header.m-appbar [aria-current="page"]'),
  ).toHaveText(/Teams/);
  // …and the admin console is reachable from here too, by the name this shell gives it.
  await expect(bar.getByRole('button', { name: /^(Admin|Organization)$/ })).toHaveCount(1);

  // No ✕ any more: the nav's first entry IS the way back, and it is named. A Close beside
  // it would be a second answer to a question already answered.
  await expect(bar.getByRole('button', { name: /^close$/i })).toHaveCount(0);
  await bar.getByRole('button', { name: 'Terminals', exact: true }).click();
  await expect(page.locator('.fixed.inset-0.z-50 > header.m-appbar')).toHaveCount(0);
  await expectWorkspace(page);

  // Esc still closes, because a mode you open over the app should close that way.
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await expect(page.locator('.fixed.inset-0.z-50 > header.m-appbar')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.fixed.inset-0.z-50 > header.m-appbar')).toHaveCount(0);
});
/**
 * The web UI's settings say what they can, and offer nothing they cannot do.
 *
 * Three holes found by comparing the rail against the desktop's. The browser was offered a
 * switch for the **shell picker**, a toolbar button that only renders outside a server
 * context — a switch for something that cannot appear says you have a choice you do not
 * have, so that row is gone here. **Quick SSH** reads the same way at first and is not the
 * same case: the button exists, a server merely forbids it, and someone who goes looking
 * for the switch deserves to be told that rather than to find nothing — so that row stays
 * and names the policy, like the probe-cards row beside it. And the UI was told nothing at
 * all about **which shell its terminals use**, although the server sets it for everyone:
 * the answer existed only in the tooltip of the New-terminal button.
 *
 * So the Shell section exists in both shells now, and answers the question each one can
 * actually answer: the picker on a machine, the server's choice read-only here. The other
 * half of the Quick SSH pair is in `instance-config.spec.ts`, on the instance that allows it.
 */
test('the web UI is told which shell the server sets, and is not offered the local picker', async ({
  page,
}) => {
  await page.goto('/');
  if (
    await page
      .getByText('Create the server administrator')
      .isVisible()
      .catch(() => false)
  ) {
    // The name is not a field on this screen (utils/adminUsername.ts): `admin`, locked.
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /create administrator/i }).click();
  } else {
    await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
    await page.locator('#username').fill(ADMIN.username);
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
  }
  await expectWorkspace(page);

  await page.getByRole('button', { name: /^AD / }).click();
  await page.getByRole('button', { name: /^settings$/i }).click();

  // The answer, read-only, and it is the server's own value rather than a guess: the
  // same string the API reports in /api/server/mode.
  await page.getByTestId('settings-nav-shell').click();
  const mode = await (await page.request.get(`${BASE}/api/server/mode`)).json();
  await expect(page.getByTestId('server-shell')).toHaveText(mode.defaultShell ?? 'bash');
  // Precise: the host-key row says the same thing about its own policy, and both rows
  // are in the DOM at once (the rail hides the other sections rather than unmounting).
  await expect(
    page.getByText('Set by the administrator, for every terminal', { exact: false }),
  ).toBeVisible();
  // …and no picker: the choice is not this user's to make here.
  await expect(page.getByTestId('shell-choices')).toHaveCount(0);
  await expect(page.getByTestId('shell-path')).toHaveCount(0);

  // The toolbar section offers switches for buttons that exist. The shell picker is not one
  // of them in a browser, and neither is Quick SSH here: the premise is read from the server
  // rather than assumed, because the switch must follow the policy and not the default.
  await page.getByTestId('settings-nav-toolbar').click();
  await expect(page.getByTestId('toolbar-shellPicker')).toHaveCount(0);
  // Nor the other shell control: the "+" beside the tabs cannot offer a one-off shell
  // here either, for the same reason — the instance picks the shell for every terminal.
  await expect(page.getByTestId('toolbar-newTerminalMenu')).toHaveCount(0);
  // Quick SSH is the server's to forbid, and this one does. The row stays and says so: the
  // preference is still this person's, and the button is hidden either way.
  expect(mode.allowQuickSsh ?? false).toBe(false);
  const quick = page.getByTestId('toolbar-quickSsh');
  await expect(quick).toBeVisible();
  await expect(quick).toContainText('The server turns this off');
  // And the control is ours rather than the engine's. A native checkbox is drawn by
  // WebKitGTK in the desktop shell and by the browser here — the same bundle showing two
  // different switches, which is the one thing these two surfaces must never do.
  await expect(quick).toHaveAttribute('role', 'switch');
  await expect(quick.locator('input[type="checkbox"]')).toHaveCount(0);

  // Focus mode belongs to the native window, so its switch is not here.
  await expect(page.getByTestId('toolbar-focusMode')).toHaveCount(0);
  // Layouts, on the other hand, are here now: ADR 0027 gave the account a sealed copy, so
  // a browser has a workspace to read and a button to hide. It used to be absent, because
  // a server answered that there was no file and there was no substitute.
  await expect(page.getByTestId('toolbar-layouts')).toBeVisible();

  // Host-key verification is the instance's on a server: every connection runs there, so
  // the policy is reported and not offered. It used to be a dropdown writing one shared
  // row, so anyone who chose "accept" turned verification off for every account on the
  // instance — and `/api/settings` let any account write that row directly.
  await page.getByTestId('settings-nav-security').click();
  await expect(page.getByTestId('server-host-key')).toHaveText(
    mode.hostKeyVerification ?? 'strict',
  );
  await expect(page.getByTestId('host-key-mode')).toHaveCount(0);

  // And the control itself is absent, not merely its switch: "+" opens a terminal here
  // rather than asking which shell, because the answer is not this user's to give.
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Open tabs' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('tab-new-terminal')).toBeVisible();
  await expect(page.getByTestId('tab-new-terminal-chevron')).toHaveCount(0);
});

/**
 * An instance may hand the shell choice to its members, and take it back.
 *
 * Three levels, and this walks all three. The offer is a probe: the console used to list
 * bash, sh, zsh and fish whatever the machine had, and picking one it lacked pointed every
 * terminal on the instance at a program that is not there. The delegation is a switch, off
 * by default, so a server that upgrades and says nothing behaves exactly as before. And the
 * member's pick travels as a NAME the server resolves — the asserted value is what the
 * server answers it ran, not what the client believes, because the two used to differ.
 */
test('an instance can hand the shell choice to its members, and take it back', async ({ page }) => {
  await page.goto('/');
  if (
    await page
      .getByText('Create the server administrator')
      .isVisible()
      .catch(() => false)
  ) {
    // The name is not a field on this screen (utils/adminUsername.ts): `admin`, locked.
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /create administrator/i }).click();
  } else {
    await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
    await page.locator('#username').fill(ADMIN.username);
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
  }
  await expectWorkspace(page);

  const mode = await (await page.request.get(`${BASE}/api/server/mode`)).json();
  expect(
    mode.allowShellChoice ?? false,
    "the choice is the instance's until it says otherwise",
  ).toBe(false);
  // Against the filesystem rather than against the report. On a developer machine with all
  // four shells this agrees either way — the run that discriminates is the unit test in the
  // CI image, which has two. Here it catches the opposite mistake: a probe that under-reports.
  const { existsSync } = await import('node:fs');
  for (const name of ['bash', 'sh', 'zsh', 'fish']) {
    const onDisk = ['/usr/bin', '/bin', '/usr/local/bin'].some((dir) =>
      existsSync(`${dir}/${name}`),
    );
    expect(
      (mode.shells as string[]).includes(name),
      `${name} is offered iff this machine has it`,
    ).toBe(onDisk);
  }
  const other = (mode.shells as string[]).find((s) => s !== mode.defaultShell);
  expect(other, 'this machine has a second shell to pick').toBeTruthy();

  // The administrator delegates.
  await openAdmin(page);
  await page.getByRole('button', { name: 'Instance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Instance' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('instance-shell').locator('option')).toHaveText(mode.shells);
  await page.getByTestId('instance-shell-choice').click();
  await expect(page.getByTestId('instance-shell-choice')).toHaveAttribute('aria-checked', 'true');

  // The member picks — the same person here, but it is the member's surface that changes.
  // Out of the console first: it is an overlay over the workspace, so until it closes
  // both headers are on the page and every header locator matches twice. The console
  // carries the shared nav now, so the way back is its named entry, not a ✕.
  await closeAdmin(page);
  await page.reload();
  await expectWorkspace(page);
  await page.getByRole('button', { name: /^AD / }).click();
  await page.getByRole('button', { name: /^settings$/i }).click();
  await page.getByTestId('settings-nav-shell').click();
  await expect(page.getByTestId('server-shell-choices')).toBeVisible();
  await page.getByTestId(`server-shell-${other}`).click();
  await expect(page.getByTestId(`server-shell-${other}`)).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Close settings' }).click();

  // …and the server runs it. Its own answer, because the tab's label is computed here and
  // would read the same whatever ran.
  const [created] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith('/api/terminal/local') && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Terminal', exact: true }).click(),
  ]);
  expect(((await created.json()) as { shell: string }).shell).toMatch(new RegExp(`/${other}$`));

  // The instance takes it back: the picker goes, and the next terminal is the default's
  // again although this browser still remembers the pick. This half is the CLIENT's —
  // it stops offering and stops sending. What the server does with a name it is sent
  // anyway is asserted in e2e/server-authz-check.mjs, where no client can soften it.
  await openAdmin(page);
  await page.getByRole('button', { name: 'Instance', exact: true }).click();
  await page.getByTestId('instance-shell-choice').click();
  await expect(page.getByTestId('instance-shell-choice')).toHaveAttribute('aria-checked', 'false');
  await closeAdmin(page);
  await page.reload();
  await expectWorkspace(page);
  const [again] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith('/api/terminal/local') && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Terminal', exact: true }).click(),
  ]);
  expect(((await again.json()) as { shell: string }).shell).toMatch(
    new RegExp(`/${mode.defaultShell}$`),
  );
});

/**
 * A key, from a browser, all the way to a shell (ADR 0024 §1-2).
 *
 * The path a password cannot test and a desktop cannot either: `FileReader` reads the key
 * in the page, it goes into the record the browser encrypts, the server is handed the
 * material for that session and decodes it in memory. Before this, public-key
 * authentication from the web UI could not work at all — the form offered a *path*, which
 * on a server names a file in its container that no member can put there.
 *
 * Driven through the real form rather than the API, because the file input and the
 * `vaultKey` mapping are the two things under test, and both live in the page.
 */
test('a key chosen in the browser opens a real session on the server', async ({ page }) => {
  // Two admin round trips, a real SSH session, and the whole edit path through both key
  // supports. Past the default budget by design, not by slowness.
  test.setTimeout(120_000);
  await page.goto('/');
  if (
    await page
      .getByText('Create the server administrator')
      .isVisible()
      .catch(() => false)
  ) {
    // The name is not a field on this screen (utils/adminUsername.ts): `admin`, locked.
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /create administrator/i }).click();
  } else {
    await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
    await page.locator('#username').fill(ADMIN.username);
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
  }
  await expectWorkspace(page);

  // The host key is the instance's business here (ADR 0024 consequences), and this test is
  // about the key that authenticates, not about trusting the host. Set through the console
  // row rather than by an out-of-band request: a test's own `page.request` carries no
  // session, and the row is the thing an administrator actually has.
  await openAdmin(page);
  await page.getByRole('button', { name: 'Instance', exact: true }).click();
  await page.getByTestId('instance-host-key-mode').selectOption('accept');
  await expect(page.getByTestId('instance-host-key-mode')).toHaveValue('accept');
  await closeAdmin(page);
  await expectWorkspace(page);

  // A machine is always created inside a collection (ADR 0016); on a server that is
  // Personal, and its own "+" is where the form opens from.
  await page.getByRole('button', { name: 'Add to collection' }).first().click();
  await page.getByRole('button', { name: 'New machine here' }).click();
  await page.getByPlaceholder('My Server').fill('e2e-browser-key');
  await page.getByPlaceholder('example.com or 192.168.1.1').fill(SSH.hostname);
  // The port has no id of its own; it is the form's only number input.
  await page.locator('input[type="number"]').first().fill(String(SSH.port));
  await page.getByPlaceholder('user').fill(SSH.username);

  // Both supports are offered here, and the carried one is selected (ADR 0028 §1–2), so
  // the file input is what shows and the path field is not rendered at all.
  await page.getByRole('radio', { name: /public key/i }).click();
  await expect(page.getByTestId('key-support-carried')).toBeChecked();
  await expect(page.getByTestId('key-support-path')).not.toBeChecked();
  await expect(page.getByTestId('auth-key-path')).toHaveCount(0);
  await page.getByTestId('auth-key-file').setInputFiles(SSH.keyPlain);
  // The page says what it read, and says the key never leaves it as a file.
  await expect(page.getByText(/Loaded from e2e_plain/)).toBeVisible();

  await page.getByRole('button', { name: /save connection/i }).click();
  await expect(page.getByText('e2e-browser-key')).toBeVisible({ timeout: 15_000 });

  // And it opens. The shell prompt, not a connected-looking UI: a key that did not reach
  // the server, or reached it unusable, fails here with "Permission denied".
  await page.getByText('e2e-browser-key').last().dblclick();
  await expect(page.locator('.xterm-rows')).toContainText(`${SSH.username}@`, { timeout: 25_000 });

  // Reopening the machine names the key instead of showing an empty picker, which read as
  // "nothing was saved" (ADR 0028 §6). The fingerprint is the one ssh-keygen prints for
  // this fixture — computed in the page from the key's public half, never stored.
  // Scoped to the library: the open terminal's tab carries the same name, and its screen
  // swallows the click.
  await page.getByRole('complementary').getByText('e2e-browser-key').click({ button: 'right' });
  await page.getByRole('button', { name: /^edit$/i }).click();
  await expect(page.getByTestId('auth-key-stored')).toContainText(KEY_FINGERPRINT);
  await expect(page.getByTestId('auth-key-stored')).toContainText('ssh-ed25519');
  await expect(page.getByTestId('auth-key-file')).toHaveCount(0);

  // Replace puts the picker back, and only then: the control that wipes a stored key is
  // asked for rather than sitting there.
  await page.getByTestId('auth-key-replace').click();
  await expect(page.getByTestId('auth-key-file')).toBeVisible();

  // Switching support is a change in its own right: choosing the other one and saving
  // nothing must not quietly leave the machine carrying its key.
  await page.getByTestId('key-support-path').click();
  await expect(page.getByTestId('auth-key-path')).toBeVisible();
  await page.getByRole('button', { name: /save connection/i }).click();
  await expect(page.getByText('Private key path is required')).toBeVisible();
  // Escape is the deliberate way out of this form (a backdrop click keeps it), and the
  // only unambiguous one: the modal's close cross is also named Cancel.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('auth-key-path')).toHaveCount(0);

  // Put the instance's policy back for whatever runs next.
  await openAdmin(page);
  await page.getByRole('button', { name: 'Instance', exact: true }).click();
  await page.getByTestId('instance-host-key-mode').selectOption('strict');
  await expect(page.getByTestId('instance-host-key-mode')).toHaveValue('strict');
});

/**
 * A passphrase the member chose not to keep is asked for, and used (ADR 0024 §4).
 *
 * The other half of the key story, and the one with no test: ticking "remember" stores
 * the passphrase, and NOT ticking it has to mean something — the record says so
 * (`needsPassphrase`) and connecting raises a dialog whose answer serves that session and
 * is written nowhere. Both halves of that sentence are asserted here, because a dialog
 * that appears and whose answer is ignored looks identical to one that works until the
 * connection fails.
 */
test('a passphrase that was not kept is asked for at connect time', async ({ page }) => {
  await page.goto('/');
  if (
    await page
      .getByText('Create the server administrator')
      .isVisible()
      .catch(() => false)
  ) {
    // The name is not a field on this screen (utils/adminUsername.ts): `admin`, locked.
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /create administrator/i }).click();
  } else {
    await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
    await page.locator('#username').fill(ADMIN.username);
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
  }
  await expectWorkspace(page);

  await openAdmin(page);
  await page.getByRole('button', { name: 'Instance', exact: true }).click();
  await page.getByTestId('instance-host-key-mode').selectOption('accept');
  await expect(page.getByTestId('instance-host-key-mode')).toHaveValue('accept');
  await closeAdmin(page);
  await expectWorkspace(page);

  // A fresh name per run: this vault persists between runs, so a stale row from an
  // earlier attempt would satisfy the "it was saved" assertion below and the test would
  // then connect with whatever that older row holds.
  const name = `e2e-asks-${Date.now()}`;
  await page.getByRole('button', { name: 'Add to collection' }).first().click();
  await page.getByRole('button', { name: 'New machine here' }).click();
  await page.getByPlaceholder('My Server').fill(name);
  await page.getByPlaceholder('example.com or 192.168.1.1').fill(SSH.hostname);
  await page.locator('input[type="number"]').first().fill(String(SSH.port));
  await page.getByPlaceholder('user').fill(SSH.username);

  await page.getByRole('radio', { name: /public key/i }).click();
  await page.getByTestId('auth-key-file').setInputFiles(SSH.keyLocked);
  await page.getByTestId('auth-passphrase').fill(SSH.keyPassphrase);
  // Left unticked on purpose — that is what this test is about. It is also the default,
  // so this asserts the default rather than assuming it.
  await expect(page.getByTestId('auth-remember-passphrase')).not.toBeChecked();
  await page.getByRole('button', { name: /save connection/i }).click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });

  // Connecting asks, and cancelling is not a connection. Connect from the row's button:
  // a double-click opens the machine's DASHBOARD first, whose cards are themselves a
  // client-execute path — they ask too, which is the fix this test found, but it makes
  // for two prompts and this assertion is about the connection.
  const row = page.locator('.m-tnode.leaf', { hasText: name });
  await row.getByRole('button', { name: 'Connect' }).click();
  const prompt = page.getByTestId('passphrase-prompt');
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  await expect(prompt).toContainText(name);
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(page.locator('.xterm-rows')).toHaveCount(0);

  // Asking again and answering opens the session — the proof that the typed answer is
  // what authenticates, since the record holds no passphrase to fall back on.
  await row.getByRole('button', { name: 'Connect' }).click();
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('passphrase-input').fill(SSH.keyPassphrase);
  await page.getByTestId('passphrase-submit').click();
  await expect(page.locator('.xterm-rows')).toContainText(`${SSH.username}@`, { timeout: 25_000 });

  // And it is remembered for this page: the machine's dashboard runs one request per
  // card, so asking per operation would have asked four times over. Opening it now must
  // not ask again.
  await page.getByText(name).first().click();
  await expect(page.getByText('Overview').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('passphrase-prompt')).toHaveCount(0);
  // And the cards actually ran: each is an `exec-quick` of its own, which before this
  // asked nothing and failed with "The key is encrypted" in red. Asserting only that no
  // second prompt appeared would pass on that failure too — it asks nothing either.
  await expect(page.getByText('web', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Couldn't detect/)).toHaveCount(0);

  // Back to the terminals first: the machine dashboard has an "Overview" heading of its
  // own, and `openAdmin` waits for the console's.
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await openAdmin(page);
  await page.getByRole('button', { name: 'Instance', exact: true }).click();
  await page.getByTestId('instance-host-key-mode').selectOption('strict');
  await expect(page.getByTestId('instance-host-key-mode')).toHaveValue('strict');
});

/**
 * The password's half of ADR 0024 §4, and the reason the policy is worth having.
 *
 * `allow_secret_storage` governed only the key passphrase before this. An instance that
 * stopped storing passphrases while still storing SSH passwords had closed nothing if the
 * target takes a password — the server's own comment said as much — so the switch now
 * covers both, and a password left unremembered is asked for the way a passphrase is.
 *
 * Mirrors the passphrase test above deliberately, including the dashboard at the end: the
 * cards are `exec-quick` and not `connect`, which is where the passphrase prompt was
 * missing when it shipped. Asserting "no second prompt" alone would pass on a dashboard
 * whose cards simply failed, so the cards' own output is asserted too.
 */
test('a password that was not kept is asked for at connect time', async ({ page }) => {
  await page.goto('/');
  if (
    await page
      .getByText('Create the server administrator')
      .isVisible()
      .catch(() => false)
  ) {
    // The name is not a field on this screen (utils/adminUsername.ts): `admin`, locked.
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /create administrator/i }).click();
  } else {
    await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
    await page.locator('#username').fill(ADMIN.username);
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
  }
  await expectWorkspace(page);

  await openAdmin(page);
  await page.getByRole('button', { name: 'Instance', exact: true }).click();
  await page.getByTestId('instance-host-key-mode').selectOption('accept');
  await expect(page.getByTestId('instance-host-key-mode')).toHaveValue('accept');
  await closeAdmin(page);
  await expectWorkspace(page);

  // A fresh name per run: this vault persists, so a stale row would satisfy "it was
  // saved" and the test would then connect with whatever that older row holds.
  const name = `e2e-pw-asks-${Date.now()}`;
  await page.getByRole('button', { name: 'Add to collection' }).first().click();
  await page.getByRole('button', { name: 'New machine here' }).click();
  await page.getByPlaceholder('My Server').fill(name);
  await page.getByPlaceholder('example.com or 192.168.1.1').fill(SSH.hostname);
  await page.locator('input[type="number"]').first().fill(String(SSH.port));
  await page.getByPlaceholder('user').fill(SSH.username);
  await page.getByPlaceholder('Password', { exact: true }).fill(SSH.password);
  // Left unticked on purpose — that is what this test is about. It is also the default,
  // so this asserts the default rather than assuming it.
  await expect(page.getByTestId('auth-remember-password')).not.toBeChecked();
  await page.getByRole('button', { name: /save connection/i }).click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });

  // Connecting asks, and cancelling is not a connection.
  const row = page.locator('.m-tnode.leaf', { hasText: name });
  await row.getByRole('button', { name: 'Connect' }).click();
  const prompt = page.getByTestId('password-prompt');
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  await expect(prompt).toContainText(name);
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(page.locator('.xterm-rows')).toHaveCount(0);

  // Asking again and answering opens the session — the proof that the typed answer is
  // what authenticates, since the record holds no password to fall back on.
  await row.getByRole('button', { name: 'Connect' }).click();
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('password-input').fill(SSH.password);
  await page.getByTestId('password-submit').click();
  await expect(page.locator('.xterm-rows')).toContainText(`${SSH.username}@`, { timeout: 25_000 });

  // Remembered for this page, and the dashboard's cards ran on it.
  await page.getByText(name).first().click();
  await expect(page.getByText('Overview').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('password-prompt')).toHaveCount(0);
  await expect(page.getByText('web', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Couldn't detect/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await openAdmin(page);
  await page.getByRole('button', { name: 'Instance', exact: true }).click();
  await page.getByTestId('instance-host-key-mode').selectOption('strict');
  await expect(page.getByTestId('instance-host-key-mode')).toHaveValue('strict');
});

/**
 * Layouts on an account (ADR 0027), end to end in a browser.
 *
 * A server used to answer that there was no layouts file, so the web UI had no layouts at
 * all — and that was read as a property of the model rather than of the one option that
 * had been rejected. The account's copy is a blob sealed in the browser under the user's
 * own key, so what this proves is the whole chain: the editor writes, the server stores
 * something it cannot read, and a fresh sign-in gets the text back.
 *
 * It also walks the reader's switch, because the switch is where the dead end was: the
 * section it lives in used to be hidden whenever the feature was unavailable, which would
 * have hidden the way back on.
 */
test('the account holds a layouts document the server cannot read, and the reader may decline it', async ({
  page,
  request,
}) => {
  await signInAdmin(page);

  const open = async () => {
    await page.getByRole('button', { name: /^AD / }).click();
    await page.getByRole('button', { name: /^settings$/i }).click();
    await page.getByTestId('settings-nav-layouts').click();
  };
  await open();

  // On the account, not in a file: there is no path to show, because there is no file.
  await expect(page.getByTestId('settings-layouts-blocked')).toHaveCount(0);
  await expect(page.getByText('sealed under', { exact: false }).first()).toBeVisible();

  const DOC = [
    '[[preset]]',
    'name = "Journal"',
    'command = "journalctl -f"',
    '',
    '[[layout]]',
    'name = "Account morning"',
    '',
    '  [[layout.pane]]',
    '  command = "echo one"',
    '',
    '  [[layout.pane]]',
    '  command = "echo two"',
    '  split = "right"',
    '',
  ].join('\n');

  await page.getByTestId('open-layouts-settings').click();
  await page.getByTestId('layouts-file').fill(DOC);
  await page.getByTestId('layouts-save').click();
  await expect(page.getByTestId('layouts-saved')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  // The cards are the section's own, parsed from what came back rather than from the
  // textarea: `.first()` because the dialog's list says the same thing while it is open.
  await expect(page.getByText('Account morning').first()).toBeVisible();

  // What the server holds is not the document. If this ever reads as TOML, the seal broke
  // and every machine name in every member's workspace is readable by the instance.
  const token = await page.evaluate(() => sessionStorage.getItem('rite.sessionToken') ?? '');
  const stored = await (
    await request.get(`${BASE}/api/user/layouts`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  expect(stored.blob).toBeTruthy();
  expect(stored.blob).not.toContain('layout');
  expect(stored.blob).not.toContain('Journal');
  expect(stored.blob.startsWith('v1.')).toBe(true);
  expect(typeof stored.updatedAt).toBe('number');

  // Sign out and back in: the key is derived from the password again, and the document
  // comes back from the server. One kept in this tab's memory would pass everything above
  // and fail here.
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('button', { name: /^AD / }).click();
  await page.getByTestId('pastille-sign-out').click();
  await signInAdmin(page);
  await open();
  await expect(page.getByText('Account morning').first()).toBeVisible();

  // The reader declines. The cards go, the section stays — with the switch still in it.
  await page.getByTestId('layouts-enabled').click();
  await expect(page.getByTestId('settings-layouts-blocked')).toBeVisible();
  await expect(page.getByTestId('open-layouts-settings')).toHaveCount(0);
  await expect(page.getByTestId('layouts-enabled')).toBeVisible();
  // …and the toolbar switch for a button that no longer exists goes with it.
  await page.getByTestId('settings-nav-toolbar').click();
  await expect(page.getByTestId('toolbar-layouts')).toHaveCount(0);

  // Declining does not delete. Back on, the document is where it was.
  await page.getByTestId('settings-nav-layouts').click();
  await page.getByTestId('layouts-enabled').click();
  await expect(page.getByText('Account morning').first()).toBeVisible();
});

/**
 * A lying server cannot make this client derive a cheap hash of the password (ADR 0029).
 *
 * `prelogin` hands back the salt AND the Argon2 parameters, read from the account's row,
 * and the client derived with them verbatim. So a compromised server could answer
 * `mem: 8, iter: 1` and receive a value that costs nothing to brute-force back to the
 * password offline. The vault's key uses a fixed local KDF, so the blobs are not handed
 * over directly — but the password derives that key, so recovering it is recovering the
 * vault. That is the server putting itself in a position to learn a secret, which is the
 * one thing ADR 0011 says it must not be able to do.
 *
 * The hostile server is simulated here rather than argued about: the response is rewritten
 * on the wire, which is exactly what a compromised instance would send. What the test
 * insists on is that NOTHING is sent afterwards — a refusal that still posted the hash
 * would have handed over the thing being protected — and that the screen names the cause
 * instead of saying "wrong password", which would have the reader type it again.
 */
test('a server asking for a weak key derivation gets nothing', async ({ page }) => {
  await signInAdmin(page);
  await page.getByRole('button', { name: /^AD / }).click();
  await page.getByTestId('pastille-sign-out').click();
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });

  // Everything the page sends from here, so "nothing was sent" is a measurement.
  const posted: string[] = [];
  await page.route('**/api/server/**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') posted.push(new URL(request.url()).pathname);
    if (!request.url().includes('/api/server/prelogin')) return route.fallback();
    // The lie: a real response, with the derivation cost removed.
    const real = await route.fetch();
    const body = await real.json();
    await route.fulfill({
      response: real,
      json: { ...body, params: { mem: 8, iter: 1, par: 1 } },
    });
  });

  await page.locator('#username').fill(ADMIN.username);
  await page.locator('#password').fill(ADMIN.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // Named, so the reader knows not to try again here.
  await expect(page.getByText(/weaker key derivation/i)).toBeVisible({ timeout: 15_000 });
  // Still on the sign-in screen: no session, no vault key.
  await expect(page.getByText('Sign in to the server')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('rite.sessionToken'))).toBeNull();
  // And the hash never left: prelogin was asked, /login never was.
  expect(posted.filter((p) => p.endsWith('/login'))).toEqual([]);
  expect(posted.filter((p) => p.endsWith('/prelogin')).length).toBeGreaterThan(0);

  await page.unroute('**/api/server/**');
});
