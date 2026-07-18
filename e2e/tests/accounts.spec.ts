import { test, expect } from '@playwright/test';
import { argon2id } from 'hash-wasm';

const hexToBytes = (h: string) => new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));

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
  const BASE = 'http://127.0.0.1:1422';
  const login = async (username: string, password: string) => {
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
    const res = await (
      await request.post(`${BASE}/api/server/login`, { data: { username, authHash } })
    ).json();
    return res.token as string;
  };

  const admin = await login('admin', ADMIN.password);
  const carol = await login('carol', 'CarolPass123!');

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
