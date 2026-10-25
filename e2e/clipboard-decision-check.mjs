/**
 * The terminal's clipboard decision, as a table.
 *
 * Loads `apps/desktop/src/utils/terminalClipboard.ts` directly: Node strips the types and
 * that module imports nothing at runtime, so this tests the shipped decision rather than a
 * copy of it.
 *
 * WHY THIS EXISTS RATHER THAN A BROWSER TEST. Two of these cases cannot be measured
 * honestly in a browser, and both were found trying:
 *
 *   - a hand-built `paste` event carrying empty data is reported cancelled and delivers
 *     nothing on its own, with or without the guard — so a spec built on it passed with
 *     the guard removed;
 *   - a real middle click pastes whatever X11 holds, which a page cannot clear, so "there
 *     is nothing to paste" is a precondition no browser test can establish.
 *
 * The engine halves that CAN be measured are in `e2e/tests/clipboard.spec.ts` (Chromium)
 * and the `clipboard` scenario of `e2e/desktop-bench` (WebKitGTK, which is what ships).
 */
import assert from 'node:assert/strict';
import { planClipboard } from '../apps/desktop/src/utils/terminalClipboard.ts';

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

/** A keydown on xterm's textarea, with the terminal's selection as `text`. */
const key = (over = {}) => ({
  type: 'keydown',
  onTextarea: true,
  key: 'c',
  ctrlKey: true,
  shiftKey: true,
  metaKey: false,
  altKey: false,
  text: 'selected text',
  ...over,
});

/** A paste on xterm's textarea, with what it carries as `text`. */
const paste = (text) => ({ type: 'paste', onTextarea: true, text });

console.log('\nthe copy chord:');

check('Ctrl+Shift+C with a selection copies it', () => {
  assert.deepEqual(planClipboard(key()), { kind: 'copy', text: 'selected text' });
});

check('and the text copied is the selection, not a label', () => {
  // Pinned to an exact value: an assertion that merely checks `kind` would pass on a
  // guard that copied the wrong string.
  assert.deepEqual(planClipboard(key({ text: 'echo exactly-this' })), {
    kind: 'copy',
    text: 'echo exactly-this',
  });
});

check('Cmd+C copies, for macOS where it does not collide with SIGINT', () => {
  assert.deepEqual(
    planClipboard(key({ ctrlKey: false, shiftKey: false, metaKey: true })),
    { kind: 'copy', text: 'selected text' },
  );
});

check('the chord is case-blind, because Shift makes the letter upper', () => {
  assert.deepEqual(planClipboard(key({ key: 'C' })), { kind: 'copy', text: 'selected text' });
});

console.log('\nwhat the chord must NOT claim:');

check('Ctrl+C alone is the shell’s, and stays the shell’s', () => {
  // The whole reason copy needs its own chord: this one has to keep interrupting.
  assert.deepEqual(planClipboard(key({ shiftKey: false })), { kind: 'ignore' });
});

check('with nothing selected the chord is not ours', () => {
  // Claiming it would make a dead key of it, and copying an empty selection would wipe
  // whatever was already on the clipboard.
  assert.deepEqual(planClipboard(key({ text: '' })), { kind: 'ignore' });
});

check('Ctrl+Shift+Alt+C is somebody else’s chord', () => {
  assert.deepEqual(planClipboard(key({ altKey: true })), { kind: 'ignore' });
});

check('Ctrl+Shift+V is left alone, so paste happens once', () => {
  // Both engines already paste on it. Claiming it here would send the text twice.
  assert.deepEqual(planClipboard(key({ key: 'v' })), { kind: 'ignore' });
});

check('another letter with the same modifiers is not copy', () => {
  assert.deepEqual(planClipboard(key({ key: 'x' })), { kind: 'ignore' });
});

check('an event off the textarea is none of our business', () => {
  assert.deepEqual(planClipboard(key({ onTextarea: false })), { kind: 'ignore' });
});

console.log('\npaste:');

check('a paste carrying text is xterm’s to deliver', () => {
  assert.deepEqual(planClipboard(paste('pasted-text')), { kind: 'ignore' });
});

check('a paste carrying nothing is dropped', () => {
  // Before this, a middle click with an empty clipboard sent ESC[200~ ESC[201~ — two
  // escape sequences around no text, measured on both engines.
  assert.deepEqual(planClipboard(paste('')), { kind: 'drop-paste' });
});

check('a single space is text, and is pasted', () => {
  // The boundary, stated: "nothing" means an empty string, not whitespace. A space is
  // something a person meant to paste.
  assert.deepEqual(planClipboard(paste(' ')), { kind: 'ignore' });
});

check('a newline alone is text too', () => {
  assert.deepEqual(planClipboard(paste('\n')), { kind: 'ignore' });
});

check('an empty paste off the textarea is still not ours', () => {
  assert.deepEqual(planClipboard({ type: 'paste', onTextarea: false, text: '' }), {
    kind: 'ignore',
  });
});

console.log('\nanything else:');

check('an event type the guard does not handle is ignored', () => {
  assert.deepEqual(planClipboard({ type: 'input', onTextarea: true, text: 'x' }), {
    kind: 'ignore',
  });
});

console.log();
if (failed) {
  console.log(`❌ ${failed} failed`);
  process.exit(1);
}
console.log('✅ the clipboard decision table holds');
