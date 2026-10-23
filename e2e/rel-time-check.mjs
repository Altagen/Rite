/**
 * "Last used" reads in the reader's language, from the unit Rite actually stores.
 *
 * This existed three times, and the three disagreed twice.
 *
 * On the UNIT: every timestamp here is epoch seconds — the server writes `unixepoch()` and
 * `recordLastUsed` mirrors it. One copy divided a difference by a thousand as if it had
 * been given milliseconds, so every machine row in a collection view read some thousands
 * of weeks. A wrong unit does not throw and does not look like a bug in review; it looks
 * like a machine nobody has touched since 1970. The table below is what notices.
 *
 * On the WORDS: the other two translated "never" and "just now" and then appended `m ago`,
 * `h ago`, `w ago` in English whatever the locale. So this also holds every branch to a
 * key that exists in both locales.
 *
 * Run: node e2e/rel-time-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relTime } from '../apps/desktop/src/utils/relTime.ts';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const locale = (name) =>
  JSON.parse(
    readFileSync(new URL(`../apps/desktop/src/i18n/locales/${name}.json`, import.meta.url), 'utf8'),
  );
const EN = locale('en');
const FR = locale('fr');

/** The real resolver's contract, narrowed to what this needs: a key and its params. */
const translator = (dict) => (key, params) => {
  const value = key.split('.').reduce((o, k) => (o == null ? o : o[k]), dict);
  assert.ok(typeof value === 'string', `missing key: ${key}`);
  return value.replace(/\{(\w+)\}/g, (_, name) => String((params ?? {})[name]));
};

const t = translator(EN);
const now = () => Math.floor(Date.now() / 1000);

console.log('the unit is epoch seconds, and every branch is reached:');

const ROWS = [
  ['no timestamp', null, 'Never'],
  ['zero, which is not a time anyone connected at', 0, 'Never'],
  ['this second', now(), 'just now'],
  ['59 seconds', now() - 59, 'just now'],
  ['60 seconds', now() - 60, '1m ago'],
  ['59 minutes', now() - 59 * 60, '59m ago'],
  ['60 minutes', now() - 60 * 60, '1h ago'],
  ['23 hours', now() - 23 * 3600, '23h ago'],
  ['24 hours', now() - 24 * 3600, '1d ago'],
  ['6 days', now() - 6 * 86400, '6d ago'],
  ['7 days', now() - 7 * 86400, '1w ago'],
  ['a year', now() - 365 * 86400, '52w ago'],
];

for (const [name, at, expected] of ROWS) {
  check(name, () => assert.equal(relTime(at, t), expected));
}

check('a timestamp in the future does not read as the future', () => {
  // A clock that moved backwards, or a server slightly ahead. "in 3 minutes" for a
  // past connection is worse than "just now".
  assert.equal(relTime(now() + 600, t), 'just now');
});

check('milliseconds are converted and reported, not rendered wrong', () => {
  // The bug this replaces, made impossible. Without the guard the clamp turns a
  // millisecond timestamp into "just now" forever — a wrong time that looks right, which
  // is the kind nobody notices. So the same instant in either unit must read the same,
  // and whoever passed the wrong one must hear about it.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const instant = Math.floor(Date.now() / 1000) - 3 * 3600;
    assert.equal(relTime(instant * 1000, t), relTime(instant, t), 'the two units must agree');
    assert.equal(relTime(instant, t), '3h ago');
    assert.equal(warnings.length, 1, 'the wrong unit must be reported once');
    assert.match(warnings[0], /epoch seconds/, warnings[0]);
  } finally {
    console.warn = realWarn;
  }
});

console.log('\nand the caller may name its own "never":');

check('an explicit never wins over the key', () => {
  assert.equal(relTime(null, t, { never: '—' }), '—');
  assert.equal(relTime(now() - 120, t, { never: '—' }), '2m ago');
});

console.log('\nevery branch has a key in both locales:');

check('en and fr both resolve all six', () => {
  const fr = translator(FR);
  const at = [null, now(), now() - 120, now() - 7200, now() - 2 * 86400, now() - 21 * 86400];
  const en = at.map((x) => relTime(x, t));
  const francais = at.map((x) => relTime(x, fr));
  assert.equal(new Set(en).size, 6, `en must render six distinct answers: ${en.join(' | ')}`);
  assert.equal(new Set(francais).size, 6, `fr must too: ${francais.join(' | ')}`);
  // Different languages, or one of them is not translated.
  for (let i = 0; i < en.length; i++) {
    assert.notEqual(en[i], francais[i], `en and fr agree on "${en[i]}", so one is untranslated`);
  }
});

check('and the count is substituted, not printed as a placeholder', () => {
  for (const dict of [EN, FR]) {
    const rendered = relTime(now() - 180, translator(dict));
    assert.doesNotMatch(rendered, /\{n\}/, `the placeholder survived: ${rendered}`);
    assert.match(rendered, /3/, `the count is missing: ${rendered}`);
  }
});

console.log(`\n${passed} checks passed`);
