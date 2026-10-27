import { test, expect } from '@playwright/test';

/**
 * A pane that is mounted again must not leave the previous mount's listeners behind.
 *
 * Reported from the desktop client: typing into a long-lived pane corrupts the display — a
 * TUI redrawing over lines that never cleared, and a duplicated prompt. The cause is not the
 * TUI. `Terminal.tsx` registers a window `resize` listener, a `ResizeObserver` and two input
 * guards inside `async function initializeTerminal()`, and returns its cleanup from THAT
 * function. React never receives it, because the value of an async function is a promise —
 * so every remount adds another set and removes none. Each surviving `resize` listener runs
 * `fit()` and pushes a new size to the PTY, so one window resize fires N fits and N racing
 * `resizeTerminal` calls, and the shell's redraw lands on a row that has moved under it.
 *
 * Only the active tab's panes are mounted, so switching tabs is the remount: the same
 * gesture that made this visible in a day's work.
 *
 * Counted by wrapping `addEventListener`/`removeEventListener` before the app loads, which
 * is the only way to see a listener nothing exposes.
 */

type Tally = { added: number; removed: number };
const tabs = (page: import('@playwright/test').Page) => page.getByTestId('tab-select');
const panes = (page: import('@playwright/test').Page) => page.locator('.xterm-screen');

test('switching tabs does not accumulate resize listeners', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __tally: Tally };
    w.__tally = { added: 0, removed: 0 };
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'resize') w.__tally.added++;
      return (add as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'resize') w.__tally.removed++;
      return (remove as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof window.removeEventListener;
  });

  await page.goto('/');

  // Two tabs, so there is something to switch between.
  for (const _ of [0, 1]) {
    const before = await tabs(page).count();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(tabs(page)).toHaveCount(before + 1, { timeout: 15_000 });
    await expect(panes(page).first()).toBeVisible({ timeout: 15_000 });
  }

  const tally = () =>
    page.evaluate(() => (window as unknown as { __tally: Tally }).__tally);
  const start = await tally();

  // Four switches, so a leak of one per mount is unmistakable against the single pane
  // that is legitimately mounted at the end.
  for (const i of [0, 1, 0, 1]) {
    await tabs(page).nth(i).click();
    await expect(panes(page).first()).toBeVisible({ timeout: 15_000 });
  }

  const end = await tally();
  const surplus = end.added - start.added - (end.removed - start.removed);

  // One mounted pane may hold one listener. Four switches holding four is the leak.
  expect(
    surplus,
    `four tab switches left ${surplus} resize listeners nobody can reach`,
  ).toBeLessThanOrEqual(1);
});
