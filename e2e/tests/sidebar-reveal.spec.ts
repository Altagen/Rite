import { test, expect } from '@playwright/test';

/**
 * The arrow that reopens a closed sidebar appears near the left edge, and never sits over
 * the terminal when it is not wanted.
 *
 * Two shapes shipped before this, each with one half of the answer. A `:hover` reveal
 * cannot be hovered — an element at opacity 0 is still hit-testable, so the arrow sat
 * invisible over the terminal and caught clicks meant for it. The answer to that was a
 * permanent arrow, which puts a button on top of the output it was meant to stay out of.
 *
 * So the arrow reads the pointer instead (no element over the terminal at all), and is
 * `pointer-events-none` while hidden. `design/mock/rite.css` carries the same rule for
 * `.side-rail`, and `mock.spec.ts` holds the prototype to it.
 */
test('the sidebar reveal arrow follows the pointer and is click-through when hidden', async ({
  page,
}) => {
  await page.goto('/');

  // Close the sidebar: the arrow only exists then.
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  const arrow = page.getByTestId('sidebar-reveal');
  await expect(arrow).toBeAttached();

  // Away from the edge: in the DOM, invisible, and not in the way.
  await page.mouse.move(700, 400);
  await expect(arrow).toHaveCSS('opacity', '0');
  await expect(arrow).toHaveCSS('pointer-events', 'none');

  // Near it: shown, and clickable again.
  await page.mouse.move(8, 400);
  await expect(arrow).toHaveCSS('opacity', '1');
  await expect(arrow).toHaveCSS('pointer-events', 'auto');

  // And back away — a reveal that does not hide again is the permanent button by another
  // route.
  await page.mouse.move(700, 400);
  await expect(arrow).toHaveCSS('opacity', '0');

  // It still works: the arrow is a way back, not decoration.
  await page.mouse.move(8, 400);
  await arrow.click();
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toBeVisible();
  await expect(arrow).not.toBeAttached();
});

/**
 * The keyboard is the other way in. A pointer-proximity reveal is invisible to anyone who
 * does not use one, so focus has to show it — otherwise closing the sidebar with a
 * keyboard leaves no way to reopen it.
 */
test('the reveal arrow shows itself when it takes keyboard focus', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Hide sidebar' }).click();

  const arrow = page.getByTestId('sidebar-reveal');
  await page.mouse.move(700, 400);
  await expect(arrow).toHaveCSS('opacity', '0');

  await arrow.focus();
  await expect(arrow).toHaveCSS('opacity', '1');
  await expect(arrow).toHaveCSS('pointer-events', 'auto');
});
