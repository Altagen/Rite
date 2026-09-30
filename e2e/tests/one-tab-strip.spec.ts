import { test, expect } from '@playwright/test';
import { createCollection, createMachine, SSH } from './support/localVault';

/**
 * One tab strip, as the mock has (`#mtabs`): terminal tabs, then the collection and
 * machine tabs, then "+".
 *
 * They used to be two. Opening a machine dashboard left the terminal strip sitting
 * above it — meaningless there, since it switches between terminals that are not on
 * screen — and it did not merely take the space: carrying `relative z-10`, the same
 * level as the dashboard overlay and later in the DOM, it painted *over* the
 * dashboard and clipped its first card.
 */

test('the machine dashboard opens under a single tab strip', async ({ page, request }) => {
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
  const collectionId = await createCollection(request, 'e2e-strip');
  await createMachine(request, collectionId, { name: 'e2e-strip-host', hostname: SSH.hostname });

  await page.goto('/');

  // A terminal tab and a machine tab, both open at once — the case with two strips.
  await page.getByText('e2e-strip-host').last().dblclick();
  await expect(page.locator('.xterm-rows')).toContainText(`${SSH.username}@`, { timeout: 20_000 });

  const machineTab = page.getByRole('button', { name: 'e2e-strip-host' }).last();
  await machineTab.click();
  await expect(page.getByText('Overview')).toBeVisible({ timeout: 20_000 });

  // Exactly one strip, and both tabs inside it. Asserting "they share a parent"
  // is not enough: with two strips the sidebar row matched the same name and
  // `closest()` came back null on both sides, so the comparison passed on nothing.
  const strip = page.getByRole('tablist', { name: 'Open tabs' });
  await expect(strip).toHaveCount(1);
  // The discriminating assertion: the machine tab is *inside* that strip. With two
  // strips it sits in the other one and this is 0. (Asserting the two tabs "share a
  // parent" is not enough — the sidebar row matches the same name, and `closest()`
  // returned null on both sides, so the comparison passed on nothing.)
  await expect(strip.getByRole('button', { name: 'e2e-strip-host' })).toHaveCount(1);
  await expect(strip.getByText('e2e-strip-host')).toHaveCount(2); // the terminal tab, and the machine tab

  // And the dashboard is not being covered by a strip that outranks it.
  await expect(page.getByText('Port forwarding')).toBeVisible();
});
