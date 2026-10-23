import { test, expect } from '@playwright/test';

/**
 * An accent must send one character, not replay the line.
 *
 * WebKitGTK delivers an accented key as `keydown`(229) + `input` + a `compositionend`
 * with NO `compositionstart`. xterm.js declines it on both paths and the orphaned
 * `compositionend` slices its hidden textarea from position zero — sending the whole
 * line again. That is the "one accent prints a flood of characters" report.
 *
 * Chromium does not produce that sequence, which is why no browser test caught it and why
 * a Playwright run in any engine is blind to it: no engine Playwright drives exposes an
 * input method. But the sequence is just events, and events can be dispatched. So this
 * synthesises exactly what WebKitGTK sends and holds the terminal to the only acceptable
 * answer — the character, once.
 *
 * The real engine is covered separately by the Wayland harness, which runs the actual
 * client under a compositor and reads the bytes that reach the PTY.
 */
test('an accent delivered the WebKitGTK way sends one character, not the line', async ({
  page,
}) => {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/input')) sent.push(r.postData() ?? '');
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 15_000 });
  await screen.click();

  // A prompt to compare against, and a line with something in it: the bug replays what
  // is already in the hidden textarea, so an empty one would hide it.
  await page.keyboard.type('echo RITE', { delay: 25 });
  await expect(page.locator('.xterm-rows')).toContainText('echo RITE', { timeout: 10_000 });
  await page.waitForTimeout(300);
  const after = sent.length;

  // WebKitGTK's sequence, synthesised. The textarea is filled the way an input method
  // fills it, then the three events arrive in order.
  await page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    if (!ta) throw new Error('no xterm helper textarea');
    ta.focus();
    // What xterm would find if it read the textarea: the line so far plus the accent.
    ta.value = 'echo RITEé';
    ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, key: 'Process', bubbles: true }));
    ta.dispatchEvent(
      new InputEvent('input', {
        inputType: 'insertText',
        data: 'é',
        composed: true,
        bubbles: true,
      }),
    );
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: 'é', bubbles: true }));
  });

  await page.waitForTimeout(800);

  // What left the browser, which is more precise than reading the screen. Two failures
  // hide here and the bytes name them both:
  //   - the line replayed, because the orphaned compositionend sliced the textarea from 0
  //   - a 0x7f DEL, because xterm translates the input method's keyCode 229 keydown into
  //     a backspace that erases the accent arriving behind it
  const bodies = sent.slice(after).map((b) => JSON.parse(b).data as number[]);
  const flat = bodies.flat();
  expect(flat, 'the accent must be sent, as its two UTF-8 bytes').toContain(0xc3);
  expect(flat, 'exactly one accent').toEqual([0xc3, 0xa9]);
  expect(flat, 'no DEL: it would erase the accent').not.toContain(0x7f);

  // The shell echoes what it received. One accent means one accent.
  const row = page.locator('.xterm-rows');
  await expect(row).toContainText('echo RITEé', { timeout: 10_000 });
  // And not the line a second time, which is what slicing from zero produces.
  await expect(row).not.toContainText('echo RITEecho RITE');
  await expect(row).not.toContainText('RITEéecho');
});

/**
 * A dead key that composes nothing still ends a composition nobody started.
 *
 * Press `^` then Escape, or `^` then a key it cannot combine with, and WebKitGTK sends a
 * `compositionend` with no `input` before it and no `compositionstart` behind it. The
 * hidden textarea still holds the line, so xterm slices it from position zero and replays
 * it — the same flood, reached by a different route, and the one the guard's last branch
 * exists for.
 */
test('a cancelled dead key does not replay the line either', async ({ page }) => {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/input')) sent.push(r.postData() ?? '');
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('.xterm-screen').first().click();
  await page.keyboard.type('echo DEAD', { delay: 25 });
  await expect(page.locator('.xterm-rows')).toContainText('echo DEAD', { timeout: 10_000 });
  await page.waitForTimeout(300);
  const after = sent.length;

  await page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    ta.focus();
    // The textarea still carries the line: that is what gets replayed.
    ta.value = 'echo DEAD';
    ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, bubbles: true }));
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
  });
  await page.waitForTimeout(800);

  const flat = sent.slice(after).flatMap((b) => JSON.parse(b).data as number[]);
  expect(flat, 'a cancelled dead key sends nothing at all').toEqual([]);
  await expect(page.locator('.xterm-rows')).not.toContainText('echo DEADecho DEAD');
});
