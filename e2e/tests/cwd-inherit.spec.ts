import { test, expect } from '@playwright/test';

/**
 * Splitting a pane leaves you where you were.
 *
 * This is the "working directory per tab" item, delivered as inheritance rather than as a
 * directory fixed on the tab: a terminal multiplexer answers "where does the new pane
 * start" with "where the old one is", and that subsumes the fixed case — the first pane
 * sets the tone and every split follows the pane it came from.
 *
 * LINUX ONLY, and the test says so rather than pretending. The directory is read from
 * `/proc/<pid>/cwd`, which is how tmux answers the same question. On any other platform
 * the reader returns nothing and the pane opens where a shell normally would; the Rust
 * side holds that in `local_terminal.rs`.
 *
 * Driven through the shell, by typing. There is no API that reports a pane's directory —
 * asking the shell is what a person does, and it is the only answer that proves the PTY
 * really started there rather than that a field was carried around.
 */

const panes = (page: import('@playwright/test').Page) => page.locator('.xterm-screen');

/** Type a line into the focused pane and press Enter. */
async function run(page: import('@playwright/test').Page, line: string) {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

/** The text of the pane at `index`, once it holds `needle`. */
async function screenHolding(
  page: import('@playwright/test').Page,
  index: number,
  needle: RegExp,
) {
  const rows = page.locator('.xterm-rows').nth(index);
  await expect(rows).toContainText(needle, { timeout: 20_000 });
  return rows.innerText();
}

test('a split opens in the directory the cut pane was in', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(panes(page).first()).toBeVisible({ timeout: 15_000 });
  await panes(page).first().click();

  // Somewhere that is certainly not where a shell starts, and certainly exists.
  await run(page, 'cd /usr/share && echo READY-$PWD');
  await screenHolding(page, 0, /READY-\/usr\/share/);

  // Split it. The new pane is a plain local shell, so it has a directory of its own to
  // report — and nothing was typed into it.
  await page.keyboard.press('Control+Shift+H');
  await expect(panes(page)).toHaveCount(2, { timeout: 20_000 });
  await panes(page).nth(1).click();
  await run(page, 'echo SPLIT-$PWD');

  const text = await screenHolding(page, 1, /SPLIT-/);
  // THE assertion. A pane that ignored the inheritance would report the home directory,
  // which is what every pane reported before this.
  expect(text, 'the new pane started where the old one was').toContain('SPLIT-/usr/share');
});

test('a new tab starts fresh, not where another pane happened to be', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(panes(page).first()).toBeVisible({ timeout: 15_000 });
  await panes(page).first().click();
  await run(page, 'cd /usr/share && echo READY-$PWD');
  await screenHolding(page, 0, /READY-\/usr\/share/);

  // A new tab is a fresh start, deliberately. "Leave me where I was" is unambiguous for a
  // split and a guess anywhere else — a tab opened to begin something else would be a
  // surprising place to land.
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(panes(page).first()).toBeVisible({ timeout: 15_000 });
  await panes(page).first().click();
  await run(page, 'echo TAB-$PWD');

  const text = await screenHolding(page, 0, /TAB-/);
  expect(text, 'a new tab does not inherit').not.toContain('TAB-/usr/share');
});
