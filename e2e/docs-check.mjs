/**
 * What the documentation claims about the code, checked against the code.
 *
 * `docs/SERVER.md` lists the settings an instance may declare as code, and counts them in
 * a sentence. That list is written by hand and the code's is `config::SETTINGS`, so they
 * drift — this release added four keys and the document said ten, which is the kind of
 * wrong that reads as authoritative: an operator writes a key the document knows about,
 * and the instance refuses to start naming it a typo.
 *
 * Run: node e2e/docs-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

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

/** The keys `config::SETTINGS` declares, in the order the table lists them. */
function settingsInCode() {
  const source = read('packages/rite-server/src/config.rs');
  const table = source.match(/pub const SETTINGS: &\[\(&str, Shape\)\] = &\[(.*?)\];/s);
  assert.ok(table, 'config.rs no longer has a SETTINGS table shaped as expected');
  return [...table[1].matchAll(/\("([a-z_]+)",/g)].map((m) => m[1]);
}

/** The keys `docs/SERVER.md` says exist, from the sentence that enumerates them. */
function settingsInDocs() {
  const doc = read('docs/SERVER.md');
  const listed = doc.match(/The full list: (.*?)\. A key outside/s);
  assert.ok(listed, 'SERVER.md no longer has a "The full list: …" sentence');
  return [...listed[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
}

const code = settingsInCode();
const docs = settingsInDocs();

console.log('the documented instance settings are the real ones:');

check('the code has a settings table to compare against', () => {
  assert.ok(code.length >= 10, `only ${code.length} settings found in config.rs`);
});

check('every documented key exists in the code', () => {
  const unknown = docs.filter((k) => !code.includes(k));
  assert.deepEqual(unknown, [], `SERVER.md documents keys the server refuses: ${unknown.join(', ')}`);
});

check('every key in the code is documented', () => {
  const missing = code.filter((k) => !docs.includes(k));
  assert.deepEqual(missing, [], `declarable but undocumented: ${missing.join(', ')}`);
});

check('and the count in the prose matches', () => {
  const doc = read('docs/SERVER.md');
  const said = doc.match(/^(\w+) settings govern how an instance behaves/m);
  assert.ok(said, 'SERVER.md no longer opens that section by counting the settings');
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
    'eighteen', 'nineteen', 'twenty'];
  assert.equal(
    words.indexOf(said[1].toLowerCase()),
    code.length,
    `the prose says ${said[1]} and there are ${code.length}`,
  );
});

console.log(`\n${passed} checks passed (${code.length} settings)`);
