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

  const raw = await (await request.get(`/api/local/collections/${collectionId}/machines`)).text();

  expect(raw).toContain('e2e-secret-holder');
  expect(raw).toContain('secret-host.example');
  // …but not the password, nor the field that would carry one.
  expect(raw).not.toContain('do-not-leak-me');
  expect(raw).not.toContain('authMethod');
  expect(JSON.parse(raw)[0].authType).toBe('password');
});

/**
 * A path comes back; what it protects does not (ADR 0024 §6).
 *
 * A key path is not a secret — it names a file. Withholding it meant you could not see
 * which key a machine used, and the form reopened on "Password" with empty fields: typing
 * a password there converted a key-based machine to password authentication, silently, and
 * nothing broke until the next connection.
 */
test('a key-based machine says which key, and never its passphrase', async ({ request }) => {
  const collectionId = await createCollection(request, 'e2e-keypath');
  await createMachine(request, collectionId, {
    name: 'e2e-key-machine',
    keyPath: '/home/someone/.ssh/id_ed25519',
    passphrase: 'do-not-leak-this-passphrase',
  });

  const raw = await (await request.get(`/api/local/collections/${collectionId}/machines`)).text();
  const [machine] = JSON.parse(raw);
  expect(machine.authType).toBe('publicKey');
  expect(machine.keyPath, 'the path names a file, so it comes back').toBe(
    '/home/someone/.ssh/id_ed25519',
  );
  expect(raw).not.toContain('do-not-leak-this-passphrase');
  expect(raw).not.toContain('authMethod');
});

/**
 * Reveal is a request, and a vault may refuse it (ADR 0024 §5).
 *
 * This is the one context where refusing is the end of it: the key lives in rite-core, so
 * a client that wants a secret has to ask another process. On a shared server the browser
 * already holds the plaintext it connects with, and the same switch binds its UI instead.
 */
test('a stored secret comes back only when asked, and only if the vault allows it', async ({
  request,
}) => {
  const collectionId = await createCollection(request, 'e2e-reveal');
  const machineId = await createMachine(request, collectionId, {
    name: 'e2e-reveal-machine',
    password: 'reveal-me-on-request',
  });
  const secretUrl = `/api/local/collections/${collectionId}/machines/${machineId}/secret`;

  // Not on the listing, on this request — and the listing above has already been asserted
  // to carry nothing, which is what makes this a reveal rather than a second copy.
  const shown = await request.get(secretUrl);
  expect(shown.status()).toBe(200);
  expect((await shown.json()).password).toBe('reveal-me-on-request');

  // A vault set to keep its secrets unreadable refuses, and says so rather than
  // answering with an empty object a caller would render as "no password".
  expect(
    (await request.put('/api/settings/allow_secret_reveal', { data: { value: '0' } })).status(),
  ).toBe(204);
  const refused = await request.get(secretUrl);
  expect(refused.status()).toBe(403);
  expect(await refused.text()).toContain('unreadable');

  // …and it is the setting that did it, not the machine going missing.
  await request.put('/api/settings/allow_secret_reveal', { data: { value: '1' } });
  expect((await request.get(secretUrl)).status()).toBe(200);
  await request.delete(`/api/local/collections/${collectionId}`);
});

/**
 * The box says what the machine holds, and unticking it means something.
 *
 * It was seeded `false` always, so a machine whose passphrase Rite was holding reopened
 * with "remember this passphrase" unticked and an empty field beside it — which reads as
 * "nothing is kept", the opposite of the truth. And unticking it did nothing at all: the
 * update left `authMethod` out, so the core kept the stored one, passphrase included.
 */
