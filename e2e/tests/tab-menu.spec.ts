import { test, expect } from '@playwright/test';

/**
 * A tab's own menu: rename, duplicate, close others.
 *
 * The reader that makes duplicate possible — a live pane tree read back into a plan — is a
 * pure function held by `e2e/tab-plan-check.mjs`, where step ORDER can be asserted. A bad
 * order does not crash: it silently opens fewer panes than it named, which in a browser
 * looks like "three panes instead of four" with no indication of which cut was dropped.
 *
 * What only a real window can show is here: that the menu opens where the pointer is, that
 * a duplicate really arrives with the same arrangement and DIFFERENT sessions, and that
 * closing the others asks first.
 */

const panes = (page: import('@playwright/test').Page) => page.locator('.xterm-screen');
const tabs = (page: import('@playwright/test').Page) => page.getByTestId('tab-select');

/**
 * Open a new tab holding one local shell.
 *
 * Counts TABS and not panes. Only the active tab's panes are mounted, so opening a tab
 * leaves the pane count where it was while the previous tab's panes unmount — which is
 * how the first version of this helper came to assert a number that never arrived.
 */
async function newTab(page: import('@playwright/test').Page) {
  const before = await tabs(page).count();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(tabs(page)).toHaveCount(before + 1, { timeout: 15_000 });
  await expect(panes(page).first()).toBeVisible({ timeout: 15_000 });
}

/** How many terminal sessions the server is holding. */
async function sessionCount(request: import('@playwright/test').APIRequestContext) {
  const res = await request.get('/api/terminal');
  expect(res.ok(), 'the session list answers').toBeTruthy();
  return ((await res.json()) as unknown[]).length;
}

/** Right-click the tab at `index` and wait for its menu. */
async function tabMenu(page: import('@playwright/test').Page, index = 0) {
  await tabs(page).nth(index).click({ button: 'right' });
  await expect(page.getByTestId('tab-menu')).toBeVisible();
}

test('the menu opens at the pointer and offers the three actions', async ({ page }) => {
  await page.goto('/');
  await newTab(page);

  await tabMenu(page);
  await expect(page.getByTestId('tab-menu-rename')).toBeVisible();
  await expect(page.getByTestId('tab-menu-duplicate')).toBeVisible();

  // The wording is the point, not the row: a bare "Duplicate tab" would promise a copy
  // nobody can deliver, because a pane holds a live session.
  await expect(page.getByTestId('tab-menu-duplicate')).toContainText(/new sessions/i);

  // Escape closes it, and nothing happened.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tab-menu')).toHaveCount(0);
});

test('close others is absent while there is only one tab', async ({ page }) => {
  await page.goto('/');
  // An entry that would close nothing is worse than no entry: it reads as "nothing
  // happened" rather than as "there was nothing to do".
  const count = await tabs(page).count();
  if (count > 1) test.skip();
  await newTab(page);
  await tabMenu(page);
  await expect(page.getByTestId('tab-menu-close-others')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('a duplicate opens the same arrangement with new sessions', async ({ page, request }) => {
  await page.goto('/');
  await newTab(page);

  // Split it, so the arrangement being duplicated is more than one pane — a single pane
  // would pass on a duplicate that ignored the tree entirely.
  await panes(page).first().click();
  await page.keyboard.press('Control+Shift+H');
  await expect(panes(page)).toHaveCount(2, { timeout: 20_000 });

  const tabsBefore = await tabs(page).count();
  const sessionsBefore = await sessionCount(request);

  await tabMenu(page, tabsBefore - 1);
  await page.getByTestId('tab-menu-duplicate').click();

  await expect(tabs(page)).toHaveCount(tabsBefore + 1, { timeout: 30_000 });
  // The new tab is the active one, and it holds the same arrangement: two panes, as the
  // tab it came from. Only the active tab is mounted, so this is a count of the duplicate
  // and not of both.
  await expect(panes(page)).toHaveCount(2, { timeout: 30_000 });

  // THE claim: the sessions are NEW. Two more of them exist, which a duplicate that
  // re-pointed the new panes at the old sessions would not have produced — and that is
  // the failure worth catching, because two panes claiming one session looks fine until
  // one of them closes.
  await expect
    .poll(() => sessionCount(request), { timeout: 30_000 })
    .toBe(sessionsBefore + 2);
});

test('closing the other tabs asks first, and a refusal leaves them standing', async ({
  page,
}) => {
  await page.goto('/');
  await newTab(page);
  await newTab(page);
  const before = await tabs(page).count();
  expect(before, 'two tabs at least, or there are no others to close').toBeGreaterThan(1);

  await tabMenu(page, 0);
  await page.getByTestId('tab-menu-close-others').click();

  // Always asks, whatever the terminal count: closing one tab is a decision about one
  // tab, and closing the rest at once is a decision about work in progress.
  await expect(page.getByText(/Close the other tabs/i)).toBeVisible();
  await page.getByRole('button', { name: /cancel/i }).click();
  await expect(tabs(page), 'a refusal changes nothing').toHaveCount(before);
});

test('confirming close others leaves exactly the tab it was asked from', async ({ page }) => {
  await page.goto('/');
  // THREE tabs, not two. With a single other tab, "close the others" and "close the
  // first other" are the same thing, and a loop that stopped after one would pass —
  // verified by mutation, which survived until this opened a third.
  await newTab(page);
  await newTab(page);
  await newTab(page);
  const before = await tabs(page).count();
  expect(before, 'one to keep and two others').toBe(3);
  const keepName = await tabs(page).first().innerText();

  await tabMenu(page, 0);
  await page.getByTestId('tab-menu-close-others').click();
  await expect(page.getByText(/Close the other tabs/i)).toBeVisible();
  await page.getByRole('button', { name: /close/i }).last().click();

  // One tab left, and it is THE one the menu was opened from. Asserting only the count
  // would pass on an implementation that closed the wrong one — and closing the tab
  // someone was working in, while keeping the ones they asked to drop, is the worst
  // possible outcome of this action.
  await expect(tabs(page)).toHaveCount(1, { timeout: 30_000 });
  await expect(tabs(page).first()).toHaveText(keepName);
});
