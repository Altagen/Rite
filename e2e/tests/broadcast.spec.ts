import { test, expect } from '@playwright/test';

/**
 * Typing in one pane, reaching all of them.
 *
 * Measured at the wire, not on the screen: every keystroke becomes a
 * `POST /api/terminal/{id}/input`, so the session ids those posts carry are the only
 * honest answer to "which shells did this reach". A screen-based test would pass on a mode
 * that echoed locally and sent nothing.
 *
 * SCOPED TO ONE TAB, as tmux's `synchronize-panes` is. Broadcasting into panes in another
 * tab would be typing where nobody is looking — and the blast radius of a MODE is every
 * keystroke, not one deliberate snippet, which is why the one-shot broadcast in the
 * snippets list can afford to reach every open pane and this cannot.
 */

const panes = (page: import('@playwright/test').Page) => page.locator('.xterm-screen');
const tabs = (page: import('@playwright/test').Page) => page.getByTestId('tab-select');

/** Record which session each keystroke was posted to. */
function recordTargets(page: import('@playwright/test').Page) {
  const to: string[] = [];
  page.on('request', (r) => {
    const m = /\/api\/terminal\/([^/]+)\/input$/.exec(r.url());
    if (m) to.push(m[1]);
  });
  return to;
}

async function newTab(page: import('@playwright/test').Page) {
  const before = await tabs(page).count();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(tabs(page)).toHaveCount(before + 1, { timeout: 15_000 });
  await expect(panes(page).first()).toBeVisible({ timeout: 15_000 });
}

/** Turn broadcasting on for the tab at `index`, through its own menu. */
async function startBroadcast(page: import('@playwright/test').Page, index: number) {
  await tabs(page).nth(index).click({ button: 'right' });
  await expect(page.getByTestId('tab-menu')).toBeVisible();
  await page.getByTestId('tab-menu-broadcast').click();
  await expect(page.getByTestId('broadcast-badge')).toBeVisible();
}

test('while off, a keystroke reaches one pane', async ({ page }) => {
  await page.goto('/');
  await newTab(page);
  await panes(page).first().click();
  await page.keyboard.press('Control+Shift+H');
  await expect(panes(page)).toHaveCount(2, { timeout: 20_000 });

  // The control: with two panes open and the mode off, typing reaches exactly one. A test
  // that only checked the ON case would pass on a mode that was always on.
  const to = recordTargets(page);
  await panes(page).first().click();
  await page.keyboard.type('x');
  await page.waitForTimeout(400);
  expect(new Set(to).size, 'one pane, one session').toBe(1);
  await expect(page.getByTestId('broadcast-badge')).toHaveCount(0);
});

test('while on, one keystroke reaches every pane of the tab', async ({ page }) => {
  await page.goto('/');
  await newTab(page);
  await panes(page).first().click();
  await page.keyboard.press('Control+Shift+H');
  await expect(panes(page)).toHaveCount(2, { timeout: 20_000 });

  await startBroadcast(page, (await tabs(page).count()) - 1);

  const to = recordTargets(page);
  await panes(page).first().click();
  await page.keyboard.type('y');
  await expect.poll(() => new Set(to).size, { timeout: 5_000 }).toBe(2);
});

test('a pane opened mid-broadcast joins it', async ({ page }) => {
  await page.goto('/');
  await newTab(page);
  await panes(page).first().click();
  await startBroadcast(page, (await tabs(page).count()) - 1);

  // `synchronize-panes` includes new panes, and a target list that went stale would
  // silently stop reaching one of them — which is worse than not broadcasting at all,
  // because the shells would drift apart without saying so.
  await panes(page).first().click();
  await page.keyboard.press('Control+Shift+H');
  await expect(panes(page)).toHaveCount(2, { timeout: 20_000 });

  const to = recordTargets(page);
  await panes(page).first().click();
  await page.keyboard.type('z');
  await expect.poll(() => new Set(to).size, { timeout: 5_000 }).toBe(2);
});

test('the badge stops it, and typing goes back to one pane', async ({ page }) => {
  await page.goto('/');
  await newTab(page);
  await panes(page).first().click();
  await page.keyboard.press('Control+Shift+H');
  await expect(panes(page)).toHaveCount(2, { timeout: 20_000 });
  await startBroadcast(page, (await tabs(page).count()) - 1);

  // The badge says what it does where someone would look for a way out, and one click is
  // the whole exit: the cost of forgetting this mode is a command running on machines
  // nobody meant to touch.
  const badge = page.getByTestId('broadcast-badge');
  await expect(badge).toHaveAttribute('title', /click to stop/i);
  await badge.click();
  await expect(page.getByTestId('broadcast-badge')).toHaveCount(0);

  const to = recordTargets(page);
  await panes(page).first().click();
  await page.keyboard.type('w');
  await page.waitForTimeout(400);
  expect(new Set(to).size, 'back to one').toBe(1);
});

test('typing in another tab does not broadcast', async ({ page }) => {
  await page.goto('/');
  await newTab(page);
  await panes(page).first().click();
  await page.keyboard.press('Control+Shift+H');
  await expect(panes(page)).toHaveCount(2, { timeout: 20_000 });
  const broadcasting = (await tabs(page).count()) - 1;
  await startBroadcast(page, broadcasting);

  // A second tab, with panes of its own. The mode stays on — the badge is still there —
  // and yet nothing here fans out, because a pane only broadcasts when its OWN session is
  // among the targets. That is the guard: one condition, not a flag to keep in step.
  await newTab(page);
  await panes(page).first().click();
  await page.keyboard.press('Control+Shift+H');
  await expect(panes(page)).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByTestId('broadcast-badge')).toBeVisible();

  const to = recordTargets(page);
  await panes(page).first().click();
  await page.keyboard.type('q');
  await page.waitForTimeout(500);
  expect(new Set(to).size, 'another tab is not the broadcasting one').toBe(1);
});
