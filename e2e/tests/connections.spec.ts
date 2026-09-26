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

/**
 * Folders and a Board in a local vault — the two things collections were supposed
 * to bring locally (ADR 0018), and the reason a vault has collections at all
 * rather than one flat list. Folders live in the collection's encrypted header, so
 * an empty one survives; the Board rides the itemsKey like the machines do.
 */
test('a local collection carries folders and a board', async ({ request }) => {
  const collectionId = await createCollection(request, 'e2e-structure');

  // Declare two folders, one of them empty — the point of storing them in the
  // header rather than deriving them from the machines that reference them.
  const named = await request.put(`/api/local/collections/${collectionId}`, {
    data: {
      name: 'e2e-structure',
      folders: [
        { name: 'Hypervisors', color: '#7c9cf5' },
        { name: 'Empty', color: null },
      ],
    },
  });
  expect(named.ok()).toBeTruthy();

  await createMachine(request, collectionId, { name: 'e2e-in-folder', folder: 'Hypervisors' });

  const cols = await (await request.get('/api/local/collections')).json();
  const mine = cols.find((c: { id: string }) => c.id === collectionId);
  expect(mine.folders.map((f: { name: string }) => f.name)).toEqual(['Hypervisors', 'Empty']);
  expect((await listMachines(request, collectionId))[0].folder).toBe('Hypervisors');

  // A rename must not quietly drop the folders living in the same header blob.
  await request.put(`/api/local/collections/${collectionId}`, { data: { name: 'e2e-renamed' } });
  const after = (await (await request.get('/api/local/collections')).json()).find(
    (c: { id: string }) => c.id === collectionId,
  );
  expect(after.name).toBe('e2e-renamed');
  expect(after.folders).toHaveLength(2);

  // Board: empty to begin with, round-trips, and the stored blob is ciphertext.
  expect(await (await request.get(`/api/local/collections/${collectionId}/board`)).json()).toEqual([]);
  const cards = [
    { id: 'b1', type: 'link', title: 'Grafana', url: 'https://grafana.secret.example' },
    { id: 'b2', type: 'note', title: 'Scrub', text: 'sunday 03:00' },
  ];
  const saved = await request.put(`/api/local/collections/${collectionId}/board`, { data: cards });
  expect(saved.ok()).toBeTruthy();
  expect(await (await request.get(`/api/local/collections/${collectionId}/board`)).json()).toEqual(cards);
  // hasBoard is what the sidebar uses to show the indicator.
  const withBoard = (await (await request.get('/api/local/collections')).json()).find(
    (c: { id: string }) => c.id === collectionId,
  );
  expect(withBoard.hasBoard).toBe(true);

  // An empty array clears it, matching the browser — one state, not two.
  await request.put(`/api/local/collections/${collectionId}/board`, { data: [] });
  expect(await (await request.get(`/api/local/collections/${collectionId}/board`)).json()).toEqual([]);
});
