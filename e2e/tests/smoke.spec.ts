import { test, expect } from '@playwright/test';

/**
 * Baseline: prove the harness reaches the real backend end to end — first-run
 * setup creates the vault, unlocks it, and lands on the main screen. Everything
 * else (connections, ssh-config import, terminal multiplexing) builds on this.
 */
test('first-run setup lands on the main screen', async ({ page }) => {
  await page.goto('/');

  // First run shows the master-password setup form.
  const password = page.locator('#password');
  await expect(password).toBeVisible();

  const strong = 'Rite-E2E-Str0ng!pass';
  await password.fill(strong);
  await page.locator('#confirmPassword').fill(strong);

  // Submit enables once the password passes strength validation (a backend call).
  const submit = page.locator('button[type="submit"]');
  await expect(submit).toBeEnabled();
  await submit.click();

  // The vault is now unlocked → MainScreen. Its toolbar has a Terminal action.
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Quick SSH')).toBeVisible();
});
