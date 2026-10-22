/**
 * Reaching the header's right-hand actions, wherever they moved to.
 *
 * Settings and Lock used to be two bare icon buttons in the local workspace's bar; they are
 * items in the vault pastille's menu now (the same chrome the accounts context has always
 * had). Twenty-odd call sites clicked `getByTitle('Settings')` directly, so the move broke
 * fourteen tests at once — which is the argument for these two functions rather than for
 * twenty more edits next time the corner is rearranged.
 *
 * A test should say "open the settings", not "click the gear that is third from the right".
 */

import { type Page } from '@playwright/test';

/** Open Settings from whichever pastille this context carries. */
export async function openSettings(page: Page): Promise<void> {
  const vault = page.getByTestId('vault-pastille');
  if ((await vault.count()) > 0) await vault.click();
  else await page.getByTestId('profile-pastille').click();
  await page.getByTestId('pastille-settings').click();
}

/** Lock the local vault through the menu. The keyboard does it too (`vault.lock`). */
export async function lockVault(page: Page): Promise<void> {
  await page.getByTestId('vault-pastille').click();
  await page.getByTestId('pastille-lock').click();
}

/** Unlock, or create the first vault — the primary button, not the menu. */
export async function unlockVault(page: Page): Promise<void> {
  await page.getByTestId('vault-primary-action').click();
}
