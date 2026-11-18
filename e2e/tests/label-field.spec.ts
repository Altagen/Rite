import { test, expect } from '@playwright/test';
import { createMachine, ensureCollection, listMachines } from './support/localVault';

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

/**
 * Open the dropdown. The list used to be permanently expanded and is a popover now, so a
 * test that wants a row says so — which is also the assertion that it is CLOSED until
 * somebody asks, the whole reason for the change.
 */
const openList = async (page: import('@playwright/test').Page) => {
  await page.getByTestId('machine-labels-input').click();
  await expect(page.getByTestId('machine-labels-list')).toBeVisible();
};

/**
 * Declare words on a collection — the only way a word gets into the vocabulary now.
 *
 * The field invented words until 0.2.9 and most of this spec seeded itself through it.
 * It cannot any more (`components/Labels.tsx`): a word is declared in one page per
 * scope, by somebody entitled to, and the picker only ever offers what has been. So the
 * fixture declares, which is also what a reader does.
 */
const declare = async (
  request: import('@playwright/test').APIRequestContext,
  collection: string,
  name: string,
  labels: (string | { label: string; description?: string })[],
) => {
  const res = await request.put(`/api/local/collections/${collection}`, {
    data: { name, labels },
  });
  expect(res.ok(), `declaring ${labels.length} words: ${res.status()}`).toBeTruthy();
};

const open = async (page: import('@playwright/test').Page, collection: string) => {
  await page.goto('/');
  const node = page.locator('.m-tnode', { hasText: collection }).first();
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.getByRole('button', { name: 'Add to collection' }).click();
  await page.getByRole('button', { name: 'New machine here' }).click();
  // VISIBLE WITHOUT UNFOLDING ANYTHING, which this spec is the reason for: it used to
  // have to click "Advanced Options" to reach the field, and a test that works around a
  // placement is a test that endorses it. A label is how a machine is found again, so it
  // sits with the name and the host now.
  await expect(page.getByTestId('machine-labels-input')).toBeVisible();
  await expect(page.getByText('Advanced Options')).toBeVisible();
  await expect(
    page.locator('details', { hasText: 'Advanced Options' }).getByTestId('machine-labels-input'),
    'labels must not be inside the collapsed section',
  ).toHaveCount(0);
};

test('the box filters, and a word nobody declared cannot be invented here', async ({
  page,
  request,
}) => {
  const collection = await ensureCollection(request, 'e2e-field');
  await declare(request, collection, 'e2e-field', ['fieldonly-one', 'fieldonly-two']);
  await open(page, 'e2e-field');

  // Nothing is ON it, and THE LIST IS CLOSED — which is what the dropdown bought: a form
  // with ten fields does not carry a two-hundred-pixel box for a field nobody is using.
  await expect(page.getByTestId('machine-labels-count')).toHaveText('0 of 8');
  await expect(page.getByTestId('machine-labels-on')).toHaveCount(0);
  await expect(page.getByTestId('machine-labels-list')).toHaveCount(0);

  // THE BOX FILTERS, AND THAT IS ALL IT DOES. Typing narrows the declared list; it adds
  // nothing, offers nothing to add, and Enter on a word nobody declared does nothing —
  // a word is declared in one page per scope, never invented in a form.
  await page.getByTestId('machine-labels-input').fill('fieldonly-t');
  await expect(page.getByTestId('machine-labels-row-fieldonly-two')).toBeVisible();
  await expect(page.getByTestId('machine-labels-row-fieldonly-one')).toHaveCount(0);
  await expect(page.getByTestId('machine-labels-on')).toHaveCount(0);

  await page.getByTestId('machine-labels-input').fill('nothing-is-called-this');
  await expect(page.getByTestId('machine-labels-list')).toContainText('nothing-is-called-this');
  await expect(
    page.getByTestId('machine-labels-create'),
    'the field must offer no way to invent a word',
  ).toHaveCount(0);
  await page.getByTestId('machine-labels-input').press('Enter');
  await expect(page.getByTestId('machine-labels-count')).toHaveText('0 of 8');
  await expect(page.getByTestId('machine-labels-on')).toHaveCount(0);

  // And one row left after filtering is the one Enter takes, which is the only thing it
  // has ever done that is not a guess.
  await page.getByTestId('machine-labels-input').fill('fieldonly-two');
  await page.getByTestId('machine-labels-input').press('Enter');
  await expect(page.getByTestId('machine-labels-on')).toContainText('fieldonly-two');
  await expect(page.getByTestId('machine-labels-count')).toHaveText('1 of 8');
  await expect(page.getByTestId('machine-labels-on-fieldonly-two')).toBeVisible();
});

