import { test, expect } from '@playwright/test';

/**
 * The password you set is the password that opens the vault.
 *
 * Everything else in a vault is worthless if this breaks, and it breaks quietly:
 * after setup the app holds the derived key in memory, so the session carries on
 * normally and nothing is verified again until the next unlock — by which time
 * the only evidence left is a rejection.
 *
 * The suite had no test for it. `smoke.spec.ts` sets a password and stops there;
 * every other spec inherits the unlocked vault. A password that stored wrong, or
 * an unlock screen that sent something subtly different from what the setup
 * screen sent, would have sailed through all of it.
 *
 * So: type it into the real form, lock, type the same characters into the real
 * unlock form, and require the vault to open. Locking is what makes this honest —
 * it drops the in-memory key, so the verification is the same one a restart does.
 */

/** Characters a French keyboard produces without trying: accents, and the symbols
 *  a strength meter pushes people towards. If any layer re-encodes the password
 *  between the field and Argon2, this is where it shows. */
const TRICKY = 'Été-Châlet#2026!vôtre';

test('a password set in the UI unlocks the vault again', async ({ page, request }) => {
  await page.goto('/');

  // The suite's vault is already set up, so change the password through the UI the
  // way a user would, then lock and come back with the same keystrokes.
  await page.getByRole('button', { name: 'Settings' }).click();

  const current = page.getByPlaceholder('Current password');
  await expect(current).toBeVisible();
  await current.fill('Rite-E2E-Str0ng!pass');
  await page.getByPlaceholder('New password', { exact: true }).fill(TRICKY);
  await page.getByPlaceholder('Confirm new password').fill(TRICKY);
  await page.getByRole('button', { name: /change password/i }).click();
  await expect(page.getByText(/password changed/i)).toBeVisible({ timeout: 15_000 });

  // Lock: the in-memory key goes, so what follows is a real verification.
  await request.post('/api/auth/lock');
  await page.reload();

  // A locked vault does not take the screen over — base-first, the terminal still
  // works and the header offers Unlock. That is where the password prompt lives.
  await page.getByRole('button', { name: 'Unlock' }).click();
  const field = page.locator('#password');
  await expect(field).toBeVisible({ timeout: 15_000 });
  await field.fill(TRICKY);
  await page.locator('button[type="submit"]').click();

  // The vault opens. Not "an error is shown" — opens.
  await expect(page.getByPlaceholder('Search connections…')).toBeVisible({ timeout: 15_000 });

  // Put the suite's password back so the specs that follow are unaffected.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByPlaceholder('Current password').fill(TRICKY);
  await page.getByPlaceholder('New password', { exact: true }).fill('Rite-E2E-Str0ng!pass');
  await page.getByPlaceholder('Confirm new password').fill('Rite-E2E-Str0ng!pass');
  await page.getByRole('button', { name: /change password/i }).click();
  await expect(page.getByText(/password changed/i)).toBeVisible({ timeout: 15_000 });
});
