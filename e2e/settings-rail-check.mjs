/**
 * What the Settings rail PROMISES, read off the component that draws it.
 *
 * The rail is how a setting is found at all — scrolling stopped working at fourteen
 * sections — so the questions worth pinning are: does every entry resolve to a word, is a
 * section that a server must not offer marked so, and is a row that was argued about in
 * the section it was given.
 *
 * WHAT THIS NO LONGER DOES IS COMPARE TWO DRAWINGS. It used to hold `design/mock/*.html`
 * against this component, and comparing a copy to the original is how host-key
 * verification sat under Security in the app and under SSH in the drawing for two
 * releases with nothing failing: the comparison was of RAILS, and the rows were where the
 * drift was. `e2e/tests/settings-surfaces.spec.ts` asks the same questions of the real
 * screen in both shells, where the answer cannot be a copy of itself.
 *
 * Run: node e2e/settings-rail-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const EN = JSON.parse(read('apps/desktop/src/i18n/locales/en.json'));

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

/** The app's rail, in order, with the flags that decide where a section appears. */
function appRail() {
  const source = read('apps/desktop/src/components/Settings.tsx');
  // Anchored on the declaration's own name: the file has a second table of the same
  // shape (the fixed shortcuts), and an unanchored match found that one.
  const table = source.match(/const RAIL: \{[\s\S]*?\}\[\] = \[([\s\S]*?)\n\];/);
  assert.ok(table, 'Settings.tsx no longer declares `const RAIL` as expected');
  const rows = [...table[1].matchAll(/\{ id: '([a-z]+)', i18n: '([\w.]+)'([^}]*)\}/g)];
  assert.ok(rows.length > 8, `only ${rows.length} rail entries parsed`);
  return rows.map(([, id, key, rest]) => ({
    id,
    label: key.split('.').reduce((o, k) => (o == null ? o : o[k]), EN),
    native: rest.includes('native: true'),
    local: rest.includes('local: true'),
    vault: rest.includes('vault: true'),
  }));
}

const rail = appRail();

check('every rail entry resolves to a label', () => {
  const nameless = rail.filter((r) => typeof r.label !== 'string');
  assert.deepEqual(
    nameless.map((r) => r.id),
    [],
    'a rail entry points at a missing key',
  );
});

console.log('\nand the sections a server context must not offer:');

check('Labels is local-only, so a server never shows it in user settings', () => {
  // THE SURFACE FOLLOWS THE OWNER. On a local vault the instance vocabulary is the
  // person's own and belongs with their settings; the moment a server is in the picture it
  // is the INSTANCE's, and an administrator writes it in the console (ADR 0025). A DESKTOP
  // SIGNED INTO AN INSTANCE is a server context too — `isLocalContext` reads the server's
  // own mode, not the shell — so it must not show it either, which is the case this pins.
  const labels = rail.find((r) => r.label === 'Labels');
  assert.ok(labels, 'the rail no longer has a Labels section');
  assert.equal(labels.local, true, 'Labels must be marked `local` or a server will show it');
});

/* A section existing on both sides was never enough. Host-key verification sat in the app's
   Security section while the mock showed it under SSH, for two releases, and this file
   passed the whole time because it compared the RAIL and not the rows. A reader looking for
   a setting about SSH under SSH did not find it.

   So the rows that have a home worth pinning are named here with it. Not every row: a
   wholesale extraction would re-check the obvious and break on cosmetics. These are the
   ones whose placement was argued about, which is exactly the set that drifts. */
const PLACED = [
  { id: 'host-key-mode', section: 'ssh', why: 'a policy about SSH belongs with SSH' },
  { id: 'server-host-key', section: 'ssh', why: 'the server-side report of the same policy' },
  { id: 'auto-lock', section: 'security', why: 'locking the vault is not an SSH concern' },
];

/** Which `<section hidden={shown !== 'x'}>` encloses a given `testId`/`data-testid`. */
function sectionHolding(testId) {
  const source = read('apps/desktop/src/components/Settings.tsx');
  const at = source.search(new RegExp(`testId=["']${testId}["']|data-testid=["']${testId}["']`));
  assert.notEqual(at, -1, `Settings.tsx has no row with the test id \`${testId}\``);
  // The nearest section opened before it. Sections are siblings, never nested, so the last
  // one to open is the one still open.
  const opens = [...source.slice(0, at).matchAll(/shown !== '([a-z]+)'/g)];
  assert.ok(opens.length > 0, `no section encloses \`${testId}\``);
  return opens[opens.length - 1][1];
}

console.log('\nand a row that was argued about is in the section it was given:');

for (const { id, section, why } of PLACED) {
  check(`${id} → ${section}`, () => {
    assert.equal(sectionHolding(id), section, `${why} (found it under \`${sectionHolding(id)}\`)`);
  });
}

/* KnownHostsList renders no row of its own, so it is pinned by the guard that mounts it:
   the list belongs beside the policy that fills it. */
check('the known-hosts list mounts in the same section', () => {
  const source = read('apps/desktop/src/components/Settings.tsx');
  const m = source.match(/\{shown === '([a-z]+)' && <KnownHostsList \/>\}/);
  assert.ok(m, 'KnownHostsList is no longer mounted behind a `shown ===` guard');
  assert.equal(m[1], 'ssh', 'the list reports the result of the host-key policy above it');
});

console.log(`\n${passed} checks passed`);
