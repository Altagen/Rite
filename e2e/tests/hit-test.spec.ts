import { test, expect } from '@playwright/test';
import { openSettings } from './support/headerBar';
import { expectClickable, coveredControls } from './support/hitTest';
import { ensureCollection } from './support/localVault';

/**
 * CAN THE CONTROLS ON SCREEN BE CLICKED — in each state that puts a new layer on screen.
 *
 * The defect this exists for: a collection overlay at `z-10`, under a terminal tab strip
 * that was `relative z-10` with `pb-3 overflow-y-visible`, so the strip's invisible
 * padding ate every click in the top band of the overlay. Board, Members and Check now
 * were dead at every window width. The suite had 131 passing tests and could not see it,
 * and it had been failing `wave1-dashboard` for days under a diagnosis of "pre-existing,
 * unrelated".
 *
 * WHY STATE BY STATE RATHER THAN ONE SWEEP. Overlapping is what a z-index is FOR: a modal
 * must cover the app bar. What is a defect is a layer covering controls that are still
 * supposed to be live underneath — the app bar while a view is open, a dialog's own rail.
 * So each test names one arrangement and the region that has to stay clickable in it.
 *
 * `support/hitTest.ts` carries the argument for `elementFromPoint` over a click.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
});

test('the app bar is clickable on a bare workspace', async ({ page }) => {
  await expectClickable(page, '[data-testid="app-bar"]');
});

test('the app bar stays clickable with a collection open', async ({ page, request }) => {
  // Created after the shared beforeEach loaded the page, so the sidebar has to be told.
  await ensureCollection(request, 'e2e-hit-test');
  await page.reload();
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('lib-collection-e2e-hit-test').click();
  await expect(page.getByTestId('cview-labels')).toBeVisible();

  // The overlay covers the terminal and must NOT cover the bar above it.
  await expectClickable(page, '[data-testid="app-bar"]');

  // And the overlay's own action row, which is where the defect actually landed. Scoped
  // to the row the labels button sits in: a sweep of the whole overlay reports the
  // sidebar's nested buttons, where a hit on a child is the normal arrangement.
  const row = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="cview-labels"]')?.parentElement;
    if (!el) return null;
    el.setAttribute('data-testid', 'hit-test-row');
    return 'hit-test-row';
  });
  expect(row).toBe('hit-test-row');
  await expectClickable(page, '[data-testid="hit-test-row"]');
});

test('the app bar stays clickable with the agent manager open', async ({ page }) => {
  await page.getByTestId('toolbar-agents').click();
  await expect(page.getByTestId('agent-manager')).toBeVisible();
  await expectClickable(page, '[data-testid="app-bar"]');

  // The manager's own toolbar: probe, new, tools, search.
  await expectClickable(page, '[data-testid="agent-manager"] header');
});

test('the settings dialog receives clicks on its rail and its body', async ({ page }) => {
  await openSettings(page);
  const dialog = page.getByTestId('settings-dialog');
  await expect(dialog).toBeVisible();
  await expectClickable(page, '[data-testid="settings-dialog"]');
});

/**
 * THE SWEEP HAS TO BE ABLE TO FAIL, and this is the only test here that proves it.
 *
 * Every other case asserts an empty list, which an inert helper also returns — a broken
 * `coveredControls` would make the whole file pass. So cover the bar on purpose, with a
 * plain opaque div at a high z, and require the helper to name what it hit.
 */
test('the sweep reports a control that something is sitting on', async ({ page }) => {
  await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="app-bar"]');
    if (!bar) throw new Error('no app bar');
    const r = bar.getBoundingClientRect();
    const thief = document.createElement('div');
    thief.dataset.testid = 'hit-test-thief';
    thief.style.cssText = `position:fixed;left:0;top:0;width:100vw;height:${r.height}px;z-index:9999;background:#000`;
    document.body.appendChild(thief);
  });

  const covered = await coveredControls(page, '[data-testid="app-bar"]');
  expect(covered.length).toBeGreaterThan(0);
  expect(covered.every((c) => c.by === '[hit-test-thief]')).toBe(true);
});
