import { test, expect } from '@playwright/test';
import { createCollection, createMachine, listMachines } from './support/localVault';

/**
 * Local-vault CRUD (ADR 0018): collections hold machines, machines are encrypted
 * items inside them, and rite-core is the only thing that holds a key. Verified
 * against a real vault, plus a UI check that the sidebar renders what the API holds.
 */

test('collection and machine CRUD round-trip through the server', async ({ request }) => {
  const collectionId = await createCollection(request, 'e2e-crud');

  const machineId = await createMachine(request, collectionId, {
    name: 'e2e-machine',
    hostname: 'example.com',
    port: 22,
    username: 'root',
    password: 's3cret',
  });

  let machines = await listMachines(request, collectionId);
  expect(machines.map((m) => m.name)).toContain('e2e-machine');

  // Editing is a patch: the UI never receives credentials, so it cannot send a
  // whole record back — anything left out keeps what is stored.
  const renamed = await request.put(
    `/api/local/collections/${collectionId}/machines/${machineId}`,
    { data: { name: 'e2e-machine-renamed' } },
  );
  expect(renamed.ok()).toBeTruthy();
  machines = await listMachines(request, collectionId);
  expect(machines[0].name).toBe('e2e-machine-renamed');
  expect(machines[0].hostname).toBe('example.com');

  const removed = await request.delete(
    `/api/local/collections/${collectionId}/machines/${machineId}`,
  );
  expect(removed.ok()).toBeTruthy();
  expect(await listMachines(request, collectionId)).toHaveLength(0);

  // Deleting the collection is allowed: locally every collection is equal, there
  // is no Personal that cannot go (ADR 0018).
  const gone = await request.delete(`/api/local/collections/${collectionId}`);
  expect(gone.ok()).toBeTruthy();
});

/**
 * The security property the whole design rests on: the process that renders the UI
 * must never receive a credential. rite-core decrypts and opens SSH itself, so a
 * machine comes back saying *how* it authenticates and never with what.
 */
test('a listed machine never carries its credentials', async ({ request }) => {
  const collectionId = await createCollection(request, 'e2e-secrets');
  await createMachine(request, collectionId, {
    name: 'e2e-secret-holder',
    hostname: 'secret-host.example',
    username: 'deployer',
    password: 'do-not-leak-me',
  });

  const raw = await (
    await request.get(`/api/local/collections/${collectionId}/machines`)
  ).text();

  expect(raw).toContain('e2e-secret-holder');
  expect(raw).toContain('secret-host.example');
  // …but not the password, nor the field that would carry one.
  expect(raw).not.toContain('do-not-leak-me');
  expect(raw).not.toContain('authMethod');
  expect(JSON.parse(raw)[0].authType).toBe('password');
});

/** The retired path must be plainly gone rather than quietly half-working. */
test('the legacy connections endpoint is retired for a local vault', async ({ request }) => {
  const res = await request.get('/api/connections');
  expect(res.status()).toBe(410);
  expect(await res.text()).toContain('/api/local/collections');
});

test('a created machine shows up in the sidebar list', async ({ page, request }) => {
  const collectionId = await createCollection(request, 'e2e-sidebar');
  await createMachine(request, collectionId, {
    name: 'e2e-visible',
    hostname: 'example.com',
    port: 22,
    username: 'root',
  });

  await page.goto('/');
  // Vault is already set up (smoke test) and unlocked in the server → main screen.
  await expect(page.getByText('e2e-visible')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('root@example.com:22')).toBeVisible();
});
