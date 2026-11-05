import { test, expect } from '@playwright/test';
import { openSettings } from './support/headerBar';
import { ensureCollection, createMachine } from './support/localVault';

/**
 * The label manager, DRIVEN THROUGH THE SCREEN.
 *
 * WHY AT THIS ALTITUDE. The routes were tested and passed while the section did not work:
 * the field applied the per-thing cap to a vocabulary, so the ninth word was dropped and
 * nothing said so. A route test cannot see a word that never reaches it, and the bug was in
 * a field — so the coverage was simply in the wrong place.
 *
 * NO PAGINATION IS ASSERTED HERE ON PURPOSE. The list arrives in one sealed blob and is
 * capped at two hundred, so the manager filters rather than paginates: pages over a list
 * already in memory can hide the row somebody searched for.
 */
test('a label is declared with a colour and a description, and survives a reload', async ({
  page,
  request,
}) => {
  // From a known state: these specs share one vault, so an empty-list assertion is
  // otherwise a claim about which file ran first.
  await request.put('/api/admin/labels', { data: { labels: [] } });
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await openSettings(page);
  await page.getByTestId('settings-nav-labels').click();
  await expect(page.getByTestId('label-manager')).toBeVisible();

  // Nothing touched, so there is nothing to write.
  await expect(page.getByTestId('label-manager-save')).toBeDisabled();

  // THE TWO CONTROLS MUST NOT READ AS ONE. A bare text box beside a New button was read
  // as a compose row — type here, press that — so the search says "Search" and carries a
  // magnifier, and New is the only filled button on the row. Held as a test because the
  // mistake was invisible to every assertion that already existed.
  await expect(page.getByTestId('label-manager-search')).toHaveAttribute('placeholder', /^Search/);
  // An empty list offers the one thing to do where the eye already is, rather than only
  // in a toolbar on a screen whose middle is blank.
  await expect(page.getByTestId('label-manager-new-empty')).toBeVisible();

  await page.getByTestId('label-manager-new').click();
  await page.getByTestId('label-row-word').fill('pci');
  await page.getByTestId('label-row-description').fill('PCI-DSS in scope');
  await page.getByTestId('label-row-colour-f7768e').click();
  await page.getByTestId('label-row-done').click();

  // The row is in the list and the draft makes Save mean something.
  await expect(page.getByTestId('label-row-pci')).toContainText('PCI-DSS in scope');
  await expect(page.getByTestId('label-manager-save')).toBeEnabled();
  await page.getByTestId('label-manager-save').click();
  await expect(page.getByTestId('label-manager-save')).toBeDisabled();
  await expect(page.getByTestId('label-manager-error')).toHaveCount(0);

  // AND IT IS STILL THERE AFTER A RELOAD, which is the only assertion that proves the row
  // reached its support rather than a React state that looked convincing.
  await page.reload();
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await openSettings(page);
  await page.getByTestId('settings-nav-labels').click();
  const row = page.getByTestId('label-row-pci');
  await expect(row).toContainText('PCI-DSS in scope');
  // The colour that was chosen, not the one derived from the text.
  await expect(row.getByTestId('label-pci')).toHaveCSS('color', 'rgb(247, 118, 142)');
});

/**
 * A VOCABULARY IS NOT A LIST ON ONE THING, and the cap is where that showed.
 *
 * Nine words, because eight would have passed against the per-thing cap this screen used
 * to apply.
 */
test('a vocabulary takes more words than one machine could carry, and filters', async ({
  page,
  request,
}) => {
  const nine = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india'];

  // FROM A KNOWN STATE. This spec shares one server and one vault with the others, so a
  // count is an assertion about which test ran first unless the list is cleared.
  await request.put('/api/admin/labels', { data: { labels: [] } });
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await openSettings(page);
  await page.getByTestId('settings-nav-labels').click();

  for (const word of nine) {
    await page.getByTestId('label-manager-new').click();
    await page.getByTestId('label-row-word').fill(word);
    await page.getByTestId('label-row-done').click();
  }
  for (const word of nine) await expect(page.getByTestId(`label-row-${word}`)).toBeVisible();
  await page.getByTestId('label-manager-save').click();
  await expect(page.getByTestId('label-manager-error')).toHaveCount(0);

  // The filter is what replaces pages: a word is found by typing it.
  await page.getByTestId('label-manager-search').fill('india');
  await expect(page.getByTestId('label-row-india')).toBeVisible();
  await expect(page.getByTestId('label-row-alpha')).toHaveCount(0);
  await page.getByTestId('label-manager-search').fill('');
  await expect(page.getByTestId('label-row-alpha')).toBeVisible();

  // And the count says what is left, rather than letting a New button go quiet.
  await expect(page.getByTestId('label-manager-count')).toContainText('191');
});

/**
 * One word per list, because every lookup folds the case and takes the first.
 *
 * Two rows for one word would make the second unreachable — and a refusal with no reason
 * reads as a button that does not work, so the clash says so where it happens.
 */
