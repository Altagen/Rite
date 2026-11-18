/**
 * The names a person gave to conversations, as a document of their own (ADR 0022 §6).
 *
 * WHY THIS FILE EXISTS RATHER THAN A FEW CASES IN `layout-file-check`. Marks were in the
 * workspace document for one release and moved out, and the reason was not size: a mark
 * is keyed to a conversation id on a machine, and a vendor's tool rotates those away, so
 * marks accumulate dead entries. Rite may prune a document it owns and must not prune a
 * person's configuration file — which settles which file they live in.
 *
 * It holds the half that has no server in it: what is accepted back out of storage, and
 * what one rename does to the list. The support (a file here, a sealed blob on an
 * account) is the store's, and the two shapes it writes are pinned below.
 *
 * Run: node e2e/marks-check.mjs
 */
import assert from 'node:assert/strict';

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

import { readFileSync } from 'node:fs';
import {
  acceptedMarks as accepted,
  formatMarks,
  withMark,
} from '../apps/desktop/src/store/marksFormat.ts';
// The label half lives next door, because a machine carries labels too and neither
// document's format module should import the other's.
import {
  LABELS_MAX,
  LABEL_MAX,
  acceptedLabels,
  cleanLabel,
  labelColor,
} from '../apps/desktop/src/store/labelsFormat.ts';

/** The store itself is read as text: what is held there is an ORDER, not a value. */
const src = readFileSync(new URL('../apps/desktop/src/store/marks.ts', import.meta.url), 'utf8');

const mark = (over = {}) => ({
  machine: '@local',
  tool: 'codex',
  id: '01a0-xyz',
  name: 'le portage',
  ...over,
});

console.log('\nwhat is accepted back:');

check('a document Rite wrote is read back whole', () => {
  assert.deepEqual(accepted({ version: 1, marks: [mark(), mark({ id: 'b', color: '#7c9cf5' })] }), [
    mark(),
    mark({ id: 'b', color: '#7c9cf5' }),
  ]);
});

check('nothing, and the wrong kind of nothing, are both empty', () => {
  for (const bad of [null, undefined, 'nope', 42, {}, { marks: null }, { marks: 'x' }]) {
    assert.deepEqual(accepted(bad), [], JSON.stringify(bad));
  }
});

check('a row missing any of its three keys is not a mark', () => {
  // None of the three is unique alone: two machines hold the same tool, two tools the
  // same id shape. A row short of one of them names nothing, and keeping it would put a
  // name on whatever happened to match.
  for (const drop of ['machine', 'tool', 'id', 'name']) {
    const row = mark();
    delete row[drop];
    assert.deepEqual(accepted({ marks: [row] }), [], drop);
    assert.deepEqual(accepted({ marks: [{ ...mark(), [drop]: '' }] }), [], `${drop} empty`);
    assert.deepEqual(accepted({ marks: [{ ...mark(), [drop]: 7 }] }), [], `${drop} not a string`);
  }
});

check('a colour that is not one is dropped, and the mark is kept', () => {
  // The name is the mark; the colour is a decoration on it. Refusing the whole row for a
  // bad colour would lose the thing a person actually typed.
  assert.deepEqual(accepted({ marks: [mark({ color: 7 })] }), [mark()]);
  assert.deepEqual(accepted({ marks: [mark({ color: '' })] }), [mark()]);
});

check('a good row beside a bad one survives it', () => {
  assert.deepEqual(accepted({ marks: [{ machine: '@local' }, mark()] }), [mark()]);
});

console.log('\nwhat is written:');

check('the document says which shape it is', () => {
  // Versioned so a later shape can be told from this one rather than guessed at.
  assert.deepEqual(JSON.parse(formatMarks([mark()])), { version: 1, marks: [mark()] });
});

check('and what it writes is what it reads back', () => {
  const all = [mark(), mark({ id: 'b', color: '#7c9cf5' })];
  assert.deepEqual(accepted(JSON.parse(formatMarks(all))), all);
});

