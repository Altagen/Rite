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
import { offersFrom } from '../apps/desktop/src/store/labelsFormat.ts';

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
  assert.deepEqual(offersFrom([['API'], ['api'], ['Api']], 'org'), [
    { label: 'API', scope: 'org' },
  ]);
  assert.deepEqual(offersFrom([['api'], ['API']], 'org'), [{ label: 'api', scope: 'org' }]);
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
  for (const scope of ['personal', 'collection', 'org']) {
    assert.equal(offersFrom([['x']], scope)[0].scope, scope);
  }
});

console.log();
if (failed) {
  console.log(`❌ ${failed} failed`);
  process.exit(1);
}
console.log('✅ the vocabulary offers one spelling per word, the first one seen');
