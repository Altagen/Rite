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

async function createSshConnection(api: APIRequestContext, name: string) {
  const res = await api.post('/api/connections', {
    data: {
      name,
      protocol: 'ssh',
      hostname: SSH.hostname,
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

test('connect to a saved SSH connection and run a command', async ({ page, request }) => {
  // TOFU host-key mode so an unknown host is accepted (strict mode correctly
  // rejects unknown hosts and awaits a confirmation modal — see known-hosts note).
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
  await createSshConnection(request, 'e2e-ssh-saved');

  await page.goto('/');
  const item = page.getByText('e2e-ssh-saved');
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.dblclick();

  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 20_000 });
  await screen.click();
  await page.keyboard.type('echo RITE_SSH_$((6*7))_OK');
  await page.keyboard.press('Enter');

  await expect(page.locator('.xterm-rows')).toContainText('RITE_SSH_42_OK', { timeout: 20_000 });
});

test('quick SSH connect runs a command over a real session', async ({ page }) => {
  await page.goto('/');

  await page.getByText('Quick SSH').click();

  // Fill the Quick SSH modal (password auth is the default) and connect.
  await page.getByPlaceholder('example.com').fill(SSH.hostname);
  await page.locator('input[type="number"]').fill(String(SSH.port));
  await page.getByPlaceholder('user').fill(SSH.username);
  await page.getByPlaceholder('Enter password').fill(SSH.password);

  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 20_000 });
  await screen.click();
  await page.keyboard.type('echo RITE_QUICK_$((7*8))_OK');
  await page.keyboard.press('Enter');

  await expect(page.locator('.xterm-rows')).toContainText('RITE_QUICK_56_OK', { timeout: 20_000 });
});