test('a word already in the list is refused, and says why', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await openSettings(page);
  await page.getByTestId('settings-nav-labels').click();

  await page.getByTestId('label-manager-new').click();
  await page.getByTestId('label-row-word').fill('prod');
  await page.getByTestId('label-row-done').click();

  await page.getByTestId('label-manager-new').click();
  // Typed in another case, because that is the case that gets through a naive check.
  await page.getByTestId('label-row-word').fill('PROD');
  await expect(page.getByTestId('label-row-clash')).toBeVisible();
  await expect(page.getByTestId('label-row-done')).toBeDisabled();
  await page.getByTestId('label-row-cancel').click();
  await expect(page.getByTestId('label-row-prod')).toBeVisible();
});

/**
 * A COLLECTION'S OWN WORDS ARE MANAGED ON THE COLLECTION, in both shells.
 *
 * The scope selector used to do this and it was the wrong answer: it did the job the
 * SURFACE should do, and it put an instance-level list and a per-collection one on one
 * screen. THE SURFACE FOLLOWS THE OWNER — a collection belongs to its members whether a
 * server is in the picture or not, so this half does not move; the instance's list is the
 * half that does (a person's settings locally, the admin console on a server).
 */
test("a collection declares its own words, and sees the instance's as inherited", async ({
  page,
  request,
}) => {
  const collection = await ensureCollection(request, 'e2e-label-surface');
  // A name that does not CONTAIN the collection's: sharing a prefix made one `getByText`
  // match two nodes, which is the test being ambiguous rather than the screen.
  await createMachine(request, collection, { name: 'e2e-vocab-box' });
  // A word owned above this collection, so the inherited half has something to show.
  await request.put('/api/admin/labels', { data: { labels: ['pci'] } });

  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  // The node that opens the collection, by its own handle: clicking the name text lands
  // on whatever child is under the cursor and can toggle instead of open.
  await page.getByTestId('lib-collection-e2e-label-surface').click();

  await page.getByTestId('cview-labels').click();
  const dialog = page.getByTestId('collection-labels-dialog');
  await expect(dialog).toBeVisible();
  // No scope selector: the surface already said which collection, which is the whole
  // reason one screen can serve every scope.
  await expect(dialog.getByTestId('label-manager-scope')).toHaveCount(0);

  // THE INSTANCE'S WORD IS VISIBLE AND NOT EDITABLE HERE — the answer to "where is `pci`
  // declared". Without it somebody declares it a second time, and every lookup folds and
  // takes the first, so the second would do nothing.
  await expect(dialog.getByTestId('label-manager-inherited')).toContainText('pci');
  await expect(dialog.getByTestId('label-row-pci')).toHaveCount(0);

  // And declaring it again is refused, with the reason.
  await dialog.getByTestId('label-manager-new').click();
  await dialog.getByTestId('label-row-word').fill('PCI');
  await expect(dialog.getByTestId('label-row-clash')).toBeVisible();
  await expect(dialog.getByTestId('label-row-done')).toBeDisabled();
  await dialog.getByTestId('label-row-word').fill('client-acme');
  await dialog.getByTestId('label-row-done').click();
  await dialog.getByTestId('label-manager-save').click();
  await expect(dialog.getByTestId('label-manager-error')).toHaveCount(0);

  // Kept, and kept IN the collection: reopening reads it back from the sealed header.
  await dialog.getByTestId('collection-labels-close').click();
  await page.getByTestId('cview-labels').click();
  await expect(page.getByTestId('label-row-client-acme')).toBeVisible();
});

/**
 * THE COLLECTION VIEW'S ACTION ROW HAS TO BE CLICKABLE, which it was not.
 *
 * Found while the labels button refused to open its dialog: a normal click hung and a
 * forced one landed on something else. `elementFromPoint` at each button's centre answered
 * the TERMINAL's tab strip — `relative z-10` with `pb-3 overflow-y-visible` — painting over
 * the top band of a `z-10` overlay. At every window width, and for every button in that
 * row: Board, Members, Check now, and the new one. Pre-existing, and nothing could see it,
 * because no test had ever clicked that row.
 *
 * Held with `elementFromPoint` rather than with a click, because a click that happens to
 * work tomorrow would not say WHY — and what broke was hit-testing, which is the thing
 * this reads directly.
 */
test('every button in a collection header receives its own clicks', async ({ page, request }) => {
  await ensureCollection(request, 'e2e-hit-test');
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('lib-collection-e2e-hit-test').click();
  await expect(page.getByTestId('cview-labels')).toBeVisible();

  // Scoped to the row the buttons are in, found from the one button that has a handle:
  // a sweep over every button on screen also catches the sidebar's nested ones, where a
  // hit on a child is normal and not a defect.
  const covered = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="cview-labels"]')?.parentElement;
    if (!row) return ['no row'];
    const out: string[] = [];
    for (const b of Array.from(row.querySelectorAll('button'))) {
      const r = b.getBoundingClientRect();
      if (r.width === 0) continue;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit !== b && !b.contains(hit)) out.push((b.textContent || '').trim().slice(0, 20));
    }
    return out;
  });
  expect(covered).toEqual([]);
});
