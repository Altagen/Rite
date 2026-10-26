import { test, expect } from '@playwright/test';

/**
 * A dead-key accent must send one character, and nothing else.
 *
 * The sequence below is not invented: it was recorded from the desktop client with
 * `RITE_TRACE_INPUT=1` and a DOM observer, pressing `^` then `o` on an AZERTY keyboard
 * under WebKitGTK. For one character the engine sends THREE keydowns carrying 229 and TWO
 * `compositionend`s, and the character itself appears only on an `input` of type
 * `insertFromComposition`:
 *
 *     keydown 229 / compositionstart / compositionupdate "^"
 *     input insertCompositionText "^"
 *     keydown 229 / input deleteCompositionText / compositionend ""
 *     keydown 229 / input insertFromComposition "ô" / compositionend "ô"
 *
 * xterm.js cannot survive it. `CompositionHelper.keydown` answers a 229 by snapshotting
 * the hidden textarea and comparing it after a `setTimeout(0)`, then sends the difference,
 * or `\x7f` when the value shrank, or the WHOLE textarea when the length matched and the
 * content did not. Nothing clears that textarea on this engine, so it holds everything
 * typed since the pane opened. Depending on which timer lands where, one accent yields the
 * character, a DEL that eats the letter before it, or the entire line replayed.
 *
 * Chromium produces none of this, so no browser test can reach the bug by typing. The
 * events can be dispatched, though, and that is what these do: the measured sequence,
 * verbatim, held to the only acceptable answer. The real engine is covered by
 * `e2e/desktop-bench`, which presses real keys and reads the bytes at the PTY.
 */

/** The measured WebKitGTK sequence for one dead-key accent, dispatched on the textarea. */
const deadKey = (seed: string, accent: string, finalEnd = true) =>
  `(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    if (!ta) throw new Error('no xterm helper textarea');
    ta.focus();
    // What the engine leaves in the textarea: it is never cleared, so it carries the line.
    ta.value = ${JSON.stringify(seed)};
    const key = () => ta.dispatchEvent(new KeyboardEvent('keydown',
      { keyCode: 229, key: 'Unidentified', composed: true, bubbles: true }));
    // Chromium's InputEvent constructor silently drops two of the types this engine
    // sends — \`deleteCompositionText\` and \`insertFromComposition\` come back as \`''\` —
    // so the type is forced onto the event. Without this the accent step is inert and the
    // test passes through a different branch than the one it names.
    const input = (inputType, data) => {
      const e = new InputEvent('input', { data, composed: true, bubbles: true });
      if (e.inputType !== inputType) Object.defineProperty(e, 'inputType', { value: inputType });
      return ta.dispatchEvent(e);
    };
    const comp = (type, data) => ta.dispatchEvent(new CompositionEvent(type,
      { data, composed: true, bubbles: true }));

    key();
    comp('compositionstart', '');
    comp('compositionupdate', '^');
    ta.value = ${JSON.stringify(seed)} + '^';
    input('insertCompositionText', '^');

    key();
    ta.value = ${JSON.stringify(seed)};
    input('deleteCompositionText', null);
    comp('compositionend', '');

    key();
    ta.value = ${JSON.stringify(seed)} + ${JSON.stringify(accent)};
    input('insertFromComposition', ${JSON.stringify(accent)});
    ${finalEnd ? `comp('compositionend', ${JSON.stringify(accent)});` : ''}
  })()`;

/** Open a local shell pane and return a recorder of every byte posted to it. */
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

test('a dead-key accent sends the character once', async ({ page }) => {
  const sent = await terminalWithRecorder(page);

  await page.keyboard.type('echo RITE', { delay: 25 });
  await expect(page.locator('.xterm-rows')).toContainText('echo RITE', { timeout: 10_000 });
  await page.waitForTimeout(300);
  const from = sent.length;

  await page.evaluate(deadKey('echo RITE', 'ô'));
  await page.waitForTimeout(800);

  const flat = sent.slice(from).flat();
  expect(flat, 'one accent, as its two UTF-8 bytes').toEqual([0xc3, 0xb4]);
  expect(flat, 'no DEL: it would erase the character arriving behind it').not.toContain(0x7f);

  const rows = page.locator('.xterm-rows');
  await expect(rows).toContainText('echo RITEô', { timeout: 10_000 });
  await expect(rows, 'the line must not be replayed').not.toContainText('echo RITEecho RITE');
});

