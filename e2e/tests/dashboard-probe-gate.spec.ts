import { test, expect, type Page } from '@playwright/test';
import { ensureCollection, createMachine } from './support/localVault';

/**
 * The user's half of the dashboard gate (ADR 0019 §4).
 *
 * In a local vault there is no server to consult: it is the user's vault, their network,
 * their machines, so their own setting is the whole answer. What has to hold is that the
 * switch really removes the two cards that reach out to a host — and only those two. A
 * dashboard that lost its address or its port forwards along the way would be refusing the
 * feature, not refusing to probe.
 *
 * The gap also has to explain itself. A panel that goes blank for no stated reason reads as
 * a broken one, which is how it gets reported instead of understood.
 */

const card = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });

async function openDashboard(page: Page, machine: string) {
  await page.goto('/');
  await page.getByText(machine).click();
  await expect(card(page, 'Overview')).toBeVisible({ timeout: 30_000 });
}

/** Flip the per-device preference through the Settings switch a user would use. */
async function setProbes(page: Page, on: boolean) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const check = page
    .locator('label', { hasText: 'Container and service cards on the machine dashboard' })
    .locator('input[type="checkbox"]');
  await expect(check).toBeVisible({ timeout: 15_000 });
  if ((await check.isChecked()) !== on) await check.click();
  await expect(check).toBeChecked({ checked: on });
  await page.getByRole('button', { name: 'Close settings' }).click();
}

// Probing this host isn't the point — the harness has no container runtime — but an
// unknown-host-key prompt would sit over the dashboard, so take the same TOFU shortcut
// the other dashboard specs take.
test.beforeEach(async ({ request }) => {
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
});

test('turning the probing cards off removes those two cards, and says who refused', async ({ page, request }) => {
  const collection = await ensureCollection(request, 'e2e-probe-gate');
  await createMachine(request, collection, { name: 'e2e-gate-host' });

  // Baseline: on by default, so both probing cards are there.
  await openDashboard(page, 'e2e-gate-host');
  await expect(card(page, 'Containers')).toBeVisible({ timeout: 30_000 });
  await expect(card(page, 'Services')).toBeVisible();

  await setProbes(page, false);
  await openDashboard(page, 'e2e-gate-host');

  // The two that execute on the host are gone…
  await expect(card(page, 'Containers')).toHaveCount(0);
  await expect(card(page, 'Services')).toHaveCount(0);
  // …the rest of the dashboard is untouched…
  await expect(card(page, 'Overview')).toBeVisible();
  await expect(card(page, 'Port forwarding')).toBeVisible();
  // …and the gap names this device's setting rather than a server that said nothing.
  await expect(page.getByText('Containers and services are not being checked')).toBeVisible();
  await expect(page.getByText('Container and service checks are off in your settings.')).toBeVisible();

  // Put it back, so the suite's other dashboard specs see a probing dashboard.
  await setProbes(page, true);
  await openDashboard(page, 'e2e-gate-host');
  await expect(card(page, 'Containers')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Containers and services are not being checked')).toHaveCount(0);
});
