import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Real SSH parity: rite-server opens an actual SSH session (client-execute) to
 * the harness sshd and streams the remote shell over the WebSocket. Covers both
 * a saved connection (connect_terminal) and an ad-hoc quick connect
 * (quick_ssh_connect). Requires e2e/sshd-setup.sh to be running.
 */

const SSH = {
  hostname: '127.0.0.1',
  port: 2222,
  username: 'riteuser',
  password: 'ritepass123',
};

async function createSshConnection(api: APIRequestContext, name: string, hostname = SSH.hostname) {
  const res = await api.post('/api/connections', {
    data: {
      name,
      protocol: 'ssh',
      hostname,
      port: SSH.port,
      username: SSH.username,
      authMethod: { type: 'password', password: SSH.password },
      color: null,
      icon: null,
      folder: null,
      notes: null,
      sshKeepAliveOverride: null,
      sshKeepAliveInterval: null,
    },
  });
  expect(res.ok()).toBeTruthy();
}

test('saved SSH connection: strict host-key prompt, trust, then run a command', async ({
  page,
  request,
}) => {
  // Strict mode (default): an unknown host must be confirmed via the modal.
  //
  // known_hosts is keyed by host:port and the whole suite shares one vault, so any
  // earlier spec that connects to 127.0.0.1:2222 would leave it trusted and this
  // prompt would never appear. Reach the same sshd by a name nothing else uses, so
  // the "unknown host" precondition holds whatever ran before.
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'strict' } });
  await createSshConnection(request, 'e2e-ssh-saved', 'localhost');

  await page.goto('/');
  const item = page.getByText('e2e-ssh-saved');
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.dblclick();

  // Unknown host → the confirmation modal appears (connection was refused).
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Unknown host key')).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText('localhost:2222')).toBeVisible();

  // Trusting it promotes the pending key and retries the connection.
  await dialog.getByRole('button', { name: /trust & connect/i }).click();

  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 20_000 });
  await screen.click();
  await page.keyboard.type('echo RITE_SSH_$((6*7))_OK', { delay: 25 });
  await page.keyboard.press('Enter');

  await expect(page.locator('.xterm-rows')).toContainText('RITE_SSH_42_OK', { timeout: 20_000 });
});

test('quick SSH connect runs a command over a real session', async ({ page }) => {
  await page.goto('/');

  await page.getByText('Quick SSH').click();

  // Fill the Quick SSH modal (password auth is the default) and connect. Scope to
  // the dialog: every machine row in the sidebar carries its own Connect button.
  const dialog = page.getByRole('dialog', { name: 'Quick SSH Connect' });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('example.com').fill(SSH.hostname);
  await dialog.locator('input[type="number"]').fill(String(SSH.port));
  await dialog.getByPlaceholder('user').fill(SSH.username);
  await dialog.getByPlaceholder('Enter password').fill(SSH.password);

  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();

  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 20_000 });
  await screen.click();
  await page.keyboard.type('echo RITE_QUICK_$((7*8))_OK', { delay: 25 });
  await page.keyboard.press('Enter');

  await expect(page.locator('.xterm-rows')).toContainText('RITE_QUICK_56_OK', { timeout: 20_000 });
});
