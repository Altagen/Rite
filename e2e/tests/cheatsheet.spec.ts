import { test, expect } from '@playwright/test';
import { openSettings } from './support/headerBar';

/**
 * The cheatsheet reads the table the keyboard reads.
 *
 * What is worth asserting is not that a list exists. This app once promised
 * `Split vertical (Ctrl+Shift+V)` in a tooltip long after the default had moved off that
 * chord, because the label and the dispatcher were two separate opinions about the
 * keyboard. So the test that matters is the one below: **remap a command, and the
 * cheatsheet says the new chord** — which it can only do by reading the same store.
 */

const sheet = (page: import('@playwright/test').Page) =>
  page.getByTestId('shortcuts-cheatsheet');
const rows = (page: import('@playwright/test').Page) => page.getByTestId('cheatsheet-row');

async function openCheatsheet(page: import('@playwright/test').Page) {
  // `?` as the event reports it with Shift held — Shift+comma on AZERTY, Shift+/ on US,
  // both arriving as `?`. Naming the cap instead would fire on neither.
  await page.keyboard.press('Control+Shift+?');
  await expect(sheet(page)).toBeVisible();
}

/**
 * Close it, and prove it closed.
 *
 * Pressing Escape and moving on is not enough: the overlay covers the whole window, so the
 * next click lands on nothing and Playwright reports a stability timeout with no hint as to
 * why. That is how this file first failed.
 */
async function closeCheatsheet(page: import('@playwright/test').Page) {
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
}

/**
 * Open Settings → Keyboard, remap a command, and close Settings — proving each step.
 *
 * Settings closes by its own button, NOT by Escape: inside the shortcut editor Escape
 * cancels the recording, so pressing it leaves the modal open covering the whole window,
 * and the next click times out complaining about stability instead of about the modal.
 */
async function remap(page: import('@playwright/test').Page, commandId: string, chord: string) {
  await openSettings(page);
  await page.getByTestId('settings-nav-keyboard').click();
  await page.getByTestId(`shortcut-binding-${commandId}`).click();
  await page.keyboard.press(chord);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByTestId('settings-nav-keyboard')).toHaveCount(0);
}

test('the cheatsheet lists every command, chord or not', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });

  await openCheatsheet(page);
  // EVERY command, which is where this and the palette deliberately disagree: the palette
  // lists what can run now, because offering to run the impossible is a dead end. A
  // cheatsheet teaches the keyboard — `Ctrl+W` closes a pane, and that is worth knowing
  // while no pane is open.
  await expect(rows(page).filter({ hasText: 'Close pane' })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: 'Close pane' }).locator('kbd')).toHaveText('Ctrl+W');

  // And the one that ships without a chord is listed saying so, rather than left out:
  // that it exists and can be given one is the useful fact.
  const unbound = rows(page).filter({ hasText: 'Open settings' });
  await expect(unbound).toHaveCount(1);
  await expect(unbound.locator('kbd')).toHaveCount(0);
  await expect(unbound).toContainText('Unassigned');

  // It says where to change them, so the reader is also the way to the editor.
  await expect(sheet(page)).toContainText(/Settings/i);

  await closeCheatsheet(page);
});

test('a remapped command shows its NEW chord in the cheatsheet', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });

  // The shipped default first, so the change below is a change and not a coincidence.
  await openCheatsheet(page);
  await expect(
    rows(page).filter({ hasText: 'Split horizontally' }).locator('kbd'),
  ).toHaveText('Ctrl+Shift+H');
  await closeCheatsheet(page);

  // Remap it through the screen a person would use.
  await remap(page, 'pane.splitHorizontal', 'Control+Alt+J');

  // THE assertion. One table, one answer: a cheatsheet that kept its own copy would still
  // be showing Ctrl+Shift+H here, which is exactly the bug this app has already shipped
  // once in a tooltip.
  await openCheatsheet(page);
  await expect(
    rows(page).filter({ hasText: 'Split horizontally' }).locator('kbd'),
  ).toHaveText('Ctrl+Alt+J');
  await closeCheatsheet(page);

  // Put the default back, so no later test inherits a remap. Asserted, because a reset
  // that silently did nothing would leave every following spec on Ctrl+Alt+J.
  await openSettings(page);
  await page.getByTestId('settings-nav-keyboard').click();
  await page.getByTestId('shortcut-reset-pane.splitHorizontal').click();
  await expect(page.getByTestId('shortcut-binding-pane.splitHorizontal')).toHaveText(
    'Ctrl+Shift+H',
  );
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByTestId('settings-nav-keyboard')).toHaveCount(0);
});

test('the cheatsheet is reachable from the palette too, and runs nothing on a click', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });

  // It is a command like any other, so the registry lists it without being told to —
  // which is what the registry was built for.
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('palette-input').fill('keyboard shortcuts');
  const row = page.getByTestId('palette-row').filter({ hasText: 'Keyboard shortcuts' });
  await expect(row).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(sheet(page)).toBeVisible();

  // Nothing in the sheet acts: a row that ran its command on a click would make this a
  // second palette with different rules.
  await rows(page).first().click();
  await expect(sheet(page), 'still open, nothing happened').toBeVisible();

  await closeCheatsheet(page);
});