check('and it is written before it is held', () => {
  // A name that failed to reach its support must not be on screen as though it had, so
  // the write is awaited and the state set after it.
  const set = src.slice(src.indexOf('set: async (mark)'));
  const wrote = Math.min(
    ...['await Backend.UserMarks.set', 'await Backend.Marks.put'].map((s) => set.indexOf(s)),
  );
  assert.ok(wrote > 0, 'neither support is written');
  assert.ok(set.indexOf('set({ marks: next') > wrote, 'held before it was written');
});

check('renaming twice replaces rather than stacking', () => {
  // One mark per (machine, tool, id). Two rows for one conversation is a list the view
  // cannot key, and the second would win by accident of order.
  const once = withMark([], mark());
  const twice = withMark(once, mark({ name: 'autre chose' }));
  assert.deepEqual(twice, [mark({ name: 'autre chose' })]);
});

check('an empty name removes the entry rather than emptying it', () => {
  const held = [mark(), mark({ id: 'b' })];
  assert.deepEqual(
    withMark(held, { machine: '@local', tool: 'codex', id: '01a0-xyz', name: null }),
    [mark({ id: 'b' })],
  );
});

check('and a conversation on another machine is left alone', () => {
  // All three keys, or a rename on one machine would take a name off another's.
  const held = [mark(), mark({ machine: 'web-01' }), mark({ tool: 'claude' })];
  const after = withMark(held, { machine: '@local', tool: 'codex', id: '01a0-xyz', name: null });
  assert.deepEqual(after, [mark({ machine: 'web-01' }), mark({ tool: 'claude' })]);
});

console.log('\nwhere it lives:');

check('the account is sealed, and only with a key to seal under', () => {
  // The server holds machine names and first messages it may not read (ADR 0011).
  assert.match(src, /await Backend\.UserMarks\.set\(await seal\(userKey, text\)\)/);
  assert.match(src, /if \(userKey\)/);
});

check('and a blob that will not open leaves what is held alone', () => {
  // Replacing a person's names with nothing because a decrypt failed is the one outcome
  // worse than showing them stale.
  const load = src.slice(src.indexOf('load: async'), src.indexOf('set: async (mark)'));
  const katch = load.indexOf('} catch {');
  assert.ok(katch > 0, 'the account path does not catch');
  assert.ok(
    !load.slice(katch, load.indexOf('}', katch + 12)).includes('marks: []'),
    'a failed unseal empties the marks',
  );
});

console.log('\nlabels — the other question a mark answers:');

const KEY = { machine: '@local', tool: 'claude', id: 'c-1' };

check('a label is trimmed, squeezed to one line and capped in length', () => {
  assert.equal(cleanLabel('  the   api  '), 'the api');
  assert.equal(cleanLabel('a\nb'), 'a b');
  // PINNED AT 24, not at `LABEL_MAX`: an assertion that reads the constant it is meant
  // to hold agrees with whatever the constant becomes, which is no assertion at all.
  // Twenty-four characters is a word or two, which is what a label is for — a sentence
  // belongs in the name.
  assert.equal(LABEL_MAX, 24);
  assert.equal(cleanLabel('x'.repeat(34)).length, 24);
  assert.equal(cleanLabel('x'.repeat(24)).length, 24);
  assert.equal(cleanLabel('x'.repeat(12)).length, 12);
  assert.equal(cleanLabel('   '), '');
});

check('the same label twice is one, whatever case it was typed in', () => {
  // `API` and `api` are ONE label — the comparison folds, and what is STORED is what was
  // typed. Lower-casing on the way in would rewrite somebody's `API` on an edit they did
  // not make, which is the kind of quiet correction nobody asked for.
  assert.deepEqual(acceptedLabels(['API', 'api', 'Api']), ['API']);
  assert.deepEqual(acceptedLabels(['api', 'API']), ['api']);
});

