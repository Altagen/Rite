/**
 * What a machine answered, kept across the window (ADR 0022 §4).
 *
 * WHY IT IS KEPT AT ALL, and why this check exists: discovery costs an SSH round trip and
 * is never repeated by itself, so without this, closing the window threw away a reading
 * that had cost a connection to every machine. Reinstalling the binary did exactly that,
 * which is how it was reported.
 *
 * Loads the shipped store directly. `deviceStore` is stubbed with a plain object because
 * the thing being held is the POLICY — what is accepted back, what is capped, which one
 * goes — and not whether a browser has `localStorage`.
 *
 * Run: node e2e/agent-answers-check.mjs
 */
import assert from 'node:assert/strict';

/** A device store in memory, with the two methods the module uses. */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { readAnswers, keepAnswer, forgetAnswers, ANSWER_CAP } =
  await import('../apps/desktop/src/store/agentAnswers.ts');

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

const answer = (at) => ({ at, tools: [{ id: 'claude', installed: true, lines: ['x'] }] });

console.log('\nwhat survives the window:');

check('nothing held is nothing read, not a crash', () => {
  store.clear();
  assert.deepEqual(readAnswers(), {});
});

check('an answer is read back as it was written', () => {
  store.clear();
  keepAnswer('@local', answer(1000));
  assert.deepEqual(readAnswers(), { '@local': answer(1000) });
});

check('and a second machine does not replace the first', () => {
  store.clear();
  keepAnswer('@local', answer(1000));
  keepAnswer('web-01', answer(2000));
  assert.deepEqual(Object.keys(readAnswers()).sort(), ['@local', 'web-01']);
});

check('reading the same machine again replaces its answer', () => {
  // A cache, not a log: what is kept is the last reading, with the time it was taken.
  store.clear();
  keepAnswer('@local', answer(1000));
  keepAnswer('@local', answer(3000));
  assert.equal(readAnswers()['@local'].at, 3000);
  assert.equal(Object.keys(readAnswers()).length, 1);
});

console.log('\nthe cap, and which one goes:');

check('past the cap the least recently read is dropped', () => {
  // It holds the listings themselves — roughly 40 KB for a machine with sixty
  // conversations — so a fleet of forty is a cache that is not worth what it costs.
  store.clear();
  let held = {};
  for (let i = 0; i < ANSWER_CAP + 3; i++) held = keepAnswer(`m${i}`, answer(1000 + i), held);
  const kept = Object.keys(readAnswers()).sort();
  assert.equal(kept.length, ANSWER_CAP);
  // The three oldest went, and the newest stayed.
  assert.equal(kept.includes('m0'), false);
  assert.equal(kept.includes('m2'), false);
  assert.equal(kept.includes(`m${ANSWER_CAP + 2}`), true);
});

check('the cap is a number this file states', () => {
  assert.equal(ANSWER_CAP, 8);
});

console.log('\nwhat is refused on the way back in:');

check('a value that is not an answer is ignored, not trusted', () => {
  // Device storage is a file a person can edit and a browser another page can reach.
  // What comes back is checked for the shape that was written, field by field.
  store.clear();
  localStorage.setItem(
    'rite-agent-answers',
    JSON.stringify({
      good: { at: 1, tools: [] },
      noAt: { tools: [] },
      noTools: { at: 2 },
      wrongAt: { at: 'soon', tools: [] },
      toolsNotArray: { at: 3, tools: { id: 'claude' } },
      notAnObject: 'nope',
    }),
  );
  assert.deepEqual(Object.keys(readAnswers()), ['good']);
});

check('and a document that is not JSON at all is nothing held', () => {
  store.clear();
  localStorage.setItem('rite-agent-answers', 'not json');
  assert.deepEqual(readAnswers(), {});
});

console.log('\nforgetting:');

check('one machine can be forgotten without the others', () => {
  store.clear();
  keepAnswer('@local', answer(1000));
  keepAnswer('web-01', answer(2000));
  forgetAnswers('@local');
  assert.deepEqual(Object.keys(readAnswers()), ['web-01']);
});

check('and all of them at once', () => {
  store.clear();
  keepAnswer('@local', answer(1000));
  forgetAnswers();
  assert.deepEqual(readAnswers(), {});
});

console.log();
if (failed) {
  console.log(`❌ ${failed} failed`);
  process.exit(1);
}
console.log('✅ a machine’s answer survives the window, and the cache stays a cache');
