import { test, expect } from '@playwright/test';
import { openSettings } from './support/headerBar';

/**
 * The command palette: everything runnable, found by typing.
 *
 * The ranking is a pure function and lives in `e2e/palette-filter-check.mjs`, where ties
 * and regex-shaped queries can be asserted in milliseconds. What only a real window can
 * show is the part this file holds: that the chord opens it, that what it lists is what
 * can actually run RIGHT NOW, and that Enter runs it.
 *
 * Availability is the claim worth proving. The registry holds a handler only while a
 * mounted component implements the command with `enabled` true, so a pane command with no
 * pane open is ABSENT rather than greyed out — a disabled row says "not now" without
 * saying why or what instead.
 */

async function openPalette(page: import('@playwright/test').Page) {
  await page.keyboard.press('Control+Shift+K');
  await expect(page.getByTestId('command-palette')).toBeVisible();
}

const rows = (page: import('@playwright/test').Page) => page.getByTestId('palette-row');

/**
 * Open a LOCAL terminal pane.
 *
 * Not an SSH machine, deliberately. A first SSH connection meets an unknown host key and
 * strict mode refuses it, so a spec that connects depends on some earlier spec having
 * trusted the harness — which is a test that passes on run order. A local shell needs no
 * host key and no network, and a pane is a pane as far as the registry is concerned.
 */
async function openLocalPane(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('.xterm-screen').first().click();
}

test('the palette opens on its chord and lists only what can run', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });

  await openPalette(page);
  // With no pane open, the pane commands have nobody implementing them, so they are not
  // there to be run. This is the assertion the whole registry exists for.
  await expect(rows(page).filter({ hasText: 'Close pane' })).toHaveCount(0);
  await expect(rows(page).filter({ hasText: 'Search in pane' })).toHaveCount(0);
  // What IS implemented by an always-mounted component is listed.
  await expect(rows(page).filter({ hasText: 'Open settings' })).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
});

test('a command appears once something is implementing it', async ({ page }) => {
  await page.goto('/');
  await openLocalPane(page);

  await openPalette(page);
  // The same command that was absent a moment ago, now that a pane is focused. Absence
  // and presence are the same mechanism seen twice, which is why both are asserted.
  await expect(rows(page).filter({ hasText: 'Close pane' })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: 'Search in pane' })).toHaveCount(1);

  // The chord shows beside the command, read from the same store the keyboard dispatches
  // from — so a remap moves it here and a changed default cannot leave a stale chord in a
  // second list. This app has made that mistake before.
  const close = rows(page).filter({ hasText: 'Close pane' });
  await expect(close.locator('kbd')).toHaveText('Ctrl+Shift+W');

  await page.keyboard.press('Escape');
});

test('typing filters, and Enter runs what is picked', async ({ page }) => {
  await page.goto('/');
  // One pane to start from, so the split that follows is visible as a change and not as
  // a count that happened to be right.
  const panes = page.locator('.xterm-screen');
  const before = await panes.count();
  await openLocalPane(page);
  await expect(panes).toHaveCount(before + 1);

  await openPalette(page);
  await page.getByTestId('palette-input').fill('split horizontally');
  await expect(rows(page)).toHaveCount(1);
  // The first row is pre-selected, because the chord exists to run something.
  await expect(rows(page).first()).toHaveAttribute('data-picked', 'true');

  await page.keyboard.press('Enter');
  // It closed, and the command it named actually ran — a palette that lists without
  // running is a cheatsheet.
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(panes).toHaveCount(before + 2, { timeout: 20_000 });
});

test('a query nothing matches says so, and Enter does nothing', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });

  await openPalette(page);
  await page.getByTestId('palette-input').fill('zzzz-no-such-command');
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId('palette-empty')).toBeVisible();

  // Enter on nothing must not close and must not run: a palette that falls back to the
  // first command when nothing matches would run something nobody asked for.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('command-palette')).toBeVisible();

  await page.keyboard.press('Escape');
});

test('a command with no chord is still listed, and still assignable one', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });

  // `settings.open` ships without a chord on purpose: only a handful of chords can be
  // good, and the palette finds the rest. So its row carries no kbd at all — an empty box
  // beside a row reads as a chord nobody can see.
  await openPalette(page);
  const settingsRow = rows(page).filter({ hasText: 'Open settings' });
  await expect(settingsRow).toHaveCount(1);
  await expect(settingsRow.locator('kbd')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // And the Settings screen still offers it a chord. It used to skip any command without
  // a binding, which was quietly refusing to assign one to exactly the commands that need
  // it most.
  await openSettings(page);
  await page.getByTestId('settings-nav-keyboard').click();
  await expect(page.getByTestId('shortcut-row-settings.open')).toBeVisible();
  await expect(page.getByTestId('shortcut-binding-settings.open')).toHaveText('Unassigned');
});
