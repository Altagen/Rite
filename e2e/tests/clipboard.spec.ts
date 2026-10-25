import { test, expect } from '@playwright/test';

/**
 * Copying out of a terminal, and not pasting nothing into one.
 *
 * Every number below was measured before the code was written, on both engines — this
 * suite for Chromium, `e2e/desktop-bench` for WebKitGTK, which is the one Rite ships in.
 * What the measurements found:
 *
 *   - `Ctrl+Shift+C` sent nothing and copied nothing, on either engine. xterm's own
 *     `copyHandler` works, but no chord fires it: `Ctrl+C` is taken to send `\x03`, which
 *     is right, and that also stops the engine firing its own copy.
 *   - `Ctrl+Shift+V` already pastes on both engines, so paste is deliberately NOT bound —
 *     binding it would paste twice. The test below holds that line.
 *   - a paste with nothing to paste sent `ESC[200~ ESC[201~`: two escape sequences for no
 *     text, every middle click on an empty primary selection.
 *
 * The bytes are read off the wire (`POST /api/terminal/{id}/input`) rather than off the
 * screen, because what the shell receives is the only thing that matters here.
 *
 * This file holds what THIS engine can prove. The decision table is
 * `e2e/clipboard-decision-check.mjs`, and what WebKitGTK does with the same gestures is
 * the `clipboard` scenario of `e2e/desktop-bench`.
 */

async function terminalWithRecorder(page: import('@playwright/test').Page) {
  const sent: number[][] = [];
  page.on('request', (r) => {
    if (r.url().includes('/input')) {
      sent.push((JSON.parse(r.postData() ?? '{}').data ?? []) as number[]);
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('.xterm-screen').first().click();
  return sent;
}

/**
 * Hold the pane to having NO selection.
 *
 * The terminal pool reuses one pane across this file, so a selection left by the test
 * before survives into the next one — which made the no-selection case pass or fail on
 * order alone. A click clears it; this waits until it is actually gone and says so if it
 * is not, because a precondition that is merely hoped for is how a flaky test is born.
 */
async function withNothingSelected(page: import('@playwright/test').Page) {
  await page.locator('.xterm-screen').first().click();
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.xterm-selection div').length), {
      timeout: 5_000,
    })
    .toBe(0);
}

/** Type a line and drag across the row that carries it, which is how a person selects. */
async function selectTypedLine(page: import('@playwright/test').Page, text: string) {
  await page.keyboard.type(text);
  // The row element, not the middle of the screen: a drag over empty cells selects
  // nothing, which cost one wrong measurement before it cost a wrong fix.
  const row = page.locator('.xterm-rows > div', { hasText: text }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(page.locator('.xterm-selection div').first()).toBeVisible();
}

test('the copy chord puts the selection on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const sent = await terminalWithRecorder(page);
  await selectTypedLine(page, 'echo copy-me-exactly');

  const from = sent.length;
  await page.keyboard.press('Control+Shift+C');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText().catch(() => '')), {
      timeout: 5_000,
    })
    .toContain('copy-me-exactly');

  // And the chord is not also a keystroke: a terminal that copies AND sends is worse than
  // one that only sends, because the shell acts on something nobody typed.
  expect(sent.slice(from).flat(), 'the copy chord sends nothing to the shell').toEqual([]);
});

test('the copy chord with nothing selected leaves the clipboard alone', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const sent = await terminalWithRecorder(page);
  await withNothingSelected(page);
  await page.evaluate(() => navigator.clipboard.writeText('SENTINEL-KEEP-ME'));
  await page.keyboard.type('echo no-selection-here');
  const from = sent.length;

  await page.keyboard.press('Control+Shift+C');
  await page.waitForTimeout(500);

  // `defaultPrevented` cannot be the assertion here: xterm calls `preventDefault` on this
  // keydown itself, selection or none, so it says nothing about whether the guard claimed
  // it. What IS observable is the clipboard — a guard that copied an empty selection would
  // have wiped this.
  expect(
    await page.evaluate(() => navigator.clipboard.readText().catch(() => '')),
    'an empty selection does not clobber what was already there',
  ).toBe('SENTINEL-KEEP-ME');
  expect(sent.slice(from).flat(), 'and nothing reaches the shell').toEqual([]);
});

test('Ctrl+C still interrupts, selection or no selection', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const sent = await terminalWithRecorder(page);
  await selectTypedLine(page, 'echo interrupt-me');

  const from = sent.length;
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(400);
  // The whole reason copy needs its own chord: this one belongs to the shell. A terminal
  // that copies here instead of interrupting cannot stop a runaway command.
  expect(sent.slice(from).flat(), 'ETX reaches the shell').toEqual([0x03]);
});

/*
 * The empty paste is NOT asserted here, and that is deliberate. A hand-built `paste` event
 * carrying empty data is reported cancelled and delivers nothing on its own — a spec built
 * on it passed with the guard removed — and a real middle click pastes whatever X11 holds,
 * which a page cannot clear, so the precondition cannot be established from here. The
 * decision lives in `e2e/clipboard-decision-check.mjs` and the real gesture in the
 * `clipboard` scenario of `e2e/desktop-bench`.
 */

test('a paste carrying text still arrives whole and bracketed', async ({ page }) => {
  const sent = await terminalWithRecorder(page);
  await withNothingSelected(page);
  const from = sent.length;

  await page.locator('.xterm-helper-textarea').first().evaluate((ta) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'pasted-text');
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await page.waitForTimeout(400);

  const flat = sent.slice(from).flat();
  const asText = String.fromCharCode(...flat);
  // Bracketed paste, which is what tells a shell that what follows was pasted and must
  // not be executed as it arrives. Dropping the empty case must not have cost this one.
  expect(asText, 'the text arrives between the brackets').toBe('\x1b[200~pasted-text\x1b[201~');
});

test('paste is left to the engine, so it happens once', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const sent = await terminalWithRecorder(page);
  await page.evaluate(() => navigator.clipboard.writeText('once-only'));
  await page.waitForTimeout(200);
  const from = sent.length;

  await page.keyboard.press('Control+Shift+V');
  await page.waitForTimeout(600);

  const asText = String.fromCharCode(...sent.slice(from).flat());
  // Both engines already paste on this chord. Binding it as well would send the text
  // twice, which is the regression this test exists to catch.
  //
  // Its teeth are conditional, and that is worth knowing: recognising `v` as the copy
  // chord but then ignoring it is invisible here, because ignoring it IS the correct
  // behaviour. What this kills is a guard that CLAIMS the chord — verified by mutation,
  // recognising `v` and acting unconditionally fails this test.
  const occurrences = asText.split('once-only').length - 1;
  expect(occurrences, 'pasted exactly once').toBe(1);
});
