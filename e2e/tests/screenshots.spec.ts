/**
 * The README's screenshots, taken by driving the real UI.
 *
 * Not hand-cropped: the interface changes, and a picture nobody can regenerate goes
 * stale silently and then lies about the product. `--project=shots` takes them again,
 * against the same server the test suite uses, so a shot that cannot be taken is a
 * failing test rather than a wrong image.
 *
 * Everything on screen is seeded here, which is the other reason to script it: no
 * hostname, user, path or instance name from whoever runs it reaches the images. The
 * terminal's prompt is set explicitly for the same reason — the harness container
 * shares the host's hostname, so a real prompt would print it.
 *
 *   sh e2e/harness-up.sh
 *   RITE_SHOTS=1 npx playwright test --project=shots
 */
import { test, expect, type Page } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { createMachine, ensureCollection, listMachines, SSH } from './support/localVault';

const SHOTS = 'docs/screenshots';
const ACCOUNTS = 'http://127.0.0.1:1422';

/** A desktop-sized viewport: wide enough that nothing folds into an overflow menu. */
const VIEWPORT = { width: 1440, height: 900 };

/**
 * A prompt that names no real machine. The harness shares the host's hostname, so
 * `riteuser@$(hostname)` would print it into the image; `clear` then leaves the
 * scrollback holding only what we meant to show.
 */
async function presentableShell(page: Page, as: string) {
  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 25_000 });
  await screen.click();
  await page.keyboard.type(`export PS1='${as}:~$ ' && clear`, { delay: 10 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
});

/**
 * One library, shared by every shot.
 *
 * `createCollection` makes a new one each call, so seeding per test left the sidebar
 * holding two collections both called Infrastructure — visible in the images, and the
 * kind of thing a reader notices before anything else.
 */
async function seedLibrary(request: APIRequestContext): Promise<string> {
  const infra = await ensureCollection(request, 'Infrastructure');
  const existing = await listMachines(request, infra);
  if (existing.length === 0) {
    // One machine really connects (it is the harness); the others show what a library
    // looks like. Names and targets are made up on purpose.
    await createMachine(request, infra, { name: 'web-01', hostname: SSH.hostname, port: SSH.port });
    await createMachine(request, infra, { name: 'db-primary', hostname: '10.0.0.21', username: 'postgres' });
    await createMachine(request, infra, { name: 'bastion', hostname: '10.0.0.2', username: 'deploy' });
    await createMachine(request, infra, { name: 'worker-03', hostname: '10.0.0.31', username: 'deploy' });
  }
  return infra;
}

test('workspace: the library and a live session', async ({ page, request }) => {
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
  await seedLibrary(request);

  await page.goto('/');
  // Connect from the row's own button rather than by double-clicking the row: a
  // double-click fires the single-click first, which opens the machine's dashboard, and
  // the shot would carry a second tab nobody asked for.
  const row = page.locator('.m-tnode.leaf', { hasText: 'web-01' });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Connect' }).click();
  await presentableShell(page, 'deploy@web-01');

  // The harness's own stubs (`e2e/dashboard-stubs.sh`), which print a plausible fleet and
  // nothing from this machine — `df -h` would have put the real disk in the picture. Run
  // plainly: the stub ignores `--format`, so a formatted command would print output that
  // does not match what was typed.
  for (const command of ['docker ps', 'uptime']) {
    await page.keyboard.type(command, { delay: 8 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(600);

  await page.screenshot({ path: `${SHOTS}/workspace.png` });
});

test('layouts: one file, three panes, opened at once', async ({ page, request }) => {
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
  await seedLibrary(request);

  // Every pane names the machine. A pane with no `machine` is a LOCAL terminal, which
  // prints the real prompt of whoever runs this — the first take of this shot carried a
  // username, a hostname and a disk layout into the image three times over.
  const shown = (command: string) => `export PS1='deploy@web-01:~$ ' && clear && ${command}`;
  await request.put('/api/layouts', {
    data: {
      value:
        '[[preset]]\nname = "Load"\ncommand = "uptime"\n\n' +
        '[[layout]]\nname = "Morning"\n\n' +
        `  [[layout.pane]]\n  machine = "web-01"\n  name = "services"\n  command = "${shown('docker ps')}"\n\n` +
        `  [[layout.pane]]\n  machine = "web-01"\n  name = "load"\n  command = "${shown('uptime')}"\n  split = "down"\n\n` +
        `  [[layout.pane]]\n  machine = "web-01"\n  name = "units"\n  command = "${shown('systemctl list-units --type=service --no-pager | head -8')}"\n  split = "right"\n  of = "services"\n`,
    },
  });

  await page.goto('/');
  await page.getByTestId('layouts-button').click();
  await page.getByRole('menu', { name: /Layouts/ }).getByText('Morning', { exact: true }).click();
  await expect(page.locator('.xterm-screen')).toHaveCount(3, { timeout: 40_000 });
  await page.waitForTimeout(1200);

  await page.screenshot({ path: `${SHOTS}/layouts.png` });
  await request.put('/api/layouts', { data: { value: '' } });
});

test('dashboard: what a machine answers about itself', async ({ page, request }) => {
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
  await seedLibrary(request);

  await page.goto('/');
  // A single click opens the dashboard; a double-click would connect instead.
  await page.getByText('web-01').last().click();
  await expect(page.getByText('Overview')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2500); // let the cards finish their first probe

  await page.screenshot({ path: `${SHOTS}/dashboard.png` });
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'strict' } });
});

test('administration: the policies an instance governs', async ({ page }) => {
  // The accounts server, by absolute URL: this is the one surface a local vault has no
  // equivalent of, and it is the reason the project has a server mode at all.
  await page.goto(`${ACCOUNTS}/`);
  const bootstrap = page.getByText('Create the server administrator');
  if (await bootstrap.isVisible().catch(() => false)) {
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill('Rite-E2E-Str0ng!pass');
    await page.getByRole('button', { name: /create administrator/i }).click();
  } else {
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill('Rite-E2E-Str0ng!pass');
    await page.getByRole('button', { name: /^sign in$/i }).click();
  }
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await page.getByRole('button', { name: 'Instance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Instance' })).toBeVisible({ timeout: 15_000 });

  // Scrolled to the governed capabilities rather than the top of the page: the switches
  // above are an instance's housekeeping, and these are the reason server mode exists —
  // the shell the instance runs, who may deviate, Quick SSH, host keys, stored secrets.
  // `scrollIntoViewIfNeeded` centres it, which starts the image on a half-sentence from
  // the row above. Put the heading at the top instead.
  await page.getByText('Client capabilities').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(600);

  await page.screenshot({ path: `${SHOTS}/administration.png` });
});