test('the character still arrives when the composition ends without it', async ({ page }) => {
  const sent = await terminalWithRecorder(page);
  await page.waitForTimeout(500);
  const from = sent.length;

  // The measured sequence announces the character twice: on `insertFromComposition` and
  // again on the second `compositionend`. Only the first is guaranteed to carry it — the
  // first `compositionend` of that same sequence is already empty — so the character is
  // taken from whichever announces it. Here the final end never comes.
  await page.evaluate(deadKey('', 'é', false));
  await page.waitForTimeout(800);

  expect(sent.slice(from).flat(), 'the insertion alone is enough').toEqual([0xc3, 0xa9]);
});

test('the accumulated textarea is never replayed, however long it is', async ({ page }) => {
  const sent = await terminalWithRecorder(page);
  await page.waitForTimeout(500);
  const from = sent.length;

  // The textarea grows for the life of a pane on this engine. A slice from position zero
  // sends all of it, which is what "one accent printed a flood of characters" was.
  const hoarded = 'une ligne entiere deja tapee et jamais effacee du textarea cache';
  await page.evaluate(deadKey(hoarded, 'ê'));
  await page.waitForTimeout(800);

  const flat = sent.slice(from).flat();
  expect(flat, 'the accent alone, never the hoarded line').toEqual([0xc3, 0xaa]);
  expect(flat.length, 'one character is two bytes, and no more').toBe(2);

  // And the hoard is gone: nothing else empties this textarea on the desktop engine, so a
  // commit that left it full would hand the next composition a line to replay.
  const left = await page.evaluate(
    () => (document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement).value,
  );
  expect(left, 'the commit empties the textarea').toBe('');
});

test('a composition that commits nothing sends nothing', async ({ page }) => {
  const sent = await terminalWithRecorder(page);
  await page.keyboard.type('echo DEAD', { delay: 25 });
  await expect(page.locator('.xterm-rows')).toContainText('echo DEAD', { timeout: 10_000 });
  await page.waitForTimeout(300);
  const from = sent.length;

  // `^` then Escape: the dead key is abandoned and the engine ends a composition that
  // produced no text. The textarea still holds the line, so anything sent here is a replay.
  await page.evaluate(`(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    ta.focus();
    ta.value = 'echo DEAD';
    ta.dispatchEvent(new KeyboardEvent('keydown',
      { keyCode: 229, key: 'Unidentified', composed: true, bubbles: true }));
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
  })()`);
  await page.waitForTimeout(800);

  expect(sent.slice(from).flat(), 'nothing was composed, so nothing is sent').toEqual([]);
  await expect(page.locator('.xterm-rows')).not.toContainText('echo DEADecho DEAD');
});

/**
 * The same guard, in the engine this suite actually runs: Chromium, driven through CDP's
 * `Input.imeSetComposition` so the composition is the browser's own, not a dispatched event.
 *
 * Measured here, and different from WebKitGTK: no `insertFromComposition` at all, the
 * committed text arrives as a last `insertCompositionText` and then `compositionend` carries
 * it. So the two engines exercise the guard's two commit paths, and this is what proves the
 * `compositionend` one — which is also every full input method, not just a dead key.
 */
const compose = async (page: import('@playwright/test').Page, pending: string, commit: string) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', {
    text: pending,
    selectionStart: pending.length,
    selectionEnd: pending.length,
  });
  await page.waitForTimeout(200);
  await cdp.send('Input.insertText', { text: commit });
  await page.waitForTimeout(600);
};

