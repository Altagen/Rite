/**
 * The server speaks English, and speaks it the same way everywhere.
 *
 * A decision, not an omission: `rite-server` returns its errors as English prose, and the
 * client shows them as they arrive. Translating them would mean a stable error CODE per
 * refusal — `invalid_credentials`, `remote_requires_https` — looked up in the locales, which
 * is the right design and a change to the API contract. With no users yet, that contract is
 * cheap to change later and expensive to get wrong now, so it waits (see docs/SERVER.md).
 *
 * What does NOT wait is consistency. Twenty-eight messages written one at a time had drifted:
 * eight addressed the caller in the second person while the app's own strings had just stopped
 * doing that, two throttles said the same thing with different punctuation, and one word was
 * British in an American file. A reader meeting two of them in a row could tell they were
 * written by different hands.
 *
 * So this holds the shape rather than the wording — which is all a check can hold, and all
 * that was actually wrong.
 *
 * Run: node e2e/server-errors-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../packages/rite-server/src/lib.rs', import.meta.url), 'utf8');
const MESSAGES = [...SRC.matchAll(/"error":\s*"([^"]{6,})"/g)].map((m) => m[1]);

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

console.log('the server refuses in one voice:');

check('the scan found the messages', () => {
  assert.ok(MESSAGES.length >= 20, `only ${MESSAGES.length} server errors found — the scan is wrong`);
});

check('no refusal addresses its caller', () => {
  // The app stopped saying "you"; a message that crosses the wire and lands in the same
  // banner cannot keep saying it. An API error has a caller, not a reader.
  const addressing = MESSAGES.filter((m) => /\b(you|your|yours|yourself)\b/i.test(m));
  assert.deepEqual(
    [...new Set(addressing)],
    [],
    `${addressing.length} message(s) address the caller:\n        ` + addressing.join('\n        '),
  );
});

check('a refusal is a lower-case fragment, not a sentence', () => {
  // All twenty-eight are lower-case and unterminated, because the client frames them —
  // a capital and a full stop here would read as a second sentence inside one banner.
  const odd = MESSAGES.filter((m) => /^[A-Z]/.test(m) || /[.!]$/.test(m));
  assert.deepEqual(
    [...new Set(odd)],
    [],
    `${odd.length} message(s) break the shape:\n        ` + odd.join('\n        '),
  );
});

check('one punctuation for an afterthought', () => {
  // "too many attempts, try again later" against "too many sign-up attempts — try again
  // later": the same shape, said two ways, which is how a reader notices the seams.
  const commaSplice = MESSAGES.filter((m) => /, (try|use|ask|edit|wait) /i.test(m));
  assert.deepEqual(
    [...new Set(commaSplice)],
    [],
    `${commaSplice.length} message(s) join a clause with a comma — use an em dash:\n        ` +
      commaSplice.join('\n        '),
  );
});

console.log(`\n${passed} checks passed`);