check('what is not a label is dropped, and the list is capped', () => {
  assert.deepEqual(acceptedLabels(['ok', 42, null, {}, '', '  ']), ['ok']);
  assert.deepEqual(acceptedLabels('urgent'), []);
  assert.deepEqual(acceptedLabels(undefined), []);
  // Pinned at 8, for the same reason as above. Eight chips fit on a card; a conversation
  // in thirty groups is in none.
  assert.equal(LABELS_MAX, 8);
  const many = Array.from({ length: 13 }, (_, i) => `l${i}`);
  assert.equal(acceptedLabels(many).length, 8);
  // The cap keeps the FIRST of them, which is the order the person typed.
  assert.deepEqual(acceptedLabels(many), ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7']);
});

check('a colour comes out of the label text, so nothing has to be kept in step', () => {
  const palette = ['#a', '#b', '#c', '#d', '#e'];
  // Case-folded: one label, one colour, however it was typed.
  assert.equal(labelColor('urgent', palette), labelColor('URGENT', palette));
  assert.equal(labelColor('  urgent  ', palette), labelColor('urgent', palette));
  // In the palette, always — a derived index that fell outside it would be no colour.
  for (const word of ['a', 'api', 'urgent', 'the long one', 'déjà']) {
    assert.ok(palette.includes(labelColor(word, palette)), word);
  }
  // AND IT READS THE TEXT, NOT ITS LENGTH — which is a property of the HASH, so it is
  // asked of a palette wide enough that a collision would be a coincidence rather than
  // arithmetic. `hash = key.length` passed the first version of this check: seven words
  // of assorted lengths landed on four of five colours and looked like a spread.
  const wide = Array.from({ length: 256 }, (_, i) => `#${i}`);
  const same = ['api', 'web', 'doc'].map((w) => labelColor(w, wide));
  assert.equal(new Set(same).size, 3, `${same.join(' ')} — same length, same colour`);

  // How many colours nine real labels actually get out of the shipped palette is a
  // property of the PALETTE's size, not of the hash, so it is a separate claim and a
  // modest one: a handful of labels must not all look alike.
  const nine = ['#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8', '#9'];
  const seen = new Set(
    ['api', 'web', 'doc', 'urgent', 'later', 'spike', 'infra', 'docs', 'ops'].map((w) =>
      labelColor(w, nine),
    ),
  );
  assert.ok(seen.size >= 4, `${seen.size} distinct colours for nine words`);
});

check('a conversation can be labelled without being named, and the other way round', () => {
  // Two answers to two questions: a name is "which one is this", a label is "which group
  // is this in". Either alone is a mark.
  assert.deepEqual(accepted({ marks: [{ ...KEY, labels: ['api'] }] }), [
    { ...KEY, name: '', labels: ['api'] },
  ]);
  assert.deepEqual(accepted({ marks: [{ ...KEY, name: 'the port' }] }), [
    { ...KEY, name: 'the port' },
  ]);
});

check('and a row with neither marks nothing, so it is not a mark', () => {
  assert.deepEqual(accepted({ marks: [{ ...KEY }] }), []);
  assert.deepEqual(accepted({ marks: [{ ...KEY, name: '', labels: [] }] }), []);
  assert.deepEqual(accepted({ marks: [{ ...KEY, labels: [7] }] }), []);
});

check('an edit writes the labels, and emptying both removes the row', () => {
  const one = withMark([], { ...KEY, name: 'the port', labels: ['api', 'api', 'URGENT'] });
  assert.deepEqual(one, [{ ...KEY, name: 'the port', labels: ['api', 'URGENT'] }]);
  // Editing twice replaces rather than stacking.
  assert.deepEqual(withMark(one, { ...KEY, name: '', labels: ['web'] }), [
    { ...KEY, name: '', labels: ['web'] },
  ]);
  // Nothing left to say ⇒ the row goes, which is what the Clear button does too: the two
  // gestures cannot leave the document in different states.
  assert.deepEqual(withMark(one, { ...KEY, name: '', labels: [] }), []);
  assert.deepEqual(withMark(one, { ...KEY, name: null }), []);
});

check('labels survive a write and a read of the document', () => {
  const marks = [{ ...KEY, name: 'the port', color: '#7c5cff', labels: ['api', 'urgent'] }];
  assert.deepEqual(accepted(JSON.parse(formatMarks(marks))), marks);
});

console.log();
if (failed) {
  console.log(`❌ ${failed} failed`);
  process.exit(1);
}
console.log('✅ a name is kept in a document Rite owns, and only a mark is read back');
