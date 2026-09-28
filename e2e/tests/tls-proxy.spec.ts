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
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({ timeout: 15_000 });

  // Add the self-signed https remote: the probe reports it untrusted and returns
  // the fingerprint, which we pin (TOFU), then switch to it. The context hub is
  // native-only, so drive the probe/add/pin/active endpoints directly, then reload
  // — the local server validates the pinned cert via rustls and proxies over TLS.
  const pinned = await page.evaluate(async () => {
    const post = (path: string, body: unknown) =>
      fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const probe = await (await post('/api/context/probe', { url: 'https://127.0.0.1:1425' })).json();
    const s = await (await post('/api/context/servers', { url: 'https://127.0.0.1:1425', label: 'TlsServer' })).json();
    if (probe.fingerprint) await post(`/api/context/servers/${s.id}/pin`, { fingerprint: probe.fingerprint });
    await post('/api/context/active', { server: s.id });
    return { fingerprint: probe.fingerprint as string | null, trusted: probe.trusted as boolean };
  });
  // The self-signed cert must have been reported untrusted with a fingerprint to pin.
  expect(pinned.trusted).toBe(false);
  expect(pinned.fingerprint).toMatch(/^[0-9a-f:]+$/i);
  await page.reload();

  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 20_000 });
  await page.locator('#username').fill('envadmin');
  await page.locator('#password').fill('EnvPass123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // The proxied (TLS + pinned) login lands in the remote's workspace.
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({ timeout: 30_000 });
});