/**
 * THE FIELD SAYS WHERE A WORD IS DECLARED, since it no longer declares one itself.
 *
 * Removing the create action left the reader with a question the screen had stopped
 * answering: where, then? The foot of the list answers it, and the answer is a WAY IN
 * rather than a direction — the collection's own vocabulary opens as a dialog above this
 * form, so everything typed into it is still there afterwards. A link that navigated
 * would cost somebody a half-filled machine, which is the exact loss this form already
 * refuses to take on a stray backdrop click.
 */
test('the list says where a word is declared, and getting there costs nothing', async ({
  page,
  request,
}) => {
  const collection = await ensureCollection(request, 'e2e-field-declare');
  await declare(request, collection, 'e2e-field-declare', ['already-there']);
  await open(page, 'e2e-field-declare');

  // Something typed, to be sure it survives the detour.
  await page.getByPlaceholder('My Server').fill('e2e-declare-machine');
  await openList(page);

  const declareRow = page.getByTestId('machine-labels-declare');
  await expect(declareRow).toBeVisible();
  // It names the place rather than saying "manage": the reader has to know WHICH
  // vocabulary is about to open, because a word in the wrong scope is read by the wrong
  // people.
  await expect(declareRow).toContainText('e2e-field-declare');

  await declareRow.click();
  const manager = page.getByTestId('collection-labels-dialog');
  await expect(manager).toBeVisible();

  // Declare one from there, which is the whole point of the pointer.
  await manager.getByTestId('label-manager-new').click();
  await manager.getByTestId('label-row-word').fill('from-the-field');
  await manager.getByTestId('label-row-done').click();
  await manager.getByTestId('label-manager-save').click();
  // ESCAPE, AND NOT ITS OWN CLOSE, because Escape is what a person presses and it was the
  // one key this arrangement could not survive. The machine form listens for it on
  // `document`, so until this was fixed the form's handler is the one that answered: the
  // dialog stayed open, the half-filled form was unmounted, and everything typed into it
  // went with it — the exact loss the declare link exists to prevent. The top layer owns
  // the key now (`escapeDisabled` on `<ConnectionForm>`), and the next two assertions are
  // what says so.
  await page.keyboard.press('Escape');
  await expect(manager).toHaveCount(0);

  // THE FORM IS STILL THERE, STILL FILLED. This is the assertion the shape was chosen
  // for: the dialog opened OVER it, so nothing was unmounted and nothing was typed twice.
  await expect(page.getByPlaceholder('My Server')).toHaveValue('e2e-declare-machine');

  // And the word it declared is on offer now, without a reload.
  await openList(page);
  await expect(page.getByTestId('machine-labels-row-from-the-field')).toBeVisible();
});

test('a label comes off, by the chip and by its row', async ({ page, request }) => {
  const collection = await ensureCollection(request, 'e2e-field-off');
  await declare(request, collection, 'e2e-field-off', ['api', 'web']);
  await open(page, 'e2e-field-off');

  await openList(page);
  for (const word of ['api', 'web']) {
    await page.getByTestId(`machine-labels-row-${word}`).click();
  }
  await expect(page.getByTestId('machine-labels-count')).toHaveText('2 of 8');

  // THE × ON THE CHIP, which is the gesture the field had no equivalent of at all.
  await page.getByTestId('machine-labels-off-web').click();
  await expect(page.getByTestId('machine-labels-count')).toHaveText('1 of 8');
  await expect(page.getByTestId('machine-labels-on')).not.toContainText('web');
  // The word stays in the list — it is still a word this vault knows, and a row that
  // vanished mid-gesture would make taking one off feel like deleting it.
  await openList(page);
  await expect(page.getByTestId('machine-labels-row-web')).toBeVisible();
  await expect(page.getByTestId('machine-labels-on-web')).toHaveCount(0);

  // And the row is the other half of the same list: one read answers "what is on this"
  // and "what else could be", which two groups never did.
  await page.getByTestId('machine-labels-row-web').click();
  await expect(page.getByTestId('machine-labels-on-web')).toBeVisible();
  // AND IT STAYS OPEN while several words are ticked: the wrapper's `onBlur` checks
  // whether the focus went to a row inside it, so one visit can put three labels on.
  await expect(page.getByTestId('machine-labels-list')).toBeVisible();
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
      // PREFIXED, because `labelOffers` gathers the instance's words FIRST and keeps the
      // first spelling it sees — so a collection word whose name an instance word already
      // has is offered without this description, and the assertion below would be reading
      // the other spec's `pci`. Inheritance running one way is the documented behaviour;
      // the fixture has to stop colliding with it.
      labels: [
        { label: 'fs-pci', description: 'Card data in scope' },
        { label: 'fs-prod', description: 'Serving real traffic' },
        'fs-staging',
      ],
    },
  });
  await open(page, 'e2e-field-search');
  await openList(page);

  await expect(page.getByTestId('machine-labels-row-fs-pci')).toBeVisible();
  await expect(page.getByTestId('machine-labels-row-fs-prod')).toBeVisible();
  await expect(page.getByTestId('machine-labels-row-fs-staging')).toBeVisible();

  // The description is ON the row, which is the only place it can do its job: the word is
  // picked by somebody who did not declare it.
  await expect(page.getByTestId('machine-labels-row-fs-pci')).toContainText('Card data in scope');

  await page.getByTestId('machine-labels-input').fill('fs-pro');
  await expect(page.getByTestId('machine-labels-row-fs-prod')).toBeVisible();
  await expect(page.getByTestId('machine-labels-row-fs-pci')).toHaveCount(0);

  // MATCHED ON THE DESCRIPTION TOO, because a description is why somebody searches for a
  // word they cannot remember the spelling of. "card" is in no label here.
  await page.getByTestId('machine-labels-input').fill('card');
  await expect(page.getByTestId('machine-labels-row-fs-pci')).toBeVisible();
  await expect(page.getByTestId('machine-labels-row-fs-prod')).toHaveCount(0);
  // Matching a DESCRIPTION and matching nothing read the same way now: the list says
  // what was searched for and offers nothing to add. Nothing is called `card`, and that
  // is not this field's problem to solve.
  await expect(page.getByTestId('machine-labels-create')).toHaveCount(0);

  // AND FOLDED: a word is one word whatever case it is typed in, so `FS-PCI` finds the
  // row that was declared `fs-pci` rather than reading as a word nobody has.
  await page.getByTestId('machine-labels-input').fill('FS-PCI');
  await expect(page.getByTestId('machine-labels-row-fs-pci')).toBeVisible();

  await page.getByTestId('machine-labels-input').fill('nothing-is-called-this');
  await expect(page.getByTestId('machine-labels-list')).toContainText('nothing-is-called-this');
  await expect(page.getByTestId('machine-labels-create')).toHaveCount(0);
});

