import { test, expect, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * WHAT IS LEFT OF THE MOCK SPEC, AND WHY IT IS ONE TEST.
 *
 * `design/mock` was the source of truth for UI/UX (ADR 0019) and plain HTML opened from
 * disk, so nothing told anyone when it broke — which is how the web UI shipped a
 * dashboard nobody had decided on. This file was the answer: the drawing, checked the way
 * the app is.
 *
 * It ended up proving the opposite. A drawing that is checked still disagrees with the
 * product — it showed a git branch on an agent card and a turn count after the code had
 * measured both and refused them, listed six adapters while seven shipped, and offered a
 * two-level machine picker that was never built. Every one of those passed here. So the
 * decisions moved to the screens that ship, one by one, and the tests that held them went
 * with them: the manager's surface to `agent-cards.spec.ts`, the panel's to
 * `agent-panel.spec.ts`, the probe's three states to `agent-manager.spec.ts`, the
 * dashboard's cards to `wave1-dashboard.spec.ts`, ADR 0019 §5 to
 * `e2e/dashboard-verdict-check.mjs`, the workspace document to `wave1.spec.ts`, the
 * Board's one HTML sink to `accounts.spec.ts` and the Settings rail to
 * `settings-surfaces.spec.ts`.
 *
 * ONE TEST STAYS, and it is not about the design. `setup.html` reads `?u=` off the URL
 * and writes it with `innerHTML`, which was a live reflected XSS — a link that ran script
 * in whoever opened it — and `design/mock/esc.js` is the fix. The page is still in the
 * repository, so the guard stays until the folder goes, and then both go together.
 */

const mock = (name: string) =>
  pathToFileURL(resolve(__dirname, `../../design/mock/${name}.html`)).href;

/** Fail on anything the page logged as an error — a mock that throws is a broken mock. */
function watchErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`));
  return errs;
}

/**
 * The prototypes build markup as strings, so every `innerHTML` in them is a sink. CodeQL
 * found five, and one of them was not a prototype's licence to be sloppy but the reflected
 * XSS above.
 *
 * It asserts the two halves separately, because each can fail without the other: that
 * nothing ran, and that the name is still shown as the text it is — an over-eager fix that
 * escaped the value at its source would pass the first and print entities on the screen
 * for the second. The same property, against the shipped component that writes HTML out of
 * what somebody typed, is `accounts.spec.ts` ("a note card carrying markup").
 */
test('mock: a username from the URL is text, not markup', async ({ page }) => {
  const errs = watchErrors(page);

  // `<img src=x onerror>` and not `<script>`: an injected script tag does not execute
  // when it arrives through innerHTML, so it would pass whatever the page did.
  const payload = '<img src=x onerror="window.__xss=1">';
  await page.goto(`${mock('setup')}?mode=reset&u=${encodeURIComponent(payload)}`);

  // Nothing ran.
  expect(
    await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
  ).toBeUndefined();
  await expect(page.locator('#note img')).toHaveCount(0);

  // And the name is still on screen, as the characters it is made of.
  await expect(page.locator('#note')).toContainText(payload);

  expect(errs, 'the mock must not log errors').toEqual([]);
});
