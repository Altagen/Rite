import { test, expect } from '@playwright/test';

/**
 * Real SSH parity: rite-server opens an actual SSH session (client-execute) to
 * the harness sshd and streams the remote shell over the WebSocket. Covers both
 * a saved connection (connect_terminal) and an ad-hoc quick connect
 * (quick_ssh_connect). Requires the SSH harness: `sh e2e/harness-up.sh`.
 */

import { createCollection, createMachine, SSH } from './support/localVault';

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
  const collectionId = await createCollection(request, 'e2e-ssh');
  await createMachine(request, collectionId, { name: 'e2e-ssh-saved', hostname: 'localhost' });

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

/**
 * Key-based authentication, which nothing covered.
 *
 * Every SSH test in the suite used a password, so `AuthMethod::PublicKey` — the method
 * most infrastructure actually uses — was carried entirely by the compiler. The RSA hash
 * rule, the passphrase handing, the file read: none of it had ever run in a test.
 *
 * Both halves here, because they are different code paths: a key named on disk, and the
 * same key with a passphrase that `russh` has to use to decode it.
 */
test('a machine opens with a key named on disk', async ({ page, request }) => {
  // This test is about the key, not about trusting the host: the suite shares one vault,
  // so whether 127.0.0.1:2222 is already in known_hosts depends on what ran before.
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
  const collectionId = await createCollection(request, 'e2e-key-auth');
  await createMachine(request, collectionId, {
    name: 'e2e-key-host',
    keyPath: SSH.keyPlain,
  });

  await page.goto('/');
  await page.getByText('e2e-key-host').last().dblclick();
  // The shell prompt, not a connected-looking UI: the session has to really open, and a
  // refused key fails here with "Permission denied" instead.
  await expect(page.locator('.xterm-rows')).toContainText(`${SSH.username}@`, { timeout: 25_000 });
});

test('a passphrase-protected key opens with the passphrase that was stored', async ({ page, request }) => {
  // This test is about the key, not about trusting the host: the suite shares one vault,
  // so whether 127.0.0.1:2222 is already in known_hosts depends on what ran before.
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
  const collectionId = await createCollection(request, 'e2e-key-locked');
  await createMachine(request, collectionId, {
    name: 'e2e-locked-host',
    keyPath: SSH.keyLocked,
    passphrase: SSH.keyPassphrase,
  });

  await page.goto('/');
  await page.getByText('e2e-locked-host').last().dblclick();
  await expect(page.locator('.xterm-rows')).toContainText(`${SSH.username}@`, { timeout: 25_000 });
});

test('the same key with the wrong passphrase does not open', async ({ page, request }) => {
  // This test is about the key, not about trusting the host: the suite shares one vault,
  // so whether 127.0.0.1:2222 is already in known_hosts depends on what ran before.
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
  const collectionId = await createCollection(request, 'e2e-key-wrong');
  await createMachine(request, collectionId, {
    name: 'e2e-wrong-pass-host',
    keyPath: SSH.keyLocked,
    passphrase: 'not-the-passphrase',
  });

  await page.goto('/');
  await page.getByText('e2e-wrong-pass-host').last().dblclick();
  // The discriminating half of the pair above: without this, a build that ignored the
  // passphrase entirely (or one that accepted any) would pass the test before it.
  // A refused key opens no pane at all, so the discriminator is that no shell ever
  // appears: a build that ignored the passphrase would decode the key, connect, and put
  // `riteuser@` on screen within seconds — which is exactly what the test above asserts.
  await expect(page.locator('.xterm-rows')).toHaveCount(0, { timeout: 15_000 });
  // Not `getByText('riteuser@')`: the sidebar prints every machine's target, so that
  // matches whether or not anything connected. The terminal is the only honest witness.

  // Leave the suite's policy as the other specs expect to find it.
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'strict' } });
});
