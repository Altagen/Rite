import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * The machine dashboard against a host that actually answers its probes.
 *
 * wave1.spec.ts covers the dashboard on a bare host, where both cards resolve to
 * "nothing here". That leaves the bulk of the feature — the tables, the per-row
 * actions, pinning, filtering, the expanded wide view and Customize — untested,
 * because the harness has no container runtime and no systemd. e2e/dashboard-stubs.sh
 * puts stub `docker` and `systemctl` on the host so the probes return realistic
 * output; everything else (the exec over SSH, the parsers, the UI) is the real path.
 */

// Connection names are deliberately card-name-free ("e2e-dash-a", not
// "e2e-dash-containers"): the suite shares one vault, so a row named after a card
// would make a locator for that card's title ambiguous.
import { createCollection, createMachine, SSH } from './support/localVault';

let dashCollection: string | null = null;
async function createConnection(api: APIRequestContext, name: string): Promise<string> {
  dashCollection ??= await createCollection(api, 'e2e-dash');
  return createMachine(api, dashCollection, { name });
}

test.beforeEach(async ({ request }) => {
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
});

test('containers card lists what the host runs, with per-row actions', async ({ page, request }) => {
  await createConnection(request, 'e2e-dash-a');
  await page.goto('/');
  await page.getByText('e2e-dash-a').click();

  // Detection names the runtime it found and drives the actions from it.
  await expect(page.getByText('docker', { exact: true })).toBeVisible({ timeout: 30_000 });
  for (const name of ['web', 'api', 'worker', 'redis', 'migrate']) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('nginx:1.27 · 0.0.0.0:80->80/tcp')).toBeVisible();

  // A stopped container can be tailed but not shelled into.
  const rows = page.locator('div').filter({ hasText: /^migrate/ });
  const migrateShell = page.getByTitle('docker exec -it migrate sh');
  await expect(migrateShell).toBeDisabled();
  await expect(page.getByTitle('docker exec -it web sh')).toBeEnabled();
  expect(await rows.count()).toBeGreaterThan(0);

  // Row actions carry the exact command they will run, per runtime.
  await expect(page.getByTitle('docker logs -f --tail 200 api')).toBeVisible();
  await expect(page.getByTitle('docker restart api')).toBeVisible();
});

test('a container action opens a terminal pane running that command', async ({ page, request }) => {
  await createConnection(request, 'e2e-dash-b');
  await page.goto('/');
  await page.getByText('e2e-dash-b').click();
  await expect(page.getByTitle('docker logs -f --tail 200 web')).toBeVisible({ timeout: 30_000 });

  await page.getByTitle('docker logs -f --tail 200 web').click();

  // The action connects, switches to the terminal and types the command — nothing
  // runs invisibly, the user watches it happen in a real pane.
  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.xterm-rows')).toContainText('docker logs -f --tail 200 web', {
    timeout: 30_000,
  });
});

test('pinning a container survives switching to the Pinned view', async ({ page, request }) => {
  await createConnection(request, 'e2e-dash-c');
  await page.goto('/');
  await page.getByText('e2e-dash-c').click();
  await expect(page.getByText('redis', { exact: true })).toBeVisible({ timeout: 30_000 });

  // Nothing pinned yet ⇒ the Pinned view is empty.
  await page.getByRole('button', { name: 'Pinned', exact: true }).click();
  await expect(page.getByText('No pinned containers.')).toBeVisible();

  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await page.getByTitle('Pin — 1-click').first().click();
  await page.getByRole('button', { name: 'Pinned', exact: true }).click();
  await expect(page.getByText('No pinned containers.')).toBeHidden();
  await expect(page.getByTitle('Unpin')).toHaveCount(1);
});

test('services card surfaces failed units and filters on them', async ({ page, request }) => {
  await createConnection(request, 'e2e-dash-d');
  await page.goto('/');
  await page.getByText('e2e-dash-d').click();

  await expect(page.getByText('nginx.service')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('postgresql.service')).toBeVisible();
  // A failed unit is counted on the card header — the thing a sysadmin looks for.
  await expect(page.getByText('1 failed')).toBeVisible();

  await page.getByRole('button', { name: 'Failed', exact: true }).click();
  await expect(page.getByText('backup.service')).toBeVisible();
  await expect(page.getByText('nginx.service')).toBeHidden();

  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.getByText('backup.service')).toBeHidden();
  await expect(page.getByText('nginx.service')).toBeVisible();

  // A running unit offers Stop; the journal command is exact.
  await expect(page.getByTitle('journalctl -u nginx.service -f -n 200')).toBeVisible();
  await expect(page.getByTitle('sudo systemctl stop nginx.service')).toBeVisible();
});

test('expanding the containers card reveals the wide table with live stats', async ({
  page,
  request,
}) => {
  await createConnection(request, 'e2e-dash-e');
  await page.goto('/');
  await page.getByText('e2e-dash-e').click();
  await expect(page.getByText('web', { exact: true })).toBeVisible({ timeout: 30_000 });

  // Collapsed: no table columns.
  await expect(page.getByRole('columnheader', { name: 'CPU' })).toBeHidden();

  const containersCard = page.locator('div').filter({ hasText: /^Containers/ }).first();
  await containersCard.getByTitle('Expand for more detail').click();

  // Wide adds the columns, and CPU/Mem are fetched lazily only now.
  await expect(page.getByRole('columnheader', { name: 'CPU' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Created' })).toBeVisible();
  await expect(page.getByText('0.40%')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('318MiB')).toBeVisible();
  await expect(page.getByText('3 days ago').first()).toBeVisible();
});

test('Customize hides a card and the choice persists across a reload', async ({ page, request }) => {
  await createConnection(request, 'e2e-dash-f');
  await page.goto('/');
  await page.getByText('e2e-dash-f').click();
  await expect(page.getByText('Containers')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Customize' }).click();
  await expect(page.getByText('Customize dashboard')).toBeVisible();
  // Uncheck Containers, then close.
  await page.getByRole('checkbox', { name: 'Containers' }).uncheck();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Containers')).toBeHidden();

  // The layout is per-machine and kept locally, so it survives a reload.
  await page.reload();
  await page.getByText('e2e-dash-f').click();
  await expect(page.getByText('Overview')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Containers')).toBeHidden();
});
