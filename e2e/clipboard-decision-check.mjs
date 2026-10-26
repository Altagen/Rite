/**
 * The terminal's clipboard decision, as a table, across every mode.
 *
 * Loads `apps/desktop/src/utils/terminalClipboard.ts` directly: Node strips the types and
 * that module imports nothing at runtime, so this tests the shipped decision rather than a
 * copy of it.
 *
 * WHY THIS EXISTS RATHER THAN A BROWSER TEST. Two cases cannot be measured honestly in a
 * browser, and both were found trying:
 *
 *   - a hand-built `paste` event carrying empty data is reported cancelled and delivers
 *     nothing on its own, with or without the guard — so a spec built on it passed with
 *     the guard removed;
 *   - a real middle click pastes whatever X11 holds, which a page cannot clear, so "there
 *     is nothing to paste" is a precondition no browser test can establish.
 *
 * And a third, which arrived with the modes: there are four of them and each one has to be
 * held to what it claims AND to what it must leave alone, which is sixteen cases before
 * counting the edges. A browser test per cell would be minutes of real terminals for
 * decisions that are a pure function of five fields.
 *
 * The engine halves that CAN be measured are in `e2e/tests/clipboard.spec.ts` (Chromium)
 * and the `clipboard` scenario of `e2e/desktop-bench` (WebKitGTK, which is what ships).
 */
