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
import {
  parseStored,
  parseLayoutPanes,
  formatLayoutPanes,
  layoutDirections,
  isPreset,
  isLayout,
} from '../apps/desktop/src/store/splitsFormat.ts';

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

console.log('\nwriting a layout back out, for the editor:');

check('a layout survives a round trip untouched', () => {
  // The whole point of being able to edit one: a layout opened, not touched and
  // saved must come back the same, or correcting one pane of five quietly rewrites
  // the other four.
  const panes = [
    { name: 'shell', command: '' },
    { name: 'logs', command: 'journalctl -fu app' },
    { name: 'disk', command: 'df -h' },
  ];
  assert.deepEqual(parseLayoutPanes(formatLayoutPanes(panes)), panes);
});

check('a command containing an equals sign survives it too', () => {
  // `parseLayoutPanes` splits on the FIRST equals, so this is the case that breaks
  // if the writer ever decides to quote or escape.
  const panes = [{ name: 'env', command: 'FOO=bar make run' }];
  assert.deepEqual(parseLayoutPanes(formatLayoutPanes(panes)), panes);
});

check('a pane with no command is written with its equals sign', () => {
  // Both forms parse the same; the explicit one shows the field exists.
  assert.equal(formatLayoutPanes([{ name: 'shell', command: '' }]), 'shell =');
});

check('an empty layout writes an empty string, not a blank line', () => {
  assert.equal(formatLayoutPanes([]), '');
  assert.deepEqual(parseLayoutPanes(formatLayoutPanes([])), []);
});

console.log('\nhow a layout divides the tab:');

check('the direction alternates, so panes land in a grid', () => {
  // Five panes all split the same way is six columns, which is nobody's "five
  // terminals arranged like this".
  assert.deepEqual(layoutDirections(4, 'horizontal'), [
    'horizontal',
    'vertical',
    'horizontal',
    'vertical',
  ]);
});

check('it starts where the caller says', () => {
  // The chevron passes the direction its own split button would have used.
  assert.deepEqual(layoutDirections(3, 'vertical'), ['vertical', 'horizontal', 'vertical']);
});

check('one pane is one split, and none is none', () => {
  assert.deepEqual(layoutDirections(1, 'horizontal'), ['horizontal']);
  assert.deepEqual(layoutDirections(0, 'horizontal'), []);
});

console.log('\nthe shape of a stored entry:');

check('a preset needs an id, a name, and a command that is a string', () => {
  assert.equal(isPreset({ id: 'a', name: 'A', command: 'top' }), true);
  // The empty command is the plain shell and is meaningful; a missing one is not.
  assert.equal(isPreset({ id: 'a', name: 'A', command: '' }), true, 'empty command is a plain shell');
  assert.equal(isPreset({ id: 'a', name: 'A' }), false, 'no command');
  assert.equal(isPreset({ id: 'a', command: 'top' }), false, 'no name');
  assert.equal(isPreset({ name: 'A', command: 'top' }), false, 'no id');
  assert.equal(isPreset({ id: 'a', name: '  ', command: 'top' }), false, 'a blank name is not a name');
  assert.equal(isPreset({ id: 'a', name: 'A', command: 42 }), false, 'a command that is not text');
});

check('nothing that is not an object is a preset', () => {
  // Guarding the JSON and not the shape was half a guard: `["nope"]` parses, and
  // then `preset.name` is undefined in a menu row and `preset.id` is a React key
  // that collides with every other one.
  for (const entry of [null, undefined, 'nope', 42, true, [], () => {}]) {
    assert.equal(isPreset(entry), false, String(entry));
  }
});

check('a layout needs a name and panes, and each pane needs its two fields', () => {
  assert.equal(isLayout({ id: 'l', name: 'L', panes: [{ name: 'shell', command: '' }] }), true);
  assert.equal(isLayout({ id: 'l', name: 'L', panes: [] }), true, 'an empty layout is still a layout');
  assert.equal(isLayout({ id: 'l', name: 'L' }), false, 'no panes');
  assert.equal(isLayout({ id: 'l', name: 'L', panes: 'shell' }), false, 'panes that are not a list');
  assert.equal(isLayout({ id: 'l', name: 'L', panes: [{ name: 'shell' }] }), false, 'a pane with no command');
  assert.equal(isLayout({ id: 'l', name: 'L', panes: [null] }), false, 'a pane that is nothing');
});

check('one bad entry costs one entry, not the whole library', () => {
  // The alternative is that a single mistyped row sends the user back to the
  // defaults and loses the presets they still had.
  const raw = JSON.stringify([
    { id: 'a', name: 'A', command: 'top' },
    'nope',
    { id: 'b', name: 'B', command: 'df -h' },
  ]);
  assert.deepEqual(parseStored(raw, DEFAULTS, isPreset), [
    { id: 'a', name: 'A', command: 'top' },
    { id: 'b', name: 'B', command: 'df -h' },
  ]);
});

check('a stored list of nothing but rubbish is empty, not the defaults', () => {
  // It parsed and it was a list, so the user did configure something — badly.
  // Handing back the defaults here would silently resurrect presets they removed.
  assert.deepEqual(parseStored('[1,2,3]', DEFAULTS, isPreset), []);
});

check('without a filter nothing is dropped, so old callers are unchanged', () => {
  assert.deepEqual(parseStored('[1,2]', DEFAULTS), [1, 2]);
});

console.log(`\n${passed} checks passed`);
