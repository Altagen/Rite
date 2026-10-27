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
 * Leaving the window by the LEFT used to reveal the arrow for good.
 *
 * Reported from the desktop client: the arrow stayed visible permanently once the pointer
 * went off the window's left side, while going off the top or the right was fine. The
 * asymmetry is the whole diagnosis — the last `clientX` seen on the way out the top or the
 * right is beyond the 48px zone, so the arrow hides on its own and no leave event is
 * needed; on the way out the left it is inside the zone, so the state stays `true` with
 * nothing further coming. Every other direction worked by accident.
 *
 * Driven as events rather than with `page.mouse`: a pointer cannot be moved outside the
 * viewport, which is exactly the case that broke. `relatedTarget: null` is what the pointer
 * crossing out of the document looks like.
 */
test('the reveal arrow hides when the pointer leaves the window by the left', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  const arrow = page.getByTestId('sidebar-reveal');

  // Inside the zone, which is where the pointer is on its way out the left edge.
  await page.mouse.move(4, 400);
  await expect(arrow).toHaveCSS('opacity', '1');

  await page.evaluate(() =>
    document.dispatchEvent(
      new MouseEvent('mouseout', { relatedTarget: null, bubbles: true, clientX: 0 }),
    ),
  );
  await expect(arrow).toHaveCSS('opacity', '0');
  await expect(arrow).toHaveCSS('pointer-events', 'none');
});

/**
 * And the window losing focus with the pointer parked in the zone — moving to another
 * window, or to a screen on the left — is the same situation by another route: an
 * unfocused window has nothing to reveal.
 */
test('the reveal arrow hides when the window loses focus', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  const arrow = page.getByTestId('sidebar-reveal');

  await page.mouse.move(4, 400);
  await expect(arrow).toHaveCSS('opacity', '1');

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(arrow).toHaveCSS('opacity', '0');
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