test('the cap is a count before it bites, and the rows say so when it does', async ({
  page,
  request,
}) => {
  const collection = await ensureCollection(request, 'e2e-field-cap');
  // Nine declared, one more than a thing may carry, so the cap and the ninth row are
  // both real here.
  await declare(request, collection, 'e2e-field-cap', [
    'a1',
    'a2',
    'a3',
    'a4',
    'a5',
    'a6',
    'a7',
    'a8',
    'a9',
  ]);
  await open(page, 'e2e-field-cap');

  await openList(page);
  for (const word of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']) {
    await page.getByTestId(`machine-labels-row-${word}`).click();
  }
  await expect(page.getByTestId('machine-labels-count')).toHaveText('7 of 8');
  await expect(page.getByTestId('machine-labels-row-a1')).toBeEnabled();

  await page.getByTestId('machine-labels-row-a8').click();
  await expect(page.getByTestId('machine-labels-count')).toHaveText('8 of 8');

  // DIM, NOT ABSENT. The word is still in the vocabulary and the reason is the count,
  // which is on screen — a row that disappeared at the cap would read as the word being
  // gone. A row already on stays live, because taking one off is the way out.
  await expect(page.getByTestId('machine-labels-row-a9')).toBeDisabled();
  await expect(page.getByTestId('machine-labels-row-a1')).toBeEnabled();

  await page.getByTestId('machine-labels-off-a1').click();
  await expect(page.getByTestId('machine-labels-count')).toHaveText('7 of 8');
});

