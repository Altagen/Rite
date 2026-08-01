import { test, expect } from '@playwright/test';

/**
 * Env-based admin bootstrap (ADR 0010): the server derived the admin's auth hash
 * itself (RITE_ADMIN_USER/PASSWORD) with Argon2id. This test logs in through the
 * browser — which derives the auth hash with hash-wasm — so a pass proves the two
 * Argon2id implementations agree (the cross-impl consistency phase 2 also needs).
 */

const ENV_ADMIN = { username: 'envadmin', password: 'EnvPass123!' };

test('an env-bootstrapped admin can log in from the browser', async ({ page }) => {
  await page.goto('/');

  // Admin already exists (created at boot) → login form, not bootstrap.
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill(ENV_ADMIN.username);
  await page.locator('#password').fill(ENV_ADMIN.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // Browser-derived Argon2 hash matches the server-derived one → the workspace.
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({ timeout: 30_000 });
});
