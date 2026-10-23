/**
 * The one place the app writes raw HTML from text somebody else typed.
 *
 * A board belongs to a collection (ADR 0016), so on a shared server a note card is
 * written by whoever can edit that collection and read by everyone else in it —
 * through `dangerouslySetInnerHTML` in `BoardModal`. `mdMini` is what stands between
 * those two facts, and it had no test: the escaping and the markup are five chained
 * `replace` calls, and their ORDER is the whole security property. Swap two of them
 * and `<img onerror=…>` reaches the DOM of every member of that collection.
 *
 * Loads apps/desktop/src/utils/board.ts directly: Node strips the types and the module
 * imports nothing at runtime, so this tests the shipped code rather than a copy of it —
 * the same arrangement split-format-check uses.
 *
 * Run: node e2e/board-markup-check.mjs
 */
import assert from 'node:assert/strict';
import { mdMini, parseBoard } from '../apps/desktop/src/utils/board.ts';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('a note card cannot carry markup of its own:');

check('a tag somebody typed arrives as text, not as a tag', () => {
  const out = mdMini('<script>alert(1)</script>');
  assert.equal(out, '&lt;script&gt;alert(1)&lt;/script&gt;');
  // The point, stated so a refactor cannot satisfy the line above by accident: no
  // element the author did not mean is left in the string.
  assert.ok(!/<script/i.test(out), 'a script tag survived');
});

check('the only tags in the output are the ones this function inserts', () => {
  // The invariant, rather than a list of payloads to outlaw: take out `<b>`, `</b>`,
  // `<code>`, `</code>` and `<br>` — everything mdMini is allowed to produce — and no
  // angle bracket may be left. Text that merely READS like an attribute (`onerror=` in
  // `&lt;img src=x onerror=alert(1)&gt;`) is inert and has to stay allowed, which is why
  // grepping for `on…=` is the wrong test: it fails on correct output.
  const ALLOWED = /<\/?(?:b|code)>|<br>/g;
  for (const payload of [
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<div onclick=alert(1)>x</div>',
    '<svg/onload=alert(1)>',
    '<iframe src=//evil></iframe>',
    '**<img src=x onerror=alert(1)>**',
    '`<img src=x onerror=alert(1)>`',
  ]) {
    const left = mdMini(payload).replace(ALLOWED, '');
    assert.ok(!left.includes('<') && !left.includes('>'), `${payload} left a tag: ${left}`);
  }
});

check('the markup it does mean still works', () => {
  assert.equal(mdMini('**bold**'), '<b>bold</b>');
  assert.equal(mdMini('`code`'), '<code>code</code>');
  assert.equal(mdMini('a\nb'), 'a<br>b');
});

check('escaping happens before the markup, not after', () => {
  // This is the order that matters. Escaping last would turn the `<b>` this function
  // inserts into `&lt;b&gt;` (no bold at all); escaping first and then matching on the
  // escaped text is what lets a typed `<b>` stay text while `**x**` becomes a tag.
  const out = mdMini('**<b>already bold</b>**');
  assert.equal(out, '<b>&lt;b&gt;already bold&lt;/b&gt;</b>');
});

check('an ampersand is escaped once, not twice', () => {
  // `&` first, then `<` and `>`: the other order yields `&amp;lt;`, which the reader
  // sees as literal "&lt;" instead of "<".
  assert.equal(mdMini('a & b'), 'a &amp; b');
  assert.equal(mdMini('<'), '&lt;');
});

check('nothing at all is not a crash', () => {
  assert.equal(mdMini(''), '');
  assert.equal(mdMini(undefined), '');
});

console.log('a stored board is read without being trusted:');

check('a board that is not an array of cards reads as empty', () => {
  for (const junk of [null, undefined, 42, 'nope', {}, [1, 2], [{ type: 'ghost' }]]) {
    assert.deepEqual(parseBoard(junk), [], `${JSON.stringify(junk)} should read as empty`);
  }
});

console.log(`\n${passed} checks passed`);