test('what the field held is what the record carries', async ({ page, request }) => {
  const collection = await ensureCollection(request, 'e2e-field-save');
  await declare(request, collection, 'e2e-field-save', ['saveme', 'SAVEME-TOO']);
  await open(page, 'e2e-field-save');

  await page.getByPlaceholder('My Server').fill('e2e-field-machine');
  await page.getByPlaceholder('example.com or 192.168.1.1').fill('example.com');
  await page.getByPlaceholder('user').fill('someone');
  // Required, and the form is right to refuse without it — which is how this test found
  // out that it was testing the save and not only the field.
  await page.getByPlaceholder('Password').fill('not-a-real-password');

  // The case it was DECLARED in is what is kept: folding happens when words are compared,
  // never when they are stored. Two spellings, one of them shouted, both picked from the
  // list — and the record carries them as the list has them.
  await openList(page);
  await page.getByTestId('machine-labels-row-saveme').click();
  await page.getByTestId('machine-labels-row-saveme-too').click();
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

/**
 * THE LIST UNFOLDS IN FLOW AND IS NOT CLIPPED, which a popover could not manage here.
 *
 * The field sits inside a dialog whose body scrolls, and a scrolling box clips an
 * absolutely-positioned child: the first version opened and was cut off after one row,
 * with the paragraph underneath showing through beside it. No z-index reaches that — the
 * clip is the overflow, not the stacking order. Held as a measurement against the nearest
 * scrolling ancestor rather than as a screenshot, because what went wrong is geometry.
 */
test('the list is not cut off by the dialog that scrolls, and stops at six rows', async ({
  page,
  request,
}) => {
  const collection = await ensureCollection(request, 'e2e-field-tall');
  // More words than the list can show, so the cap and the scroll are both real here.
  await request.put(`/api/local/collections/${collection}`, {
    data: {
      name: 'e2e-field-tall',
      labels: ['t-a', 't-b', 't-c', 't-d', 't-e', 't-f', 't-g', 't-h', 't-i', 't-j'],
    },
  });
  await open(page, 'e2e-field-tall');
  await openList(page);

  const list = page.getByTestId('machine-labels-list');
  // SIX ROWS OF HEIGHT, then it scrolls inside itself: a list that grew with the
  // vocabulary would push Save off the bottom of the dialog on the two-hundredth word.
  const height = (await list.boundingBox())!.height;
  expect(height, 'the list must not grow with the vocabulary').toBeLessThanOrEqual(190);
  expect(
    await list.evaluate((el) => el.scrollHeight > el.clientHeight),
    'and the rest must be reachable by scrolling it',
  ).toBe(true);

  // NOT CLIPPED by whatever scrolls above it — the defect this test exists for.
  const cutBy = await list.evaluate((el) => {
    const r = el.getBoundingClientRect();
    let a = el.parentElement;
    while (a) {
      const s = getComputedStyle(a);
      if (/auto|scroll|hidden/.test(s.overflowY)) {
        const ar = a.getBoundingClientRect();
        return r.bottom > ar.bottom + 1 ? Math.round(r.bottom - ar.bottom) : 0;
      }
      a = a.parentElement;
    }
    return 0;
  });
  expect(cutBy, 'the list is cut off by a scrolling ancestor').toBe(0);
});

/**
 * A TAG IS A TAG, WHATEVER IT WAS LAST PUT ON.
 *
 * There were two vocabularies, split by the KIND of thing being labelled: a machine's
 * form was offered the instance's words, its collections' and the ones on machines; a
 * conversation's dialog was offered the instance's words and the ones on conversations.
 * So a word put on a machine was never offered on a conversation and the reverse, and on
 * a vault where only machines had been labelled the agent dialog opened onto an empty
 * list — which reads exactly like a picker that will not open.
 *
 * The scope decides WHO MAY READ a word. It has never decided what the word may be put
 * on, and splitting the offers that way made the picker forget half of what this person
 * already uses. One vocabulary now, built once by the shell.
 */
test('a word used on a machine is offered on a conversation, and the reverse', async ({
  page,
  request,
}) => {
  const collection = await ensureCollection(request, 'e2e-shared-vocab');
  // A word that exists ONLY because a machine wears it: nothing declares it anywhere.
  //
  // Through the route rather than through `createMachine`, which takes no `labels` and
  // drops one silently — the first version of this test passed an option the helper
  // ignores, so it asserted against a machine with no labels at all and blamed the app.
  const machine = await createMachine(request, collection, { name: 'e2e-vocab-host' });
  const put = await request.put(`/api/local/collections/${collection}/machines/${machine}`, {
    data: { labels: ['wornbyamachine'] },
  });
  expect(put.ok(), `labelling the machine: ${put.status()}`).toBeTruthy();

  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });

  // The agent manager's own dialog is what has to offer it. It is reached with a probe,
  // so the cheap half of the assertion is made on the machine form first: the word is in
  // the shared vocabulary at all.
  await open(page, 'e2e-shared-vocab');
  await openList(page);
  await expect(
    page.getByTestId('machine-labels-row-wornbyamachine'),
    'a word on a machine must be in the one vocabulary',
  ).toBeVisible();

  // And a word that exists only because a CONVERSATION wears it goes the other way. The
  // marks document is this person's own, so it is written through the route the agent
  // manager writes it through rather than by driving a probe.
  // `/api/marks` and a `{version, marks}` document — the shape `marks-support.spec.ts`
  // already pins. `/api/user/marks` is the accounts variant and answers nothing here.
  const doc = JSON.stringify({
    version: 1,
    marks: [{ machine: '@local', tool: 'claude', id: 'e2e-vocab-chat', labels: ['wornbyachat'] }],
  });
  const wrote = await request.put('/api/marks', { data: { value: doc } });
  expect(wrote.ok(), `writing the marks: ${wrote.status()}`).toBeTruthy();

  await page.reload();
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await open(page, 'e2e-shared-vocab');
  await openList(page);
  await expect(
    page.getByTestId('machine-labels-row-wornbyachat'),
    'a word on a conversation must be offered on a machine too',
  ).toBeVisible();
});
