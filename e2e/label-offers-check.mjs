/**
 * The vocabulary's first source: the words already in use.
 *
 * `offersFrom` is what feeds the picker on both screens until a collection's own list and
 * the instance's exist, and it is the function that decides which spelling of a word a
 * person is offered.
 *
 * Run: node e2e/label-offers-check.mjs
 */
import assert from 'node:assert/strict';

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message.split('\n')[0]}`);
    failed++;
  }
};

// Loaded directly, like every other format check here: `store/labelsFormat.ts` imports
// nothing, which is why the label logic lives there and not in the component that draws it.
import {
  INSTANCE_LABELS_MAX,
  LABELS_MAX,
  acceptedUpTo,
  acceptedVocab,
  formatVocab,
  labelColor,
  offersFrom,
} from '../apps/desktop/src/store/labelsFormat.ts';

console.log('\nthe words already in use, as offers:');

check('one word per spelling seen, sorted', () => {
  assert.deepEqual(offersFrom([['web', 'api'], ['api']], 'collection'), [
    { label: 'api', scope: 'collection' },
    { label: 'web', scope: 'collection' },
  ]);
});

check('THE FIRST SPELLING WINS', () => {
  // `API` typed first stays `API` rather than being rewritten by a later `api`. The
  // alternative quietly renames somebody's word on a screen they did not open.
  assert.deepEqual(offersFrom([['API'], ['api'], ['Api']], 'instance'), [
    { label: 'API', scope: 'instance' },
  ]);
  assert.deepEqual(offersFrom([['api'], ['API']], 'instance'), [
    { label: 'api', scope: 'instance' },
  ]);
});

check('an absent list is not an empty word', () => {
  assert.deepEqual(offersFrom([undefined, [], ['api']], 'personal'), [
    { label: 'api', scope: 'personal' },
  ]);
  assert.deepEqual(offersFrom([], 'personal'), []);
});

check('what is not a word is dropped, through the shipped cleaner', () => {
  // Same cleaner as the field and the document, so the picker cannot offer a spelling the
  // document would refuse to store.
  assert.deepEqual(offersFrom([['  ', '  spaced   out  ']], 'collection'), [
    { label: 'spaced out', scope: 'collection' },
  ]);
});

check('the scope is carried, not guessed', () => {
  // The scope IS the confidentiality decision, so it comes from the caller — the screen
  // knows which list it is reading and this function cannot.
  for (const scope of ['personal', 'collection', 'instance']) {
    assert.equal(offersFrom([['x']], scope)[0].scope, scope);
  }
});

console.log('\na colour belongs to the word, and lives beside it:');

const PALETTE = ['#a00000', '#00a000', '#0000a0', '#a0a000', '#a000a0'];

check('a declared colour wins over the derived one', () => {
  // THE WHOLE POINT. `pci` is red because somebody said so, everywhere the word appears —
  // without this a colour would be red in the editor that chose it and derived on every
  // card, which is the one thing choosing it is for.
  const declared = [{ label: 'pci', color: '#ff0000' }];
  assert.equal(labelColor('pci', PALETTE, declared), '#ff0000');
  assert.equal(labelColor('  pci  ', PALETTE, declared), '#ff0000');
  // CASE-FOLDED ON BOTH SIDES, and the declaration is the side that proves it: the stored
  // spelling is whatever was typed, so a word declared `PCI` must answer a lookup for
  // `pci`. The first version of this check declared it lower-case, which a lookup folded
  // on one side only would have passed.
  assert.equal(labelColor('pci', PALETTE, [{ label: 'PCI', color: '#ff0000' }]), '#ff0000');
  assert.equal(labelColor('PCI', PALETTE, [{ label: 'pci', color: '#ff0000' }]), '#ff0000');
  assert.equal(labelColor('Pci', PALETTE, [{ label: 'pCI', color: '#ff0000' }]), '#ff0000');
});

check('a word nobody declared keeps the colour its text gives it', () => {
  const derived = labelColor('eu-west', PALETTE);
  assert.ok(PALETTE.includes(derived));
  assert.equal(labelColor('eu-west', PALETTE, [{ label: 'pci', color: '#ff0000' }]), derived);
  // And a declaration with no colour is not a declaration of a colour.
  assert.equal(labelColor('eu-west', PALETTE, [{ label: 'eu-west' }]), derived);
});

check('the nearer scope wins, because it is the more specific statement', () => {
  // Searched in order, and the caller passes collections before the instance: a
  // collection that declared `pci` green means it for its own machines.
  const declared = [
    { label: 'pci', color: '#00ff00' },
    { label: 'pci', color: '#ff0000' },
  ];
  assert.equal(labelColor('pci', PALETTE, declared), '#00ff00');
});

check('BOTH STORED SHAPES ARE READ, and only one is written per word', () => {
  // A list written before colours existed holds bare strings; refusing it would lose a
  // vocabulary somebody typed. One shape comes out, so callers read one thing.
  assert.deepEqual(acceptedVocab(['pci', { label: 'prod', color: '#7c9cf5' }]), [
    { label: 'pci' },
    { label: 'prod', color: '#7c9cf5' },
  ]);
  // And back out: a word with no colour is written EXACTLY as it was before colours
  // existed, so an uncoloured list round-trips byte for byte and an older build reads it.
  assert.deepEqual(formatVocab([{ label: 'pci' }, { label: 'prod', color: '#7c9cf5' }]), [
    'pci',
    { label: 'prod', color: '#7c9cf5' },
  ]);
  assert.deepEqual(formatVocab(acceptedVocab(['a', 'b'])), ['a', 'b']);
});

check('a colour that is not one is dropped and the word kept', () => {
  // The word is the declaration; the colour is a decoration on it. Refusing the row would
  // lose what was actually typed.
  // `#abc` is in the list on purpose: a shorthand hex is valid CSS and is NOT what is
  // stored, because the two shapes would then disagree about what `#abc` means to a
  // comparison — and a loosened pattern was a mutant that survived once.
  for (const bad of ['red', '#ab', '#abc', '#abcd', '#gggggg', '', 'rgb(1,2,3)', 42, null]) {
    assert.deepEqual(
      acceptedVocab([{ label: 'pci', color: bad }]),
      [{ label: 'pci' }],
      String(bad),
    );
  }
  // Six hex digits with a hash, case-insensitive, is the shape.
  assert.deepEqual(acceptedVocab([{ label: 'pci', color: '#AbCdEf' }]), [
    { label: 'pci', color: '#AbCdEf' },
  ]);
});

