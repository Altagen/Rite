import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Wave-1 feature parity, driven through the real app against the harness sshd.
 *
 * These are the features shipped for 0.2.0 on top of the SSH core — pre-connect
 * hook, jump host, port forwarding, snippets and the machine dashboard. Each one
 * has core-level tests; here they are exercised the way a user meets them, so a
 * break in the wiring between the UI, rite-server and rite-core is caught too.
 *
 * Requires e2e/sshd-setup.sh to be running (127.0.0.1:2222, riteuser/ritepass123).
 */

import {
  createCollection,
  createMachine,
  SSH,
  type MachineOpts,
} from './support/localVault';

/** A collection for wave-1 machines; created once, reused by every test here. */
async function machine(api: APIRequestContext, o: MachineOpts): Promise<string> {
  const collectionId = await ensureWave1Collection(api);
  return createMachine(api, collectionId, o);
}

let wave1Collection: string | null = null;
async function ensureWave1Collection(api: APIRequestContext): Promise<string> {
  wave1Collection ??= await createCollection(api, 'e2e-wave1');
  return wave1Collection;
}

/** Trust the harness host key up front so tests don't each fight the modal. */
test.beforeEach(async ({ request }) => {
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
});

test('pre-connect hook runs before SSH and its output reaches the modal', async ({
  page,
  request,
}) => {
  await machine(request, { name: 'e2e-preconnect-ok', preconnect: 'echo PRECONNECT_RAN_OK' });

  await page.goto('/');
  await page.getByText('e2e-preconnect-ok').dblclick();

  // The hook runs in its own live terminal before any SSH traffic.
  const dialog = page.getByRole('dialog', { name: 'Running pre-connect' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  // The hook's output streams into the modal's own live terminal.
  await expect(dialog.locator('.xterm-rows')).toContainText('PRECONNECT_RAN_OK', {
    timeout: 20_000,
  });

  // Exit 0 ⇒ the modal closes itself and the SSH session opens.
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 20_000 });
  // Wait for the remote shell's prompt: typing before it is ready loses keystrokes.
  await expect(page.locator('.xterm-rows')).toContainText(`${SSH.username}@`, {
    timeout: 20_000,
  });
  await screen.click();
  await page.keyboard.type('echo RITE_AFTER_HOOK_OK', { delay: 25 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('RITE_AFTER_HOOK_OK', {
    timeout: 20_000,
  });
});

test('a failing pre-connect hook cancels the connection', async ({ page, request }) => {
  // Fail-fast: the second line must never run, and SSH must not open.
  await machine(request, {
    name: 'e2e-preconnect-fail',
    preconnect: 'echo HOOK_FIRST_LINE\nexit 3\necho HOOK_SHOULD_NOT_RUN',
  });

  await page.goto('/');
  await page.getByText('e2e-preconnect-fail').dblclick();

  const dialog = page.getByRole('dialog', { name: 'Running pre-connect' });
  await expect(dialog.locator('.xterm-rows')).toContainText('HOOK_FIRST_LINE', {
    timeout: 20_000,
  });
  await expect(dialog).toContainText('Pre-connect failed', { timeout: 20_000 });
  await expect(dialog.locator('.xterm-rows')).not.toContainText('HOOK_SHOULD_NOT_RUN');

  // The failure is a dead end until the user acts, and nothing was connected: the
  // workspace behind the modal still has no terminal. (Session ids alone can't say
  // this — the hook's own PTY is a session too.)
  await expect(dialog.getByRole('button', { name: /retry/i })).toBeVisible();
  await expect(page.getByText('No active terminal sessions')).toBeVisible();

  // Cancelling leaves the workspace as it was, with no session opened behind it.
  await dialog.getByRole('button', { name: /cancel/i }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('No active terminal sessions')).toBeVisible();
});

test('a connection reaches its target through a jump host', async ({ page, request }) => {
  // The harness sshd plays both roles: the bastion relays a direct-tcpip channel
  // back to itself, which is exactly the hop a real ProxyJump performs.
  const bastionId = await machine(request, { name: 'e2e-bastion' });
  await machine(request, { name: 'e2e-behind-jump', jump: bastionId });

  await page.goto('/');
  await page.getByText('e2e-behind-jump').dblclick();

  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.xterm-rows')).toContainText(`${SSH.username}@`, {
    timeout: 30_000,
  });
  await screen.click();
  await page.keyboard.type('echo RITE_VIA_JUMP_OK', { delay: 25 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('RITE_VIA_JUMP_OK', { timeout: 20_000 });
});

test('a saved port forward starts and is reported as listening', async ({ page, request }) => {
  // Forward to the sshd itself: a port we know answers from the target's side.
  await machine(request, {
    name: 'e2e-forward',
    forwards: [
      { forwardType: 'local', localPort: 15432, remoteHost: '127.0.0.1', remotePort: 2222 },
    ],
  });

  await page.goto('/');
  // Single click opens the machine dashboard (double click connects).
  await page.getByText('e2e-forward').click();
  await expect(page.getByText('Port forwarding')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: /manage/i }).click();
  const dialog = page.getByRole('dialog', { name: 'Port forwarding' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // The tunnel is really up: rite-core reports it among the running forwards.
  const running = await (await request.get('/api/forwards')).json();
  expect(running.length, 'the forward should be running server-side').toBe(1);
  expect(running[0].remotePort).toBe(2222);

  await dialog.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeVisible({
    timeout: 20_000,
  });
});

test('a snippet runs in the focused pane', async ({ page, request }) => {
  await machine(request, { name: 'e2e-snippets' });

  await page.goto('/');
  await page.getByText('e2e-snippets').dblclick();
  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.xterm-rows')).toContainText(`${SSH.username}@`, {
    timeout: 20_000,
  });

  await page.getByTitle('Snippets', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Snippets' });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Name').fill('e2e-hello');
  await dialog.getByLabel(/Command/).fill('echo RITE_SNIPPET_OK');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();

  // The library ships with a few defaults, so act on our own row, not the first.
  const row = dialog.locator('li').filter({ hasText: 'e2e-hello' });
  await expect(row).toHaveCount(1);
  // Running types the command into the pane and presses Enter for you.
  await row.getByTitle('Run on this pane').click();
  await expect(page.locator('.xterm-rows')).toContainText('RITE_SNIPPET_OK', { timeout: 20_000 });
});

test('the machine dashboard probes the host and degrades gracefully', async ({ page, request }) => {
  await machine(request, { name: 'e2e-dashboard' });

  await page.goto('/');
  await page.getByText('e2e-dashboard').click();

  // Identity + the always-present Overview card.
  await expect(page.getByText('Overview')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(`${SSH.username}@${SSH.hostname}`).first()).toBeVisible();

  // Containers and Services probe the host over SSH. What matters here is that both
  // resolve to a definite answer and neither hangs on "Detecting…" nor surfaces a
  // probe error — whether the host turns out to have a runtime is the harness's
  // business, and wave1-dashboard.spec.ts covers what a host that does looks like.
  await expect(page.getByText('Containers')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Detecting…')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(/Couldn't detect/)).toHaveCount(0);
});
