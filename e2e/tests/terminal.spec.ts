import { test, expect } from '@playwright/test';

/**
 * Terminal parity: opening a local terminal spawns a real PTY on the server and
 * streams its output to the browser over the WebSocket, and keystrokes flow back
 * as input. Using shell arithmetic (`$((6*7))`) proves the shell actually ran
 * the command rather than the terminal merely echoing keystrokes.
 */
test('local terminal streams real shell output over the websocket', async ({ page }) => {
  await page.goto('/');

  await page.getByText('Local Terminal').click();

  // xterm mounts once the local session is created.
  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 15_000 });

  // Focus the terminal and run a command whose output differs from the input.
  await screen.click();
  await page.keyboard.type('echo RITE_$((6*7))_DONE');
  await page.keyboard.press('Enter');

  await expect(page.locator('.xterm-rows')).toContainText('RITE_42_DONE', { timeout: 15_000 });
});