check('the offers carry a declared colour through', () => {
  assert.deepEqual(offersFrom([[{ label: 'pci', color: '#ff0000' }, 'web']], 'instance'), [
    { label: 'pci', color: '#ff0000', scope: 'instance' },
    { label: 'web', scope: 'instance' },
  ]);
});

check("THE CAP IS THE CALLER'S, because the two lists are not the same list", () => {
  // The shared field applied the per-thing cap to every list it drew, so a vocabulary
  // editor refused its ninth word while the screen beside it promised two hundred. A cap
  // is a property of the list being edited, not of the walk.
  const twelve = Array.from({ length: 12 }, (_, i) => `w${i}`);
  assert.equal(acceptedUpTo(twelve, LABELS_MAX).length, LABELS_MAX);
  assert.equal(acceptedUpTo(twelve, INSTANCE_LABELS_MAX).length, 12);
  // And the cap is honoured as given, not clamped to something this module prefers.
  assert.equal(acceptedUpTo(twelve, 3).length, 3);
  assert.deepEqual(acceptedUpTo(twelve, 3), ['w0', 'w1', 'w2']);
});

console.log();
if (failed) {
  console.log(`❌ ${failed} failed`);
  process.exit(1);
}
console.log('✅ the vocabulary offers one spelling per word, the first one seen');
