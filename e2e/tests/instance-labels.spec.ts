import { test, expect } from '@playwright/test';
import { openSettings } from './support/headerBar';

/**
 * Declaring the words for every collection, DRIVEN THROUGH THE SCREEN.
 *
 * WHY THIS EXISTS AT THIS LEVEL. The routes were tested and passed while the section did
 * not work: Save stayed grey and nothing was added. A route test cannot see a disabled
 * button, a draft that never leaves null, or a field whose text is not read — so the
 * coverage was simply at the wrong altitude, and this is the altitude the bug was at.
 */
test('a word typed in Settings is declared, and survives a reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });

  await openSettings(page);
  await page.getByTestId('settings-nav-labels').click();

  const field = page.getByTestId('instance-labels-input');
  await expect(field).toBeVisible();
  const save = page.getByTestId('instance-labels-save');
  // Nothing typed yet, so there is nothing to write — a Save that wrote what is already
  // stored would be a round trip that changes nothing.
  await expect(save).toBeDisabled();

  await field.fill('pci, prod');
  // Typing is what makes a draft, and a draft is what makes Save mean something.
  await expect(save).toBeEnabled();
  await expect(page.getByTestId('instance-labels-preview')).toContainText('pci');
  await expect(page.getByTestId('instance-labels-preview')).toContainText('prod');

  await save.click();
  // Written, so the draft is gone and Save has nothing left to do.
  await expect(save).toBeDisabled();
  await expect(page.getByTestId('instance-labels-error')).toHaveCount(0);

  // AND IT IS STILL THERE AFTER A RELOAD, which is the only assertion that proves the
  // list reached its support rather than a React state that looked convincing.
  await page.reload();
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await openSettings(page);
  await page.getByTestId('settings-nav-labels').click();
  await expect(page.getByTestId('instance-labels-input')).toHaveValue('pci, prod');
});

/**
 * A VOCABULARY IS NOT A LIST ON ONE THING, and the cap is the proof.
 *
 * The shared field applied the per-thing cap of eight to every list it drew, so this
 * editor silently refused its ninth word while the hint beside Save promised two hundred.
 * The only visible sign was a warning naming a number that did not match the one above it
 * — which is how it was reported: the word simply was not added.
 *
 * Nine words, because eight would pass against the old cap.
 */
test('a vocabulary takes more words than one machine could carry', async ({ page }) => {
  const nine = ['pci', 'prod', 'staging', 'eu-west', 'us-east', 'db', 'web', 'cache', 'edge'];

  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await openSettings(page);
  await page.getByTestId('settings-nav-labels').click();

  await page.getByTestId('instance-labels-input').fill(nine.join(', '));
  // Every one of them is previewed, so none was dropped on the way in.
  const preview = page.getByTestId('instance-labels-preview');
  for (const word of nine) await expect(preview).toContainText(word);
  // And no "at most" warning, because nothing was refused.
  await expect(page.getByTestId('instance-labels-dropped')).toHaveCount(0);

  await page.getByTestId('instance-labels-save').click();
  await expect(page.getByTestId('instance-labels-error')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await openSettings(page);
  await page.getByTestId('settings-nav-labels').click();
  await expect(page.getByTestId('instance-labels-input')).toHaveValue(nine.join(', '));
});
