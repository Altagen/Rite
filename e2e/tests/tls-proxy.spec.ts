import { test, expect } from '@playwright/test';

/**
 * Context multiplexer over TLS with cert TOFU (ADR 0012 phase 4). The local
 * multiplexer (:1426) adds a self-signed https remote (:1425): the probe reports
 * the cert as untrusted, the UI shows its fingerprint, the user pins it (TOFU),
 * and the whole login flow is then reverse-proxied to the remote over TLS —
 * validated against the pinned certificate by the local server's rustls.
 */

test.describe.configure({ mode: 'serial' });

test('pin a self-signed remote cert and log in through the TLS proxy', async ({ page }) => {
  await page.goto('/');

  // The multiplexer's own local vault: first-run setup.
  const password = page.locator('#password');
  await expect(password).toBeVisible({ timeout: 15_000 });
  const strong = 'Local-MuxTls-Str0ng!pass';
  await password.fill(strong);
  await page.locator('#confirmPassword').fill(strong);
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText('Local Terminal')).toBeVisible({ timeout: 15_000 });

  // Add the self-signed https remote → probe returns untrusted → TOFU modal.
  await page.getByRole('button', { name: /context/i }).click();
  await page.getByRole('button', { name: /add server/i }).click();
  await page.getByPlaceholder('https://rite.example.com').fill('https://127.0.0.1:1425');
  await page.getByPlaceholder('Label (optional)').fill('TlsServer');
  await page.getByRole('button', { name: /^add$/i }).click();

  // Confirm the fingerprint (pins it) — the dropdown stays open with the server.
  await expect(page.getByRole('heading', { name: /untrusted certificate/i })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: /trust & add/i }).click();

  // Switch to the pinned remote → proxied over TLS to :1425 → remote login.
  await page.getByText('TlsServer').click();

  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 20_000 });
  await page.locator('#username').fill('envadmin');
  await page.locator('#password').fill('EnvPass123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // The proxied (TLS + pinned) login lands on the remote's admin panel.
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible({ timeout: 30_000 });
});
