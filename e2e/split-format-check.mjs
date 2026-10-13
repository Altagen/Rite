/**
 * The two parses behind split presets and layouts.
 *
 * Loads apps/desktop/src/store/splitsFormat.ts directly: Node strips the types and
 * the module imports nothing at runtime, so this tests the shipped code rather than
 * a copy of it — the same arrangement pane-tree-check uses.
 *
 * Both functions exist because of a failure mode rather than a feature:
 *
 *   * `parseStored` decides what happens when the stored key is corrupt, and the
 *     wrong answer there silently empties someone's presets;
 *   * `parseLayoutPanes` decides what a hand-written layout means, and the wrong
 *     answer there produces a pane with no name or a command cut in half.
 *
 * Run: node e2e/split-format-check.mjs
 */
import assert from 'node:assert/strict';
import { parseStored, parseLayoutPanes } from '../apps/desktop/src/store/splitsFormat.ts';

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

const DEFAULTS = [{ id: 'a', name: 'A', command: 'x' }];

console.log('parseStored — a corrupt library must not look like an empty one:');

check('no stored key at all falls back to the defaults', () => {
  assert.deepEqual(parseStored(null, DEFAULTS), DEFAULTS);
});

check('an empty list is honoured, not replaced by the defaults', () => {
  // "I deleted them all" and "I never configured any" are different statements, and
  // only the second one deserves the defaults back.
  assert.deepEqual(parseStored('[]', DEFAULTS), []);
});

check('a stored library is returned as stored', () => {
  const stored = [{ id: 'b', name: 'B', command: 'y' }];
  assert.deepEqual(parseStored(JSON.stringify(stored), DEFAULTS), stored);
});

check('unparseable JSON falls back instead of throwing', () => {
  assert.deepEqual(parseStored('{not json', DEFAULTS), DEFAULTS);
});

check('valid JSON that is not a list falls back', () => {
  // A key overwritten by something else entirely — an object, a string, null —
  // must not reach the UI as a library.
  assert.deepEqual(parseStored('{"a":1}', DEFAULTS), DEFAULTS);
  assert.deepEqual(parseStored('"hello"', DEFAULTS), DEFAULTS);
  assert.deepEqual(parseStored('null', DEFAULTS), DEFAULTS);
});

console.log('\nparseLayoutPanes — what a hand-written layout means:');

check('a bare name is a pane with a plain shell', () => {
  assert.deepEqual(parseLayoutPanes('shell'), [{ name: 'shell', command: '' }]);
});

check('name = command splits on the first equals, and trims both sides', () => {
  assert.deepEqual(parseLayoutPanes('  logs   =   journalctl -fu app  '), [
    { name: 'logs', command: 'journalctl -fu app' },
  ]);
});

check('a command containing = keeps all of it', () => {
  // Splitting on every equals would quietly truncate this to `RUST_LOG`.
  assert.deepEqual(parseLayoutPanes('env = RUST_LOG=debug cargo run'), [
    { name: 'env', command: 'RUST_LOG=debug cargo run' },
  ]);
});

check('order is the order written', () => {
  const panes = parseLayoutPanes('shell\nlogs = journalctl -f\ncontainers = docker ps');
  assert.deepEqual(panes.map((p) => p.name), ['shell', 'logs', 'containers']);
});

check('blank lines and whitespace-only lines are dropped', () => {
  assert.equal(parseLayoutPanes('shell\n\n   \nlogs').length, 2);
});

check('a line with no name is dropped, not kept as a nameless pane', () => {
  // `= top` has a command and nothing to call it; a pane with an empty header is
  // worse than no pane.
  assert.deepEqual(parseLayoutPanes('= top'), []);
  assert.deepEqual(parseLayoutPanes('shell\n= top'), [{ name: 'shell', command: '' }]);
});

check('an empty layout is an empty list, not one blank pane', () => {
  assert.deepEqual(parseLayoutPanes(''), []);
  assert.deepEqual(parseLayoutPanes('\n\n'), []);
});

check('a trailing equals is a named pane with a plain shell', () => {
  // How the placeholder itself writes the first line: `shell =`.
  assert.deepEqual(parseLayoutPanes('shell ='), [{ name: 'shell', command: '' }]);
});

console.log(`\n${passed} checks passed`);
