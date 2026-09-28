import { test, expect, type Page } from '@playwright/test';
import { createCollection, createMachine, listMachines } from './support/localVault';

/**
 * A local vault has collections but no collaboration (ADR 0018). Unifying the two
 * storage models made every collection surface appear locally, and the dialogs
 * behind some of them are accounts-only: they seal keys to members and read a
 * session keypair a vault does not have. So the rule this file guards is that
 * nothing about members, roles or sharing is reachable in a vault — not as a dead
 * menu entry, and above all not as a dialog asking for a username.
 */

/** The sidebar row for a collection, matched on its exact name (the span's title). */
const row = (page: Page, name: string) =>
  page.locator('.m-tnode').filter({ has: page.getByTitle(name, { exact: true }) });

/** Dismiss an open floating menu by clicking its click-away overlay. */
const clickAway = (page: Page) =>
  page.locator('div.fixed.inset-0.z-10').first().click({ position: { x: 4, y: 4 } });

test('a local collection exposes nothing about members or sharing', async ({ page, request }) => {
  const collectionId = await createCollection(request, 'e2e-solo');
  await createMachine(request, collectionId, { name: 'e2e-solo-machine' });

  await page.goto('/');
  const coll = row(page, 'e2e-solo');
  await expect(coll).toBeVisible({ timeout: 15_000 });

  // The collection's ⋯ menu: Board, rename, delete — no "Members & sharing…".
  await coll.hover();
  await coll.getByRole('button', { name: 'Collection menu' }).click();
  await expect(page.getByRole('button', { name: 'Board…' })).toBeVisible();
  await expect(page.getByText(/Members & sharing/)).toHaveCount(0);
  await clickAway(page);

  // Drilling in: the header carries no Members button, and no role pill — a role
  // means nothing where there is only ever one member.
  await coll.click();
  await expect(page.getByRole('heading', { name: 'e2e-solo', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Members' })).toHaveCount(0);
  await expect(page.getByText('owner', { exact: true })).toHaveCount(0);
});

test('creating a collection in a vault asks for a name, not for members', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add to library' }).click();
  await page.getByRole('button', { name: 'New collection…' }).click();

  // The plain name/colour form (CollectionEditDialog), not the MemberPicker.
  await expect(page.getByRole('heading', { name: 'New collection' })).toBeVisible();
  const nameField = page.getByPlaceholder('e.g. Production DBs');
  await expect(nameField).toBeVisible();
  await expect(page.getByPlaceholder('type a username')).toHaveCount(0);
  await expect(page.getByText(/Add someone/)).toHaveCount(0);

  // And it really creates it — through the core, which wraps the keys with the
  // master key; nothing here could have sealed them to anybody.
  await nameField.fill('e2e-from-ui');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(row(page, 'e2e-from-ui')).toBeVisible({ timeout: 10_000 });
});

test('a folder created from the UI lands in the collection header', async ({ page, request }) => {
  const collectionId = await createCollection(request, 'e2e-solo-folders');

  await page.goto('/');
  const coll = row(page, 'e2e-solo-folders');
  await expect(coll).toBeVisible({ timeout: 15_000 });
  await coll.hover();
  await coll.getByRole('button', { name: 'Add to collection' }).click();
  await page.getByRole('button', { name: 'New folder' }).click();
  await expect(page.getByRole('heading', { name: 'New folder' })).toBeVisible();
  await page.getByPlaceholder('e.g. Web servers').fill('Hypervisors');
  await page.getByRole('button', { name: 'Create' }).click();

  // The header is what proves it: rite-core rewrote it with the master key, so an
  // empty folder survives instead of being derived from a machine that mentions it.
  await expect
    .poll(
      async () => {
        const cols = await (await request.get('/api/local/collections')).json();
        const mine = cols.find((c: { id: string }) => c.id === collectionId);
        return ((mine?.folders ?? []) as { name: string }[]).map((f) => f.name);
      },
      { timeout: 10_000 },
    )
    .toContain('Hypervisors');
});

test('renaming a folder moves the machines that were in it', async ({ page, request }) => {
  const collectionId = await createCollection(request, 'e2e-solo-rename');
  await request.put(`/api/local/collections/${collectionId}`, {
    data: { name: 'e2e-solo-rename', folders: [{ name: 'Old', color: null }] },
  });
  await createMachine(request, collectionId, { name: 'e2e-solo-moved', folder: 'Old' });

  await page.goto('/');
  const coll = row(page, 'e2e-solo-rename');
  await expect(coll).toBeVisible({ timeout: 15_000 });
  const expand = coll.getByRole('button', { name: 'Expand' });
  if (await expand.count()) await expand.click();

  const folder = page.locator('.m-tnode').filter({ has: page.locator('span.m-nm', { hasText: /^Old$/ }) });
  await folder.hover();
  await folder.getByRole('button', { name: 'Folder menu' }).click();
  await page.getByRole('button', { name: 'Rename…' }).click();
  await expect(page.getByRole('heading', { name: 'Rename folder' })).toBeVisible();
  await page.getByPlaceholder('e.g. Web servers').fill('New');
  await page.getByRole('button', { name: 'Save' }).click();

  // The header follows the rename — and so does the machine. A folder that only
  // moved in the header would leave its machines pointing at a path that is gone.
  // Both are polled together: the header is written first, so asserting the machine
  // right after the header lands would race the write that re-tags it.
  await expect
    .poll(
      async () => {
        const cols = await (await request.get('/api/local/collections')).json();
        const mine = cols.find((c: { id: string }) => c.id === collectionId);
        const folders = ((mine?.folders ?? []) as { name: string }[]).map((f) => f.name);
        const machines = await listMachines(request, collectionId);
        return { folders, machines: machines.map((m) => m.folder) };
      },
      { timeout: 10_000 },
    )
    .toEqual({ folders: ['New'], machines: ['New'] });
});