import assert from 'node:assert/strict';
import {
  planClipboard,
  CLIPBOARD_MODES,
  DEFAULT_CLIPBOARD_MODE,
  isClipboardMode,
} from '../apps/desktop/src/utils/terminalClipboard.ts';

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`);
    failed++;
  }
};

const IGNORE = { kind: 'ignore' };

/** A keydown on xterm's textarea, with the terminal's selection as `text`. */
const key = (over = {}) => ({
  type: 'keydown',
  where: 'textarea',
  mode: 'chord',
  key: 'c',
  ctrlKey: true,
  shiftKey: true,
  metaKey: false,
  altKey: false,
  text: 'selected text',
  ...over,
});

/** A native paste on the textarea, with what it carries as `text`. */
const paste = (text, mode = 'chord') => ({ type: 'paste', where: 'textarea', mode, text });

/** A mouse release in the terminal, with the selection it leaves behind as `text`. */
const mouseup = (over = {}) => ({
  type: 'mouseup',
  where: 'terminal',
  mode: 'chord',
  button: 0,
  text: 'dragged text',
  ...over,
});

const rightClick = (mode) => ({ type: 'contextmenu', where: 'terminal', mode });

console.log('\nthe modes themselves:');

check('the shipped default is the behaviour that came before them', () => {
  assert.equal(DEFAULT_CLIPBOARD_MODE, 'chord');
});

check('every mode is named, and nothing else is', () => {
  assert.deepEqual(CLIPBOARD_MODES, ['chord', 'select', 'selectRightPaste', 'ctrlC']);
  for (const m of CLIPBOARD_MODES) assert.equal(isClipboardMode(m), true, m);
  // What a configuration file must be refused for, so a typo is not a silent default.
  for (const bad of ['Chord', 'CHORD', 'xterm', '', ' chord', null, 3, {}, undefined]) {
    assert.equal(isClipboardMode(bad), false, JSON.stringify(bad));
  }
});

console.log('\nthe explicit chord, which every mode keeps:');

for (const mode of CLIPBOARD_MODES) {
  check(`Ctrl+Shift+C copies the selection in ${mode}`, () => {
    assert.deepEqual(planClipboard(key({ mode })), { kind: 'copy', text: 'selected text' });
  });
}

check('the text copied is the selection, not a label', () => {
  // Pinned to an exact value: an assertion that checked only `kind` would pass on a guard
  // that copied the wrong string.
  assert.deepEqual(planClipboard(key({ text: 'echo exactly-this' })), {
    kind: 'copy',
    text: 'echo exactly-this',
  });
});

check('Cmd+C copies, for macOS where it does not collide with SIGINT', () => {
  assert.deepEqual(planClipboard(key({ ctrlKey: false, shiftKey: false, metaKey: true })), {
    kind: 'copy',
    text: 'selected text',
  });
});

check('the chord is case-blind, because Shift makes the letter upper', () => {
  assert.deepEqual(planClipboard(key({ key: 'C' })), { kind: 'copy', text: 'selected text' });
});

check('with nothing selected the chord is not ours, in any mode', () => {
  // Claiming it would make a dead key of it, and copying an empty selection would wipe
  // whatever was already on the clipboard.
  for (const mode of CLIPBOARD_MODES) {
    assert.deepEqual(planClipboard(key({ mode, text: '' })), IGNORE, mode);
  }
});

console.log('\nthe interrupt:');

check('Ctrl+C alone interrupts in every mode but the one named for it', () => {
  for (const mode of ['chord', 'select', 'selectRightPaste']) {
    assert.deepEqual(planClipboard(key({ mode, shiftKey: false })), IGNORE, mode);
  }
});

check('ctrlC mode copies on Ctrl+C when something is selected', () => {
  assert.deepEqual(planClipboard(key({ mode: 'ctrlC', shiftKey: false })), {
    kind: 'copy',
    text: 'selected text',
  });
});

check('and interrupts on Ctrl+C when nothing is', () => {
  // The cost of that mode is bounded here: with no selection it is the interrupt it has
  // always been, so a runaway command can still be stopped.
  assert.deepEqual(planClipboard(key({ mode: 'ctrlC', shiftKey: false, text: '' })), IGNORE);
});

check('Ctrl+Alt+C is not the interrupt and not the chord', () => {
  for (const mode of CLIPBOARD_MODES) {
    assert.deepEqual(planClipboard(key({ mode, shiftKey: false, altKey: true })), IGNORE, mode);
  }
});

console.log('\ncopying by selection:');

check('a left-button release over a selection copies in select', () => {
  assert.deepEqual(planClipboard(mouseup({ mode: 'select' })), {
    kind: 'copy',
    text: 'dragged text',
  });
});

check('and in selectRightPaste', () => {
  assert.deepEqual(planClipboard(mouseup({ mode: 'selectRightPaste' })), {
    kind: 'copy',
    text: 'dragged text',
  });
});

check('but never in chord or ctrlC, where only a chord copies', () => {
  for (const mode of ['chord', 'ctrlC']) {
    assert.deepEqual(planClipboard(mouseup({ mode })), IGNORE, mode);
  }
});

check('a release that selected nothing copies nothing', () => {
  // A plain click clears the selection, and clearing it must not wipe the clipboard.
  assert.deepEqual(planClipboard(mouseup({ mode: 'select', text: '' })), IGNORE);
});

check('a middle-button release is the engine’s paste, never a copy', () => {
  // Claiming it would copy the selection at the moment of pasting over it.
  assert.deepEqual(planClipboard(mouseup({ mode: 'select', button: 1 })), IGNORE);
});

check('a right-button release is not a copy either', () => {
  assert.deepEqual(planClipboard(mouseup({ mode: 'selectRightPaste', button: 2 })), IGNORE);
});

console.log('\npasting by right click:');

check('a right click pastes in selectRightPaste', () => {
  assert.deepEqual(planClipboard(rightClick('selectRightPaste')), { kind: 'paste' });
});

check('and opens the engine’s own menu in every other mode', () => {
  // Giving up the native context menu is the price of that one gesture, so only the mode
  // named for it pays it.
  for (const mode of ['chord', 'select', 'ctrlC']) {
    assert.deepEqual(planClipboard(rightClick(mode)), IGNORE, mode);
  }
});

console.log('\nthe native paste:');

check('a paste carrying text is the engine’s to deliver, in every mode', () => {
  for (const mode of CLIPBOARD_MODES) {
    assert.deepEqual(planClipboard(paste('pasted-text', mode)), IGNORE, mode);
  }
});

check('a paste carrying nothing is dropped, in every mode', () => {
  // Before this, a middle click with an empty clipboard sent ESC[200~ ESC[201~ — two
  // escape sequences around no text, measured on both engines.
  for (const mode of CLIPBOARD_MODES) {
    assert.deepEqual(planClipboard(paste('', mode)), { kind: 'drop-paste' }, mode);
  }
});

check('a single space is text, and is pasted', () => {
  // The boundary, stated: "nothing" means an empty string, not whitespace. A space is
  // something a person meant to paste.
  assert.deepEqual(planClipboard(paste(' ')), IGNORE);
});

check('a newline alone is text too', () => {
  assert.deepEqual(planClipboard(paste('\n')), IGNORE);
});

console.log('\nwhere the event landed:');

check('nothing outside the terminal is ever ours', () => {
  for (const mode of CLIPBOARD_MODES) {
    assert.deepEqual(planClipboard(key({ mode, where: 'elsewhere' })), IGNORE, mode);
    assert.deepEqual(planClipboard(mouseup({ mode, where: 'elsewhere' })), IGNORE, mode);
    assert.deepEqual(
      planClipboard({ type: 'contextmenu', where: 'elsewhere', mode }),
      IGNORE,
      mode,
    );
    assert.deepEqual(
      planClipboard({ type: 'paste', where: 'elsewhere', mode, text: '' }),
      IGNORE,
      mode,
    );
  }
});

check('a key that did not land on the textarea reached xterm by another road', () => {
  // Keys only reach the terminal through its hidden textarea. One arriving from anywhere
  // else is not a terminal keystroke, so the chord does not apply to it.
  assert.deepEqual(planClipboard(key({ where: 'terminal' })), IGNORE);
});

check('a selection release off the textarea IS ours, because mice never land there', () => {
  // The mirror of the rule above, and the reason `where` has three values rather than a
  // boolean: a mouseup lands on the screen, never on the textarea.
  assert.deepEqual(planClipboard(mouseup({ mode: 'select', where: 'terminal' })), {
    kind: 'copy',
    text: 'dragged text',
  });
});

console.log('\nanything else:');

check('an event type the guard does not handle is ignored', () => {
  for (const mode of CLIPBOARD_MODES) {
    assert.deepEqual(planClipboard({ type: 'input', where: 'textarea', mode, text: 'x' }), IGNORE);
    assert.deepEqual(planClipboard({ type: 'mousedown', where: 'terminal', mode, text: 'x' }), IGNORE);
    assert.deepEqual(planClipboard({ type: 'copy', where: 'terminal', mode, text: 'x' }), IGNORE);
  }
});

console.log();
if (failed) {
  console.log(`❌ ${failed} failed`);
  process.exit(1);
}
console.log('✅ the clipboard decision table holds, in every mode');
