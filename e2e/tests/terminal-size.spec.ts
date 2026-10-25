import { test, expect } from '@playwright/test';
import { createCollection, createMachine, SSH } from './support/localVault';

/**
 * The PTY must be told how big the pane is, the moment the pane exists.
 *
 * A session is created with a placeholder size — 24 rows, 80 columns — and learns the real
 * one from xterm's `onResize`. But xterm emits that only when ITS size changes, and the
 * first `fit()` runs before the handler is registered and before the session id is set, so
 * the very first size was dropped on the floor. The PTY then kept 80 columns inside a pane
 * showing far more, and a shell that believes it wraps at 80 redraws a long line where the
 * display does not: past that column the line lands on the wrong row.
 *
 * Measured in a running client before the fix: a pane open for half an hour, its shell's
 * tty still reporting `24 80`.
 *
 * The assertion is on the request, not on the screen, because the screen looks right until
 * a line crosses the placeholder width — which is exactly why this went unnoticed.
 */
const paintedGrid = (page: import('@playwright/test').Page) =>
  // The grid xterm paints, by geometry: a row holds only the characters actually drawn, so
  // counting text would measure an empty line as zero columns.
  page.evaluate(() => {
    const rows = document.querySelector('.xterm-rows');
    const screen = document.querySelector('.xterm-screen');
    const measure = document.querySelector('.xterm-char-measure-element');
    if (!rows || !screen || !measure) return null;
    const cell = measure.getBoundingClientRect().width / (measure.textContent?.length || 1);
    return {
      rows: rows.children.length,
      cols: Math.floor(screen.getBoundingClientRect().width / cell),
    };
  });

test('a new terminal tells the PTY the size of its pane', async ({ page }) => {
  const resizes: Array<{ cols: number; rows: number }> = [];
  page.on('request', (r) => {
    if (r.url().includes('/resize')) resizes.push(JSON.parse(r.postData() ?? '{}'));
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);

  expect(resizes.length, 'the size must be sent when the session opens').toBeGreaterThan(0);

  const painted = await paintedGrid(page);
  expect(painted, 'the terminal must be painted to measure it').not.toBeNull();

  const last = resizes[resizes.length - 1];
  expect(last.cols, 'the columns sent are the columns painted').toBeGreaterThanOrEqual(
    painted!.cols - 1,
  );
  expect(last.cols).toBeLessThanOrEqual(painted!.cols + 1);
  expect(last.rows).toBeGreaterThanOrEqual(painted!.rows - 1);
  expect(last.rows).toBeLessThanOrEqual(painted!.rows + 1);

  // The placeholder is the failure this exists to catch: a pane this size is never 80x24.
  expect(
    { cols: last.cols, rows: last.rows },
    'the placeholder means nothing ever told the PTY the truth',
  ).not.toEqual({ cols: 80, rows: 24 });
});

test('a resized window tells the PTY its new size', async ({ page }) => {
  const resizes: Array<{ cols: number; rows: number }> = [];
  page.on('request', (r) => {
    if (r.url().includes('/resize')) resizes.push(JSON.parse(r.postData() ?? '{}'));
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);

  const before = resizes.length;
  await page.setViewportSize({ width: 820, height: 560 });
  await page.waitForTimeout(1500);

  expect(resizes.length, 'a narrower window is a narrower PTY').toBeGreaterThan(before);
  const painted = await paintedGrid(page);
  const last = resizes[resizes.length - 1];
  expect(last.cols).toBeGreaterThanOrEqual(painted!.cols - 1);
  expect(last.cols).toBeLessThanOrEqual(painted!.cols + 1);
  expect(last.rows).toBeGreaterThanOrEqual(painted!.rows - 1);
  expect(last.rows).toBeLessThanOrEqual(painted!.rows + 1);
});

/**
 * Reconnecting opens a NEW session, so the size has to be sent again — the branch the two
 * tests above never reach: they cover the first session of a pane, local or SSH, which is
 * born from the same code path.
 *
 * Requires the SSH harness: `sh e2e/harness-up.sh`.
 */
test('a reconnected session tells the PTY the size of its pane', async ({ page, request }) => {
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
  const collectionId = await createCollection(request, 'e2e-size');
  await createMachine(request, collectionId, { name: 'e2e-size-again' });

  const resizes: Array<{ id: string; cols: number; rows: number }> = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/api\/terminal\/([^/]+)\/resize$/);
    if (m) resizes.push({ id: m[1], ...JSON.parse(r.postData() ?? '{}') });
  });

  await page.goto('/');
  // The panes the other tests left open share this vault, and each disconnected one owns a
  // Reconnect button. This test needs its own to be the only one.
  const closers = page.getByRole('button', { name: 'Close terminal' });
  for (let open = await closers.count(); open > 0; open = await closers.count()) {
    await closers.first().click();
    await page.waitForTimeout(200);
  }

  await page.getByText('e2e-size-again').dblclick();
  await expect(page.locator('.xterm-rows')).toContainText(`${SSH.username}@`, { timeout: 20_000 });
  const first = resizes[resizes.length - 1];
  expect(first, 'the first session is sized').toBeTruthy();

  // Ending the remote shell leaves the pane disconnected, which is where Reconnect lives.
  await page.locator('.xterm-screen').first().click();
  await page.keyboard.type('exit', { delay: 25 });
  await page.keyboard.press('Enter');
  const reconnect = page.getByRole('button', { name: 'Reconnect', exact: true });
  await expect(reconnect).toBeVisible({ timeout: 20_000 });

  await reconnect.click();
  await expect(page.locator('.xterm-rows')).toContainText(`${SSH.username}@`, { timeout: 20_000 });
  await page.waitForTimeout(1000);

  const last = resizes[resizes.length - 1];
  expect(last.id, 'a new session, not the one that ended').not.toBe(first.id);
  const painted = await paintedGrid(page);
  expect(last.cols).toBeGreaterThanOrEqual(painted!.cols - 1);
  expect(last.cols).toBeLessThanOrEqual(painted!.cols + 1);
  expect(last.rows).toBeGreaterThanOrEqual(painted!.rows - 1);
  expect(last.rows).toBeLessThanOrEqual(painted!.rows + 1);
  expect({ cols: last.cols, rows: last.rows }).not.toEqual({ cols: 80, rows: 24 });
});
