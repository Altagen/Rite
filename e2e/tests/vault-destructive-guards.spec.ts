import { test, expect, type Page } from '@playwright/test';

/**
 * Nothing in a vault list may erase a vault.
 *
 * The trash on a vault row used to mean two things: "forget this one" on any other
 * vault, and "erase this one's master password and contents" on the vault you were
 * in — same glyph, same position, and the guard for the destructive reading was
 * retyping the name printed two lines above it. Worse, it is silent: a reset is
 * followed by setting a new password, and the app holds that key in memory, so the
 * session carries on normally. You find out at the next unlock, when the password
 * you just chose is the only one that works and everything from before is sealed
 * with a key that no longer exists.
 *
 * These tests drive the real surfaces with the native shell faked, because that is
 * the only way to reach a vault list from a browser.
 */

const VAULTS = [
  { path: '/home/user/.local/share/rite/vault.db', label: 'Personal' }, // the current one
  { path: '/home/user/vaults/homelab.db', label: 'Home lab' },
];

async function fakeNativeShell(page: Page) {
  await page.addInitScript((vaults) => {
    const w = window as unknown as Record<string, unknown>;
    w.__RITE_TOKEN__ = 'e2e-fake-shell';
    w.__RITE_CONTEXT__ = { kind: 'local', path: vaults[0].path };
    w.__RITE_VAULTS__ = vaults;
    w.__RITE_SUGGESTED_VAULT_PATH__ = vaults[0].path;
  }, VAULTS);
}

test('the context menu offers no way to erase the vault you are in', async ({ page }) => {
  await fakeNativeShell(page);
  await page.goto('/');
  await page.getByTitle('Switch context').click();

  // Row actions are display:none until the row is hovered, which also keeps them out
  // of the accessibility tree — so each row has to be hovered before it is judged.
  const row = (label: string) =>
    page.locator('.group').filter({ hasText: label }).first();

  await row('Home lab').hover();
  // The other vault can be forgotten — a roster edit that keeps the file.
  await expect(page.getByRole('button', { name: 'Remove Home lab' })).toHaveCount(1);

  await row('Personal').hover();
  // The current one offers nothing of the sort, under any wording.
  await expect(page.getByRole('button', { name: /Remove Personal/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Reset Personal/i })).toHaveCount(0);
  await expect(page.getByTitle('Reset vault')).toHaveCount(0);
});

test('the contexts window offers no way to erase the vault you are in', async ({ page }) => {
  await fakeNativeShell(page);
  await page.goto('/');
  await page.getByTitle('Switch context').click();
  await page.getByRole('button', { name: /manage all/i }).click();
  await expect(page.getByRole('heading', { name: 'Contexts' })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Remove Home lab from the list' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /Remove Personal from the list/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Reset Personal/i })).toHaveCount(0);
});

/**
 * Resetting is still reachable — it is the way out of a forgotten password — but it
 * asks for the phrase, not for something already on the screen.
 */
test('resetting a vault still asks for the phrase, in settings', async ({ page }) => {
  await fakeNativeShell(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();

  const phrase = page.getByPlaceholder('Type DELETE ALL DATA');
  await expect(phrase).toHaveCount(1);
  const reset = page.getByRole('button', { name: /Reset vault/i }).last();
  await expect(reset).toBeDisabled();

  // The vault's own name is not the key to the door.
  await phrase.fill('Personal');
  await expect(reset).toBeDisabled();

  await phrase.fill('DELETE ALL DATA');
  await expect(reset).toBeEnabled();
});
