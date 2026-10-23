/**
 * The mock's Settings rail is the app's Settings rail.
 *
 * The rail is how a setting is found at all — scrolling stopped working at fourteen
 * sections — so a section the mock does not have is a section the design does not describe,
 * and a section the mock alone has is a promise nothing keeps. They drifted: the app split
 * Clipboard into its own entry and the mocks kept it as a line inside Security, where
 * nobody looks for it.
 *
 * Compared by LABEL rather than by id, because the ids already disagree harmlessly (`shell`
 * in the app, `terminals` in the mock) while a label is what a reader sees. Presence, not
 * order: the order is a design call, and pinning it would fail for a reason nobody acted on.
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

/** The mock page's rail labels. */
const mockRail = (page) =>
  [...read(`design/mock/${page}.html`).matchAll(/\{ id:'[a-z]+', label:'([^']+)'/g)].map(
    (m) => m[1],
  );

const rail = appRail();

check('every rail entry resolves to a label', () => {
  const nameless = rail.filter((r) => typeof r.label !== 'string');
  assert.deepEqual(nameless.map((r) => r.id), [], 'a rail entry points at a missing key');
});

console.log('\nthe desktop mock has every section the desktop app can show:');

check('desktop', () => {
  const have = mockRail('desktop');
  // The desktop is a machine with a vault, so it can show all of them.
  const missing = rail.filter((r) => !have.includes(r.label)).map((r) => r.label);
  assert.deepEqual(missing, [], `absent from design/mock/desktop.html: ${missing.join(', ')}`);
});

console.log('\nand the web mock has every section a browser can show:');

check('web', () => {
  const have = mockRail('web');
  // A browser has no native window and no local vault, so focus mode, the master password
  // and the danger zone are absent BY DESIGN — and must stay absent rather than drift in.
  const expected = rail.filter((r) => !r.native && !r.local && !r.vault);
  const missing = expected.filter((r) => !have.includes(r.label)).map((r) => r.label);
  assert.deepEqual(missing, [], `absent from design/mock/web.html: ${missing.join(', ')}`);
  const forbidden = rail
    .filter((r) => r.native || r.local || r.vault)
    .filter((r) => have.includes(r.label))
    .map((r) => r.label);
  assert.deepEqual(forbidden, [], `a browser cannot show these, so the mock must not: ${forbidden.join(', ')}`);
});

console.log(`\n${passed} checks passed`);
