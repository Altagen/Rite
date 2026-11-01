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

/* And a section existing in both mocks was not enough either. Clipboard was its own rail
   entry in both pages, so the check above passed — while the desktop offered the copy
   convention and the web page did not have the row at all. The app has one Settings
   component for both shells, so a section with no `native`/`local`/`vault` flag shows the
   SAME controls in a browser as on the desktop. A mock that disagrees is describing a
   product that does not exist.

   Compared by the TITLE of each `prefRow`, which is what a reader scans for, and only for
   the sections a browser can show. Not the markup: the two pages legitimately build some
   rows differently, and pinning the HTML would fail on cosmetics nobody acted on. */
/* Rows that exist in both pages under DIFFERENT names, because they are about different
   things even though they sit in the same section. Named here with the reason, so the
   check stays blunt about everything else: a row missing from one page is drift until
   someone writes down why it is not.

   Keyed both ways, since the check looks from each side in turn. */
const SAME_ROW_OTHER_WORDS = {
  // A browser locks a SESSION; a desktop locks a VAULT. Not the same object.
  'Auto-lock vault': 'Auto-lock session',
  'Auto-lock session': 'Auto-lock vault',
  // The desktop names the instance THIS WINDOW is connected to; the web page names what
  // the server it is served by speaks. Two different facts about two different hosts.
  Server: 'API',
  API: 'Server',
};

/* Rows that exist on ONE page on purpose, each with the decision that put it there. A
   row missing from the other page is drift until it is written down here — which is the
   point: these entries are the record, and adding one is a deliberate act rather than a
   way to quiet the check. */
const ONE_SHELL_ONLY = {
  // ADR 0031 and `shellControls()`: the default shell is the desktop client's own. A
  // browser has no machine of its own, so the instance chooses and offers its list.
  'Shell picker': 'desktop',
  Shell: 'desktop',
  'Another shell': 'desktop',
  'Local shell': 'web',
  'Server shell': 'web',
  // 0.2.8: the web UI has no directory row at all — every terminal there opens in the
  // image's WORKDIR, and a field would offer directories the member cannot write.
  'Preset terminal folder': 'desktop',
  Folder: 'desktop',
  // A browser has no window to strip; the rail entry is already `native`.
  'Focus mode': 'desktop',
  // ADR 0025: server management is web-only.
  'Teams and Collections': 'web',
};

function mockRows(page) {
  const src = read(`design/mock/${page}.html`);
  const out = new Map();
  // Each section runs from its own `{ id:'x', label:'Y', body:()=>` to the next one.
  const heads = [...src.matchAll(/\{ id:'([a-z]+)', label:'([^']+)', body:\(\)=>/g)];
  heads.forEach((h, i) => {
    const body = src.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : src.length);
    out.set(
      h[2],
      [...body.matchAll(/prefRow\(\s*'([^']+)'/g)].map((m) => m[1]).sort(),
    );
  });
  return out;
}

check('a section both shells can show offers the same rows in both mocks', () => {
  const desk = mockRows('desktop');
  const web = mockRows('web');
  const shared = rail.filter((r) => !r.native && !r.local && !r.vault);
  const drifted = [];
  for (const r of shared) {
    const a = desk.get(r.label);
    const b = web.get(r.label);
    if (!a || !b) continue; // absence is the assertion above's job, not this one
    const only = (x, y, side) =>
      x.filter((t) => !y.includes(t) && !SAME_ROW_OTHER_WORDS[t] && ONE_SHELL_ONLY[t] !== side);
    const dOnly = only(a, b, 'desktop');
    const wOnly = only(b, a, 'web');
    if (dOnly.length || wOnly.length) {
      drifted.push(
        `${r.label}: desktop only [${dOnly.join(', ')}] · web only [${wOnly.join(', ')}]`,
      );
    }
  }
  assert.deepEqual(drifted, [], `the two mocks disagree:\n        ${drifted.join('\n        ')}`);
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
