import { test, expect } from '@playwright/test';

/**
 * Context switcher (ADR 0012 phase 1): from the local vault, the roster of
 * contexts can be managed — add a remote server, see it listed. (Connecting to
 * a remote is the proxy phase; here we exercise roster + switcher.)
 */
test('add a remote server to the context roster', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Local Terminal')).toBeVisible({ timeout: 15_000 });

  // Open the switcher — the active context is the local vault.
  await page.getByRole('button', { name: /context/i }).click();
  await expect(page.getByText('Local vault')).toBeVisible();

  // Add a server (https).
  await page.getByRole('button', { name: /add server/i }).click();
  await page.getByPlaceholder('https://rite.example.com').fill('https://team.example.com');
  await page.getByPlaceholder('Label (optional)').fill('Team');
  await page.getByRole('button', { name: /^add$/i }).click();

  // It shows up in the roster.
  await expect(page.getByText('Team')).toBeVisible({ timeout: 10_000 });
});
