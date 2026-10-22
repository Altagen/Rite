/**
 * The mock speaks the way the product speaks.
 *
 * `design/mock/` is the source of truth for UI/UX (ADR 0019): a feature is drawn there
 * first, and the implementation follows. So when the app's 122 strings were rewritten to
 * address nobody — no you, no your, no vous — and the mock kept 258 of them, the mock became
 * the place the old register would come back from. The next feature copied out of it would
 * have brought "your vault" and "you can only narrow it" along, and nobody would have known
 * why.
 *
 * Comments are exempt, and deliberately. The mock's prose explains design decisions to a
 * reader, at length, the way the rest of this repository does; "you" belongs there. What is
 * checked is what a person would see on screen.
 *
 * Run: node e2e/mock-register-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../design/mock/', import.meta.url);

/** Comments out, so prose may address its reader while the interface does not. */
function visible(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

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

console.log('the mock addresses nobody either:');

const files = readdirSync(DIR).filter((f) => /\.(html|js)$/.test(f));

check('no mock screen says you or your', () => {
  assert.ok(files.length >= 10, `only ${files.length} mock files found — the scan is wrong`);
  const found = [];
  for (const f of files) {
    const src = visible(readFileSync(new URL(f, DIR), 'utf8'));
    for (const [i, line] of src.split('\n').entries()) {
      for (const m of line.matchAll(/\b(your|yours|you)\b/gi)) {
        found.push(`${f}:${i + 1}  …${line.trim().slice(Math.max(0, m.index - 30), m.index + 50)}…`);
      }
    }
  }
  assert.deepEqual(
    found,
    [],
    `${found.length} address(es) left in the mock:\n        ` + found.slice(0, 12).join('\n        '),
  );
});

console.log(`\n${passed} checks passed`);
