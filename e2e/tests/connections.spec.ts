import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Connection management parity: the CRUD endpoints the desktop app relies on
 * (create/update/delete + list) now served by rite-server, verified end to end
 * against a real vault, plus a UI check that the list renders what the API holds.
 */

const sshConn = (name: string) => ({
  name,
  protocol: 'ssh',
  hostname: 'example.com',
  port: 22,
  username: 'root',
  authMethod: { type: 'password', password: 's3cret' },
  color: null,
  icon: null,
  folder: null,
  notes: null,
  sshKeepAliveOverride: null,
  sshKeepAliveInterval: null,
});

async function listNames(api: APIRequestContext): Promise<string[]> {
  const res = await api.get('/api/connections');
  expect(res.ok()).toBeTruthy();
  return (await res.json()).map((c: { name: string }) => c.name);
}

test('connection CRUD round-trips through the server', async ({ request }) => {
  // Create
  const created = await request.post('/api/connections', { data: sshConn('e2e-crud') });
  expect(created.ok()).toBeTruthy();
  const conn = await created.json();
  expect(conn.id).toBeTruthy();
  expect(conn.name).toBe('e2e-crud');
  expect(await listNames(request)).toContain('e2e-crud');

  // Update
  const updated = await request.put(`/api/connections/${conn.id}`, {
    data: { id: conn.id, name: 'e2e-crud-renamed' },
  });
  expect(updated.ok()).toBeTruthy();
  expect((await updated.json()).name).toBe('e2e-crud-renamed');

  // Delete
  const deleted = await request.delete(`/api/connections/${conn.id}`);
  expect(deleted.status()).toBe(204);
  expect(await listNames(request)).not.toContain('e2e-crud-renamed');
});

test('a created connection shows up in the sidebar list', async ({ page, request }) => {
  await request.post('/api/connections', { data: sshConn('e2e-visible') });

  await page.goto('/');
  // Vault is already set up (smoke test) and unlocked in the server → main screen.
  await expect(page.getByText('e2e-visible')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('root@example.com:22')).toBeVisible();
});
