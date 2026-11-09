import { test, expect } from '@playwright/test';
import { ensureCollection, listMachines } from './support/localVault';

/**
 * THE FIELD THAT PUTS A LABEL ON SOMETHING, driven the way a person drives it.
 *
 * It had no screen coverage at all, and the bill came in as a question from the person who
 * commissioned it: "how do I add a label to a conversation?" The field was a
 * comma-separated text box. It could not say which words were already on the thing, it
 * offered no way to take one off short of editing a string around the commas, and the
 * only thing that had ever driven it was the desktop bench — which is manual.
 *
 * WHY THE MACHINE FORM AND NOT THE AGENT PANEL. It is the same component on both screens
 * (`components/Labels.tsx`), and this is the one a browser can reach: the agent manager
 * offers no local machine to a browser, so its conversations need a probe over SSH into
 * the harness. Same field, same gestures, reachable here.
 */

const open = async (page: import('@playwright/test').Page, collection: string) => {
  await page.goto('/');
  const node = page.locator('.m-tnode', { hasText: collection }).first();
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.getByRole('button', { name: 'Add to collection' }).click();
  await page.getByRole('button', { name: 'New machine here' }).click();
  // THE FIELD IS BEHIND A COLLAPSED <details>, which is how this spec found out: the
  // first assertion timed out with the form open and no labels anywhere on it. Expanded
  // here rather than worked around, so the test drives what a person sees — and the
  // placement is its own question, raised separately.
  await page.getByText('Advanced Options').click();
  await expect(page.getByTestId('machine-labels-input')).toBeVisible();
};

test('a word in no vocabulary is still reachable, and only when asked for', async ({
  page,
  request,
}) => {
  await ensureCollection(request, 'e2e-field');
  await open(page, 'e2e-field');

  // Nothing on it, nothing declared: the list says so rather than being an empty box.
  await expect(page.getByTestId('machine-labels-count')).toHaveText('0 of 8');
  await expect(page.getByTestId('machine-labels-on')).toHaveCount(0);

  // TYPING ALONE ADDS NOTHING. The box filters; creating is a named action under the
  // list, because a picker that creates as a side effect of typing is how `api` and
  // `api,` became two words.
  await page.getByTestId('machine-labels-input').fill('pci');
  await expect(page.getByTestId('machine-labels-on')).toHaveCount(0);
  await expect(page.getByTestId('machine-labels-create')).toBeVisible();
  await page.getByTestId('machine-labels-create').click();

  await expect(page.getByTestId('machine-labels-on')).toContainText('pci');
  await expect(page.getByTestId('machine-labels-count')).toHaveText('1 of 8');
  // The word it created is a row now, and the row is the marked one.
  await expect(page.getByTestId('machine-labels-on-pci')).toBeVisible();
  // And it is no longer offered as something to create, which would be a second control
  // for what the row above already does.
  await expect(page.getByTestId('machine-labels-create')).toHaveCount(0);
});

test('a label comes off, by the chip and by its row', async ({ page, request }) => {
  await ensureCollection(request, 'e2e-field');
  await open(page, 'e2e-field');

  for (const word of ['api', 'web']) {
    await page.getByTestId('machine-labels-input').fill(word);
    await page.getByTestId('machine-labels-create').click();
  }
  await expect(page.getByTestId('machine-labels-count')).toHaveText('2 of 8');

  // THE × ON THE CHIP, which is the gesture the field had no equivalent of at all.
  await page.getByTestId('machine-labels-off-web').click();
  await expect(page.getByTestId('machine-labels-count')).toHaveText('1 of 8');
  await expect(page.getByTestId('machine-labels-on')).not.toContainText('web');
  // The word stays in the list — it is still a word this vault knows, and a row that
  // vanished mid-gesture would make taking one off feel like deleting it.
  await expect(page.getByTestId('machine-labels-row-web')).toBeVisible();
  await expect(page.getByTestId('machine-labels-on-web')).toHaveCount(0);

  // And the row is the other half of the same list: one read answers "what is on this"
  // and "what else could be", which two groups never did.
  await page.getByTestId('machine-labels-row-web').click();
  await expect(page.getByTestId('machine-labels-on-web')).toBeVisible();
  await page.getByTestId('machine-labels-row-web').click();
  await expect(page.getByTestId('machine-labels-on-web')).toHaveCount(0);
});

