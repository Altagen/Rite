import { test, expect } from '@playwright/test';
import { openSettings } from './support/headerBar';
import { ensureCollection } from './support/localVault';

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
 * The scope selector is what lets one screen replace two editors.
 *
 * Switching it switches which document is written — and a draft belongs to the scope it
 * was typed in, so it does not travel.
 */
test('a collection is a scope of its own, and a draft does not cross', async ({
  page,
  request,
}) => {
  await ensureCollection(request, 'e2e-label-scope');

  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await openSettings(page);
  await page.getByTestId('settings-nav-labels').click();

  const scope = page.getByTestId('label-manager-scope');
  await expect(scope).toBeVisible();
  await page.getByTestId('label-manager-new').click();
  await page.getByTestId('label-row-word').fill('instance-only');
  await page.getByTestId('label-row-done').click();
  await expect(page.getByTestId('label-manager-save')).toBeEnabled();

  // Switching scope drops the draft rather than carrying it into another document.
  await scope.selectOption({ label: 'e2e-label-scope' });
  await expect(page.getByTestId('label-manager-save')).toBeDisabled();
  await expect(page.getByTestId('label-row-instance-only')).toHaveCount(0);

  // A word declared here is this collection's, and it is kept.
  await page.getByTestId('label-manager-new').click();
  await page.getByTestId('label-row-word').fill('client-acme');
  await page.getByTestId('label-row-done').click();
  await page.getByTestId('label-manager-save').click();
  await expect(page.getByTestId('label-manager-error')).toHaveCount(0);
  await expect(page.getByTestId('label-row-client-acme')).toBeVisible();
});

/**
 * A collection this reader cannot write is shown, and shown as read-only.
 *
 * SHOWN RATHER THAN HIDDEN, because knowing a word exists is half of why the list is
 * there: a viewer needs to know `client-acme` is the word before applying it. And
 * READ-ONLY rather than refused on the click, which is the mistake this screen made twice
 * — a Save that cannot work is the same false promise as a search box that looks like a
 * compose field.
 *
 * A local vault has one owner and no roles (ADR 0018), so what this suite can hold is the
 * other half: every collection here IS writable, which is what `writable` must say when
 * there is nobody to be a viewer. The server's half is the role check, and
 * `e2e/collection-policy-check.mjs` holds roles against a real accounts server.
 */
test('on a local vault every collection is writable, because there are no roles', async ({
  page,
  request,
}) => {
  await ensureCollection(request, 'e2e-label-writable');

  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await openSettings(page);
  await page.getByTestId('settings-nav-labels').click();

  await page.getByTestId('label-manager-scope').selectOption({ label: 'e2e-label-writable' });
  // Writable, so the manager offers to add and to save — and says nothing about being
  // read-only, which is the state a viewer would see.
  await expect(page.getByTestId('label-manager-readonly')).toHaveCount(0);
  await expect(page.getByTestId('label-manager-new')).toBeVisible();
});
