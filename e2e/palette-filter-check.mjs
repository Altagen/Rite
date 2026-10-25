/**
 * What a palette query matches, and in what order.
 *
 * Loads `apps/desktop/src/shortcuts/palette.ts` directly: Node strips the types and that
 * module imports nothing at runtime, so this tests the shipped ranking rather than a copy.
 *
 * WHY A CHECK AND NOT A BROWSER TEST. Ranking IS the behaviour of a palette — it is what
 * decides which command Enter runs — and it is a pure function of a query and a list.
 * Asserting it through a real window would cost seconds per case for something that is a
 * table, and the cases that matter most are the ties: two entries at the same rank, where
 * only the table's own order may break them. A browser test would pass on whichever came
 * out first and never notice when that changed.
 */
import assert from 'node:assert/strict';
import { filterPalette } from '../apps/desktop/src/shortcuts/palette.ts';

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

/** A small list in a deliberate order, so ties can be told from ranking. */
const ENTRIES = [
  { id: 'pane.close', label: 'Close pane', description: 'Closes the focused pane' },
  { id: 'pane.splitHorizontal', label: 'Split horizontally', description: 'A terminal beside' },
  { id: 'pane.splitVertical', label: 'Split vertically', description: 'A terminal below' },
  { id: 'pane.search', label: 'Search in pane', description: 'Find text in the scrollback' },
  { id: 'vault.lock', label: 'Lock the vault', description: 'Forget the master key' },
  { id: 'settings.open', label: 'Open settings', description: 'The settings window' },
];
const ids = (q) => filterPalette(ENTRIES, q).map((e) => e.id);

console.log('\nan empty query:');

check('returns everything, in the table’s own order', () => {
  // A palette that opens empty is a menu, and a menu has an order — decided in
  // `commands.ts`, not here.
  assert.deepEqual(ids(''), ENTRIES.map((e) => e.id));
  assert.deepEqual(ids('   '), ENTRIES.map((e) => e.id));
});

check('and does not hand back the caller’s array', () => {
  // Returning the input would let a caller's sort reorder the table itself.
  const out = filterPalette(ENTRIES, '');
  assert.notEqual(out, ENTRIES);
  assert.deepEqual(out, ENTRIES);
});

console.log('\nmatching:');

check('is case-blind in both directions', () => {
  assert.deepEqual(ids('CLOSE'), ['pane.close']);
  assert.deepEqual(ids('close'), ['pane.close']);
});

check('every word has to appear, so more typing always narrows', () => {
  assert.deepEqual(ids('split'), ['pane.splitHorizontal', 'pane.splitVertical']);
  assert.deepEqual(ids('split vertically'), ['pane.splitVertical']);
  // Two words are an AND, never an OR: the second one may not widen the first.
  assert.deepEqual(ids('split lock'), []);
});

check('word order does not matter, because typing order is not a ranking', () => {
  assert.deepEqual(ids('vertically split'), ['pane.splitVertical']);
});

check('a word only the description carries still finds the command', () => {
  assert.deepEqual(ids('scrollback'), ['pane.search']);
});

check('nothing matching returns nothing, rather than everything', () => {
  // The failure mode worth naming: a filter that falls back to the full list on no match
  // makes Enter run whatever happens to be first.
  assert.deepEqual(ids('zzzz'), []);
});

check('a token nothing contains is dropped before any regex is built', () => {
  // These are filtered out by the substring conjunction, so they never reach the
  // word-start test at all. Worth stating, because it is why the case below needs a
  // label that actually carries the character.
  assert.deepEqual(ids('pane.'), []);
  assert.deepEqual(ids('('), []);
  assert.deepEqual(ids('*'), []);
});