test('the search narrows the list, over the word and over what it means', async ({
  page,
  request,
}) => {
  const collection = await ensureCollection(request, 'e2e-field-search');
  // A declared vocabulary, which is what a search is for: three words, one of them with a
  // description that does not contain the word being searched for.
  await request.put(`/api/local/collections/${collection}`, {
    data: {
      name: 'e2e-field-search',
      labels: [
        { label: 'pci', description: 'Card data in scope' },
        { label: 'prod', description: 'Serving real traffic' },
        'staging',
      ],
    },
  });
  await open(page, 'e2e-field-search');

  await expect(page.getByTestId('machine-labels-row-pci')).toBeVisible();
  await expect(page.getByTestId('machine-labels-row-prod')).toBeVisible();
  await expect(page.getByTestId('machine-labels-row-staging')).toBeVisible();

  // The description is ON the row, which is the only place it can do its job: the word is
  // picked by somebody who did not declare it.
  await expect(page.getByTestId('machine-labels-row-pci')).toContainText('Card data in scope');

  await page.getByTestId('machine-labels-input').fill('pro');
  await expect(page.getByTestId('machine-labels-row-prod')).toBeVisible();
  await expect(page.getByTestId('machine-labels-row-pci')).toHaveCount(0);

  // MATCHED ON THE DESCRIPTION TOO, because a description is why somebody searches for a
  // word they cannot remember the spelling of. "card" is in no label here.
  await page.getByTestId('machine-labels-input').fill('card');
  await expect(page.getByTestId('machine-labels-row-pci')).toBeVisible();
  await expect(page.getByTestId('machine-labels-row-prod')).toHaveCount(0);
  // `card` is still offered as a word to create, and that is right: it matched a
  // DESCRIPTION, so nothing is called `card` yet. What must not be offered twice is a
  // word that already has a row, which the next lines hold.
  await expect(page.getByTestId('machine-labels-create')).toBeVisible();
  await page.getByTestId('machine-labels-input').fill('pci');
  await expect(page.getByTestId('machine-labels-create')).toHaveCount(0);
  // AND FOLDED: a word is one word whatever case it is typed in, so a declared `pci` is
  // picked rather than created when `PCI` is typed.
  await page.getByTestId('machine-labels-input').fill('PCI');
  await expect(page.getByTestId('machine-labels-row-pci')).toBeVisible();
  await expect(page.getByTestId('machine-labels-create')).toHaveCount(0);

  await page.getByTestId('machine-labels-input').fill('nothing-is-called-this');
  await expect(page.getByTestId('machine-labels-list')).toContainText('nothing-is-called-this');
  await expect(page.getByTestId('machine-labels-create')).toBeVisible();
});

test('the cap is a count before it bites, and the rows say so when it does', async ({
  page,
  request,
}) => {
  await ensureCollection(request, 'e2e-field-cap');
  await open(page, 'e2e-field-cap');

  for (const word of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']) {
    await page.getByTestId('machine-labels-input').fill(word);
    await page.getByTestId('machine-labels-create').click();
  }
  await expect(page.getByTestId('machine-labels-count')).toHaveText('7 of 8');
  await expect(page.getByTestId('machine-labels-row-a1')).toBeEnabled();

  await page.getByTestId('machine-labels-input').fill('a8');
  await page.getByTestId('machine-labels-create').click();
  await expect(page.getByTestId('machine-labels-count')).toHaveText('8 of 8');

  // DIM, NOT ABSENT. The word is still in the vocabulary and the reason is the count,
  // which is on screen — a row that disappeared at the cap would read as the word being
  // gone. A row already on stays live, because taking one off is the way out.
  await page.getByTestId('machine-labels-input').fill('a9');
  await expect(page.getByTestId('machine-labels-create')).toBeDisabled();
  await page.getByTestId('machine-labels-input').fill('');
  await expect(page.getByTestId('machine-labels-row-a1')).toBeEnabled();

  await page.getByTestId('machine-labels-off-a1').click();
  await expect(page.getByTestId('machine-labels-count')).toHaveText('7 of 8');
});

test('what the field held is what the record carries', async ({ page, request }) => {
  const collection = await ensureCollection(request, 'e2e-field-save');
  await open(page, 'e2e-field-save');

  await page.getByPlaceholder('My Server').fill('e2e-field-machine');
  await page.getByPlaceholder('example.com or 192.168.1.1').fill('example.com');
  await page.getByPlaceholder('user').fill('someone');
  // Required, and the form is right to refuse without it — which is how this test found
  // out that it was testing the save and not only the field.
  await page.getByPlaceholder('Password').fill('not-a-real-password');

  // The case that was TYPED is what is kept: folding happens when words are compared,
  // never when they are stored. WORDS NOTHING ELSE DECLARES, because `labelOffers` spans
  // every collection in the vault — `pci` is on offer here thanks to another spec, and a
  // word already on offer is picked rather than created.
  for (const word of ['saveme', 'SAVEME-TOO']) {
    await page.getByTestId('machine-labels-input').fill(word);
    await page.getByTestId('machine-labels-create').click();
  }
  await page.getByRole('button', { name: /save connection/i }).click();
  await expect(page.getByText('e2e-field-machine').first()).toBeVisible({ timeout: 15_000 });

  const machines = (await listMachines(request, collection)) as unknown as {
    name: string;
    labels: string[];
  }[];
  expect(machines.find((m) => m.name === 'e2e-field-machine')?.labels).toEqual([
    'saveme',
    'SAVEME-TOO',
  ]);
});

test('a declared word is picked in the spelling it was declared in', async ({ page, request }) => {
  const collection = await ensureCollection(request, 'e2e-field-spelling');
  await request.put(`/api/local/collections/${collection}`, {
    data: { name: 'e2e-field-spelling', labels: ['Postgres'] },
  });
  await open(page, 'e2e-field-spelling');

  // Typed in another case, and what goes on the machine is the DECLARED spelling — the
  // vocabulary is what names the word, so one word cannot end up stored three ways.
  await page.getByTestId('machine-labels-input').fill('postgres');
  await expect(page.getByTestId('machine-labels-create')).toHaveCount(0);
  await page.getByTestId('machine-labels-row-postgres').click();
  await expect(page.getByTestId('machine-labels-on')).toContainText('Postgres');

  await page.getByPlaceholder('My Server').fill('e2e-spelling-machine');
  await page.getByPlaceholder('example.com or 192.168.1.1').fill('example.com');
  await page.getByPlaceholder('user').fill('someone');
  await page.getByPlaceholder('Password').fill('not-a-real-password');
  await page.getByRole('button', { name: /save connection/i }).click();
  await expect(page.getByText('e2e-spelling-machine').first()).toBeVisible({ timeout: 15_000 });

  const machines = (await listMachines(request, collection)) as unknown as {
    name: string;
    labels: string[];
  }[];
  expect(machines.find((m) => m.name === 'e2e-spelling-machine')?.labels).toEqual(['Postgres']);
});
