/**
 * One palette per kind of swatch, in one place (#396).
 *
 * Eight components declared their own hex array for the same job, and nothing made them
 * agree. The visible defect: creating a collection from the workspace offered grey where
 * the panel offered pink, so a pink collection reopened there showed no swatch selected.
 * Measured across the six palettes a user picks from, each failed to offer 9 of the 17
 * colours some other surface can store — the same bug between every pair.
 *
 * Three constants and not one, because the kinds differ. AVATAR is derived
 * (`AVATAR[hash % length]`), so its length and order are load-bearing and are pinned here
 * value by value. COLLECTION and MACHINE are chosen and stored, so what matters is
 * coverage: each is the union of the copies it replaced, and nothing already saved loses
 * its swatch.
 *
 * Run: node e2e/swatch-palette-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

const SWATCHES = 'apps/desktop/src/theme/swatches.ts';
const src = read(SWATCHES);

/** The colours of one exported palette, in source order. */
function palette(name) {
  const m = src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(m, `${name} is no longer exported from ${SWATCHES}`);
  return m[1].match(/#[0-9a-fA-F]{6}/g) ?? [];
}

const AVATAR = palette('AVATAR_SWATCHES');
const COLLECTION = palette('COLLECTION_SWATCHES');
const MACHINE = palette('MACHINE_SWATCHES');

check('the derived palette keeps its exact length and order', () => {
  // `AVATAR[hash % AVATAR.length]`: a colour added, removed or moved repaints every member.
  // Pinned value by value, because an assertion on the length alone would pass a reorder.
  assert.deepEqual(AVATAR, [
    '#7c9cf5', '#9ece6a', '#e5b567', '#f0a35e',
    '#f7768e', '#bb9af7', '#56c7c0', '#e0af68',
  ]);
});

check('the chosen palettes cover what their copies offered', () => {
  // The 8th colour is where each set drifted, so each union has to hold both answers.
  for (const c of ['#f472b6', '#94a3b8']) {
    assert.ok(COLLECTION.includes(c), `a collection stored as ${c} would show no swatch`);
  }
  for (const c of ['#94a3b8', '#8b93a7']) {
    assert.ok(MACHINE.includes(c), `a machine or folder stored as ${c} would show no swatch`);
  }
});

check('a palette offers each colour once', () => {
  for (const [name, p] of [['AVATAR', AVATAR], ['COLLECTION', COLLECTION], ['MACHINE', MACHINE]]) {
    assert.equal(new Set(p).size, p.length, `${name} offers the same colour twice`);
  }
});

check('the two chosen palettes overlap in exactly the one grey', () => {
  // Measured, not assumed: both drifted to `#94a3b8` as their 8th, so the sets are not
  // disjoint — the first version of this check claimed they were and failed. The other
  // sixteen colours are what make collapsing them a migration rather than an edit, and the
  // overlap is pinned so any further merging has to say what happens to stored values.
  const shared = COLLECTION.filter((c) => MACHINE.includes(c));
  assert.deepEqual(shared, ['#94a3b8'], 'the sets have started to merge without a migration');
});

check('no component declares a palette of its own', () => {
  const dir = 'apps/desktop/src/components';
  const guilty = readdirSync(resolve(ROOT, dir))
    .filter((f) => f.endsWith('.tsx'))
    // Two hex literals in a row is an array of them; one is a lone colour, which the
    // inline-style inventory governs.
    .filter((f) => /'#[0-9a-fA-F]{6}',\s*\n?\s*'#[0-9a-fA-F]{6}'/.test(read(`${dir}/${f}`)));
  assert.deepEqual(guilty, [], 'these grow their own swatch palette again');
});

check('every picker reads the shared module', () => {
  const sites = {
    'MemberPicker.tsx': ['AVATAR_SWATCHES', 'COLLECTION_SWATCHES'],
    'TeamsDashboard.tsx': ['AVATAR_SWATCHES'],
    'CollectionsPanel.tsx': ['COLLECTION_SWATCHES'],
    'CollectionEditDialog.tsx': ['COLLECTION_SWATCHES'],
    'CollectionFolderDialog.tsx': ['MACHINE_SWATCHES'],
    'LibraryFolderDialog.tsx': ['MACHINE_SWATCHES'],
    'ConnectionForm.tsx': ['MACHINE_SWATCHES'],
  };
  for (const [file, names] of Object.entries(sites)) {
    const text = read(`apps/desktop/src/components/${file}`);
    assert.match(text, /from '\.\.\/theme\/swatches'/, `${file} no longer imports the palettes`);
    for (const n of names) {
      assert.ok(text.includes(n), `${file} no longer uses ${n}`);
    }
  }
});

check('the mock carries the same machine palette', () => {
  // The mock is a standalone file and cannot import, so it keeps a copy by necessity —
  // two of them, which is why this palette had nine carriers and not seven. A copy that
  // cannot be removed is a copy that has to be checked, or it drifts the way the eight in
  // the components did. The mock was a colour behind when this was written.
  const wanted = `[${MACHINE.map((c) => `'${c}'`).join(',')}]`;
  for (const f of ['design/mock/desktop.html', 'design/mock/web.html']) {
    assert.ok(
      read(f).includes(`const COLORS=${wanted};`),
      `${f} offers a different machine palette from the application's`,
    );
  }
});

check('the terminal theme stays in the other layer', () => {
  // Rite themes in two layers, and a swatch names an object in the UI rather than a colour
  // the shell prints with. The application layer must not reach into the terminal's.
  // The file's own header names both layers on purpose, so only the code is read: a
  // comment that explains the boundary is not a crossing of it.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /ITheme|terminalPool/);
  assert.doesNotMatch(read('apps/desktop/src/utils/terminalPool.ts'), /theme\/swatches/);
});

console.log(`\n${passed} checks passed (${AVATAR.length} avatar, ${
  COLLECTION.length} collection, ${MACHINE.length} machine swatches)`);
