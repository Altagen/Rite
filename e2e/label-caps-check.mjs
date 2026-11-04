/**
 * The label caps, held across two languages.
 *
 * `LABEL_MAX` and `INSTANCE_LABELS_MAX` exist twice — in `store/labelsFormat.ts` for the
 * field and the documents, and in `rite-server` for the route that takes a list from
 * whoever reached it. There is nothing to import across TypeScript and Rust, so the only
 * thing that can keep them equal is an assertion that reads both.
 *
 * WHY THE SERVER HAS THEM AT ALL: the client is not the boundary. `PUT /api/admin/labels`
 * accepts a list from its caller, and an uncapped one would put a megabyte in a row every
 * member reads on every open. Validating twice is the point, not duplication — what would
 * be a defect is the two halves disagreeing, which is what this holds.
 *
 * The same arrangement `e2e/new-tab-cwd-check.mjs` has for `NEW_TAB_CWD_HOME`.
 *
 * Run: node e2e/label-caps-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

import {
  INSTANCE_LABELS_MAX,
  LABELS_MAX,
  LABEL_MAX,
} from '../apps/desktop/src/store/labelsFormat.ts';

const rust = readFileSync('packages/rite-server/src/lib.rs', 'utf8');
const constOf = (name) => {
  const m = new RegExp(`const ${name}: usize = (\\d+);`).exec(rust);
  assert.ok(m, `rite-server no longer declares ${name}`);
  return Number(m[1]);
};

console.log('\nthe caps agree across the two languages:');

check('a word is the same length on both sides', () => {
  assert.equal(constOf('LABEL_MAX'), LABEL_MAX);
});

check('and the instance list the same size', () => {
  assert.equal(constOf('INSTANCE_LABELS_MAX'), INSTANCE_LABELS_MAX);
});

check('the values themselves, pinned', () => {
  // Pinned at literals as well as to each other: two assertions that only compare the
  // sides would both pass while somebody moved both at once, which is the thing a review
  // would want told about.
  assert.equal(LABEL_MAX, 24, 'a word or two — a sentence belongs in the name');
  assert.equal(LABELS_MAX, 8, 'eight chips fit on a card');
  assert.equal(INSTANCE_LABELS_MAX, 200, 'a list to choose from, not a list on one thing');
});

check('a list to choose from is bigger than a list on one thing', () => {
  // The relationship, not just the numbers: whatever they become, the vocabulary has to
  // be able to hold more words than any single machine or conversation carries.
  assert.ok(INSTANCE_LABELS_MAX > LABELS_MAX, `${INSTANCE_LABELS_MAX} vs ${LABELS_MAX}`);
});

console.log();
if (failed) {
  console.log(`❌ ${failed} failed`);
  process.exit(1);
}
console.log('✅ the client and the server agree on how long a word is and how many there are');