check('a metacharacter that DOES appear is matched literally, and does not throw', () => {
  // The word-start test builds a RegExp from the token. An unescaped `(` makes an invalid
  // pattern and takes the whole palette down with it — and the only way to reach that is
  // a label that really contains the character, which is what the entries below are for.
  // Found by mutation: the earlier version of this check removed the escaping and stayed
  // green, because every metacharacter it tried was dropped one step earlier.
  const entries = [
    { id: 'paren', label: 'Export (encrypted)', description: '' },
    { id: 'plus', label: 'C++ mode', description: '' },
    { id: 'dot', label: 'Open a.b file', description: '' },
  ];
  const run = (q) => filterPalette(entries, q).map((e) => e.id);
  assert.deepEqual(run('('), ['paren']);
  assert.deepEqual(run('(encrypted)'), ['paren']);
  assert.deepEqual(run('c++'), ['plus']);
  // And literally, not as a pattern: `a.b` must not match `axb`.
  assert.deepEqual(run('a.b'), ['dot']);
  assert.deepEqual(filterPalette([{ id: 'x', label: 'axb' }], 'a.b'), []);
});

console.log('\nranking:');

check('a label that starts with the query comes before one that contains it', () => {
  // "Search in pane" starts with it; "Close pane" and the splits only mention it.
  assert.deepEqual(ids('search'), ['pane.search']);
  assert.equal(ids('close')[0], 'pane.close');
});

check('a word start beats an appearance mid-word', () => {
  // On its own list, because the realistic one has no mid-word case — the splits do not
  // say "pane" at all, which is how an earlier version of this test came to assert four
  // results and demonstrate nothing.
  const out = filterPalette(
    [
      { id: 'mid', label: 'Unpaneled view', description: '' },
      { id: 'word', label: 'Close pane', description: '' },
    ],
    'pane',
  ).map((e) => e.id);
  assert.deepEqual(out, ['word', 'mid']);
});

check('and on the real list, two word starts keep the table\u2019s order', () => {
  // "Close pane" and "Search in pane" both carry it at a word start; the splits carry it
  // nowhere, label or description, so they are absent rather than ranked last.
  assert.deepEqual(ids('pane'), ['pane.close', 'pane.search']);
});

check('the label beats the description', () => {
  // "Open settings" has it in the label; "The settings window" is the same word in a
  // description. The label wins, whatever the table order says.
  const out = filterPalette(
    [
      { id: 'other', label: 'Something else', description: 'about settings' },
      { id: 'settings.open', label: 'Open settings', description: 'The settings window' },
    ],
    'settings',
  ).map((e) => e.id);
  assert.deepEqual(out, ['settings.open', 'other']);
});

/**
 * This is what the sort's stability buys, and the reason there is no explicit tiebreaker
 * to go with it: an `|| a.at - b.at` in the comparator said the same thing twice and no
 * mutation could remove it, because `Array.prototype.sort` has been required to be stable
 * since ES2019. The assertion below is what holds the behaviour now.
 */
check('a tie keeps the order the table gave', () => {
  // The two splits rank identically on "split". Their order here is the order they were
  // given, and a sort that was not stable would be free to swap them between renders.
  assert.deepEqual(ids('split'), ['pane.splitHorizontal', 'pane.splitVertical']);
  const flipped = [...ENTRIES].reverse();
  assert.deepEqual(
    filterPalette(flipped, 'split').map((e) => e.id),
    ['pane.splitVertical', 'pane.splitHorizontal'],
  );
});

check('only the FIRST word decides the rank', () => {
  // The word being typed is the first one. Letting a later word improve the rank would
  // make the list reorder itself mid-word, under the cursor.
  const entries = [
    { id: 'a', label: 'Zebra split', description: '' },
    { id: 'b', label: 'Split zebra', description: '' },
  ];
  assert.deepEqual(
    filterPalette(entries, 'zebra split').map((e) => e.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    filterPalette(entries, 'split zebra').map((e) => e.id),
    ['b', 'a'],
  );
});

console.log('\nedges:');

check('an entry with no description is matched on its label alone', () => {
  const out = filterPalette([{ id: 'x', label: 'Lock the vault' }], 'vault');
  assert.deepEqual(out.map((e) => e.id), ['x']);
});

check('an empty list stays empty', () => {
  assert.deepEqual(filterPalette([], ''), []);
  assert.deepEqual(filterPalette([], 'anything'), []);
});

console.log();
if (failed) {
  console.log(`❌ ${failed} failed`);
  process.exit(1);
}
console.log('✅ the palette ranks the way it says it does');