test('a composition driven by the engine itself commits once', async ({ page }) => {
  const sent = await terminalWithRecorder(page);
  await page.waitForTimeout(1000);

  let from = sent.length;
  await compose(page, '^', 'ô');
  expect(sent.slice(from).flat(), 'the accent, once').toEqual([0xc3, 0xb4]);

  // A full input method commits several characters at once, which the dead-key path never
  // sees: it must arrive whole and unduplicated.
  from = sent.length;
  await compose(page, 'nihao', '你好');
  expect(sent.slice(from).flat(), 'both characters, once').toEqual([
    0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd,
  ]);

  await expect(page.locator('.xterm-rows')).toContainText('ô你好', { timeout: 10_000 });
});

test('a composition the engine abandons sends nothing', async ({ page }) => {
  const sent = await terminalWithRecorder(page);
  await page.waitForTimeout(1000);
  const from = sent.length;

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'abc', selectionStart: 3, selectionEnd: 3 });
  await page.waitForTimeout(200);
  // An empty composition is how the engine withdraws a pending one.
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await page.waitForTimeout(600);

  expect(sent.slice(from).flat(), 'a withdrawn composition is not input').toEqual([]);
});

test('a reopened pane still sends one accent', async ({ page }) => {
  // Closing a pane and opening another is the path a user takes all day, and the guard is
  // attached again on the new one. It does not prove the detach: the container the
  // listeners sit on dies with the pane, so a detach that did nothing would pass this too
  // (verified by mutation). There is no frontend unit runner to test that in isolation.
  const sent = await terminalWithRecorder(page);
  await page.waitForTimeout(500);

  await page.getByRole('button', { name: 'Close terminal' }).first().click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('.xterm-screen').first().click();
  await page.waitForTimeout(1000);

  const from = sent.length;
  await compose(page, '^', 'ô');
  expect(sent.slice(from).flat(), 'one accent, from one guard').toEqual([0xc3, 0xb4]);
});

test('the same accent twice in a row arrives twice', async ({ page }) => {
  // The guard remembers what a composition already sent, so the character announced on
  // both `insertFromComposition` and `compositionend` is not sent twice. That memory is
  // reset by `compositionstart`: if it were not, typing the same accent again would be
  // taken for the echo of the first and swallowed.
  const sent = await terminalWithRecorder(page);
  await page.waitForTimeout(1000);

  let from = sent.length;
  await compose(page, '^', 'ô');
  await compose(page, '^', 'ô');
  expect(sent.slice(from).flat(), 'two accents, two characters').toEqual([
    0xc3, 0xb4, 0xc3, 0xb4,
  ]);

  // And the same through the sequence this engine does not produce.
  from = sent.length;
  await page.evaluate(deadKey('', 'ê'));
  await page.waitForTimeout(400);
  await page.evaluate(deadKey('', 'ê'));
  await page.waitForTimeout(800);
  expect(sent.slice(from).flat(), 'twice there too').toEqual([0xc3, 0xaa, 0xc3, 0xaa]);
});

test('a command with accents prints exactly what was typed', async ({ page }) => {
  // The screen itself, not the bytes: a terminal that injects, drops or repeats a line is
  // broken whatever the transport did. The shell echoes the command and prints its output,
  // so each accented word must appear exactly twice — once typed, once printed.
  const sent = await terminalWithRecorder(page);
  await page.waitForTimeout(1000);
  const from = sent.length;

  await page.keyboard.type('echo ', { delay: 25 });
  await page.keyboard.type('d', { delay: 25 });
  await compose(page, "'", 'é');
  await page.keyboard.type('j', { delay: 25 });
  await compose(page, '`', 'à');
  await page.keyboard.type(' ', { delay: 25 });
  await compose(page, '^', 'ô');
  await page.keyboard.type('ter', { delay: 25 });

  const rows = page.locator('.xterm-rows');
  await expect(rows, 'what is typed is what is shown').toContainText('echo déjà ôter', {
    timeout: 10_000,
  });

  await page.keyboard.press('Enter');
  await expect(rows).toContainText('déjà ôter', { timeout: 10_000 });
  await page.waitForTimeout(600);

  const screen = await rows.innerText();
  const occurrences = (needle: string) => screen.split(needle).length - 1;
  expect(occurrences('déjà ôter'), 'once as the command, once as its output').toBe(2);
  expect(occurrences('echo'), 'the command line is not repeated').toBe(1);
  expect(screen, 'no pending accent is left behind').not.toContain('^');
  expect(screen, 'nothing was dropped').toContain('déjà ôter');

  const flat = sent.slice(from).flat();
  expect(flat, 'no DEL was invented along the way').not.toContain(0x7f);
  expect(
    Buffer.from(flat).toString('utf8'),
    'the shell received the command and nothing else',
  ).toBe('echo déjà ôter\r');
});