test('a stored passphrase shows as stored, and unticking forgets it', async ({ request }) => {
  const collectionId = await createCollection(request, 'e2e-forget-pass');
  const machineId = await createMachine(request, collectionId, {
    name: 'e2e-forget-pass-host',
    keyPath: '/home/someone/.ssh/id_forget',
    passphrase: 'forget-me-when-asked',
  });
  const listed = async () => (await listMachines(request, collectionId))[0];

  // The fact the form needs, and it is a fact rather than the secret.
  expect((await listed()).hasStoredPassphrase, 'a passphrase is held').toBe(true);
  const raw = await (await request.get(`/api/local/collections/${collectionId}/machines`)).text();
  expect(raw).not.toContain('forget-me-when-asked');

  // An edit that mentions neither keeps it — this is what lets you rename a machine.
  await request.put(`/api/local/collections/${collectionId}/machines/${machineId}`, {
    data: { name: 'e2e-forget-pass-renamed' },
  });
  expect((await listed()).hasStoredPassphrase, 'a rename does not drop it').toBe(true);

  // Unticking says so explicitly, and the key stays — only the passphrase goes.
  await request.put(`/api/local/collections/${collectionId}/machines/${machineId}`, {
    data: { forgetPassphrase: true },
  });
  const after = await listed();
  expect(after.hasStoredPassphrase, 'unticking forgets it').toBe(false);
  expect(after.authType, 'and the machine is still key-based').toBe('publicKey');
  expect(after.keyPath, 'with the same key').toBe('/home/someone/.ssh/id_forget');

  await request.delete(`/api/local/collections/${collectionId}`);
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
 * The form opens on what the machine actually is (ADR 0024 §6).
 *
 * It seeded its auth state from a prefill only, never from the record being edited, so
 * every saved machine reopened as "Password" with empty fields. Two costs: you could not
 * see which key a key-based machine used, and typing a password into what looked like the
 * password field converted it to password authentication without a word — nothing broke
 * until the next connection, on a machine that had been working for months.
 */
test('editing a key-based machine opens on the key, not on a password field', async ({
  page,
  request,
}) => {
  const collectionId = await createCollection(request, 'e2e-edit-key');
  await createMachine(request, collectionId, {
    name: 'e2e-edit-key-machine',
    keyPath: '/home/someone/.ssh/id_edit_test',
  });

  await page.goto('/');
  // The sidebar row, scoped by its machine: "Edit" is a per-row button and there is one
  // beside every machine and every collection.
  const row = page.locator('.m-tnode.leaf', { hasText: 'e2e-edit-key-machine' });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button', { name: 'Edit' }).click();

  // The radio the record implies, and the path it names. Pinned to the exact path rather
  // than "not empty": the field defaulting to something would pass that.
  await expect(page.getByRole('radio', { name: /public key/i })).toBeChecked();
  await expect(page.getByTestId('auth-key-path')).toHaveValue('/home/someone/.ssh/id_edit_test');
  // This machine has no passphrase, so nothing claims one is held and the box is unticked.
  await expect(page.getByTestId('auth-passphrase-stored')).toHaveCount(0);
  await expect(page.getByTestId('auth-remember-passphrase')).not.toBeChecked();

  // A click outside used to throw the whole form away — including, in the desktop shell,
  // the click that dismisses a native `<select>`'s popup, which is how choosing a jump
  // host closed the dialog. The form is still here.
  await page.locator('.m-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('auth-key-path')).toBeVisible();
  // Esc is the way out instead, and it is deliberate.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('auth-key-path')).toHaveCount(0);
});

/**
 * The other half of the box: a machine that does hold a passphrase says so.
 *
 * An empty field beside a ticked "remember this passphrase" is a contradiction, and an
 * empty field beside an unticked one is a lie. Neither is fixed by showing the secret:
 * the row states that one is held and the field shows the same dots the password field
 * shows, which is what tells you there is something to forget.
 */
test('a machine that holds a passphrase says so without showing it', async ({ page, request }) => {
  const collectionId = await createCollection(request, 'e2e-pass-shown');
  await createMachine(request, collectionId, {
    name: 'e2e-pass-shown-host',
    keyPath: '/home/someone/.ssh/id_shown',
    passphrase: 'do-not-render-this',
  });

  await page.goto('/');
  const row = page.locator('.m-tnode.leaf', { hasText: 'e2e-pass-shown-host' });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button', { name: 'Edit' }).click();

  await expect(page.getByTestId('auth-remember-passphrase')).toBeChecked();
  await expect(page.getByTestId('auth-passphrase-stored')).toBeVisible();
  // Said, not shown: the field is empty and the secret is nowhere on the page.
  await expect(page.getByTestId('auth-passphrase')).toHaveValue('');
  await expect(page.getByTestId('auth-passphrase')).toHaveAttribute('placeholder', '••••••••');
  await expect(page.getByText('do-not-render-this')).toHaveCount(0);
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
  expect(await (await request.get(`/api/local/collections/${collectionId}/board`)).json()).toEqual(
    [],
  );
  const cards = [
    { id: 'b1', type: 'link', title: 'Grafana', url: 'https://grafana.secret.example' },
    { id: 'b2', type: 'note', title: 'Scrub', text: 'sunday 03:00' },
  ];
  const saved = await request.put(`/api/local/collections/${collectionId}/board`, { data: cards });
  expect(saved.ok()).toBeTruthy();
  expect(await (await request.get(`/api/local/collections/${collectionId}/board`)).json()).toEqual(
    cards,
  );
  // hasBoard is what the sidebar uses to show the indicator.
  const withBoard = (await (await request.get('/api/local/collections')).json()).find(
    (c: { id: string }) => c.id === collectionId,
  );
  expect(withBoard.hasBoard).toBe(true);

  // An empty array clears it, matching the browser — one state, not two.
  await request.put(`/api/local/collections/${collectionId}/board`, { data: [] });
  expect(await (await request.get(`/api/local/collections/${collectionId}/board`)).json()).toEqual(
    [],
  );
});