test('the guard keeps the composition keys and nothing else', async ({ page }) => {
  // 229 says only that an input method owns the keyboard, not that text is being composed:
  // under ibus or fcitx a plain Tab can arrive with that code. The guard used to stop every
  // one of them, which is more than it needs and more than it should — a swallowed Tab is a
  // shell with no completion while typing still works.
  //
  // What the guard decides is measured directly: a listener on the textarea itself runs
  // after the guard's own, on the container, so it fires only for an event the guard let
  // through. (xterm drops a 229 keydown of its own accord — that is upstream's doing and
  // not what this asserts.)
  await terminalWithRecorder(page);
  await page.waitForTimeout(500);

  const reached = await page.evaluate(`(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    const seen = {};
    const keys = ['Tab', 'Enter', 'Backspace', 'ArrowUp', 'Unidentified', 'Process', 'Dead', 'e'];
    const mark = (ev) => { seen[ev.key] = true; };
    ta.addEventListener('keydown', mark);
    for (const key of keys) {
      seen[key] = false;
      ta.dispatchEvent(new KeyboardEvent('keydown',
        { key, keyCode: 229, composed: true, bubbles: true, cancelable: true }));
    }
    ta.removeEventListener('keydown', mark);
    return seen;
  })()`);

  expect(reached, 'named control keys are xterm\'s, compositions are the guard\'s').toEqual({
    Tab: true,
    Enter: true,
    Backspace: true,
    ArrowUp: true,
    Unidentified: false,
    Process: false,
    Dead: false,
    e: false,
  });
});

test('no composition event reaches xterm, so its timers never start', async ({ page }) => {
  /*
   * The guard stops `compositionstart`, `compositionupdate` and `compositionend` as well
   * as the keydowns. That is not belt-and-braces: xterm's `CompositionHelper` arms its
   * own timers from those events — `_finalizeComposition` slices the hidden textarea from
   * an index captured earlier, after a `setTimeout(0)` — and a composition it believes it
   * is handling is a second sender racing ours.
   *
   * Measured the same way as the key decision table: a listener on the textarea itself
   * runs after the guard's, which is on the container, so it fires only for an event the
   * guard let through. Written because mutation said it had to be: removing the
   * `stopPropagation` from `compositionupdate` left every other test in this file green.
   */
  await terminalWithRecorder(page);
  await page.waitForTimeout(500);

  const reached = await page.evaluate(`(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    const seen = { compositionstart: false, compositionupdate: false, compositionend: false };
    const mark = (ev) => { seen[ev.type] = true; };
    for (const type of Object.keys(seen)) ta.addEventListener(type, mark);
    // A whole composition, as WebKitGTK delivers one.
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, cancelable: true }));
    ta.dispatchEvent(new CompositionEvent('compositionupdate',
      { data: '^', bubbles: true, cancelable: true }));
    ta.dispatchEvent(new CompositionEvent('compositionend',
      { data: 'ô', bubbles: true, cancelable: true }));
    for (const type of Object.keys(seen)) ta.removeEventListener(type, mark);
    return seen;
  })()`);

  expect(reached, 'the guard owns the whole composition, not part of it').toEqual({
    compositionstart: false,
    compositionupdate: false,
    compositionend: false,
  });
});
