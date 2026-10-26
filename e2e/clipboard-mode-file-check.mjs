/**
 * The file's copy-mode vocabulary is the terminal's copy-mode vocabulary.
 *
 * WHY TWO LISTS EXIST AT ALL. `utils/terminalClipboard.ts` holds the modes the terminal
 * acts on; `store/layoutsFormat.ts` holds the ones the parser accepts. Neither may import
 * the other, because both are loaded by standalone checks through Node's type stripping,
 * which needs an explicit `.ts` on every specifier — and `layoutsFormat.ts` imports nothing
 * by design, which is what lets `layout-file-check.mjs` and `split-format-check.mjs` read
 * it at all.
 *
 * So the duplication is deliberate and this is what makes it safe. It is the same
 * arrangement the Settings rail already uses between the mock and the app: two artefacts,
 * one check comparing them. The alternative was a parser that accepted any string and left
 * a typo to be ignored in silence, with no line number — which is the failure this subset
 * of TOML exists to avoid.
 *
 * The two ways this drifts are both caught below: a mode added to the terminal and not to
 * the file is a mode nobody can ask for, and a mode added to the file and not to the
 * terminal is a file that parses into a behaviour that does not exist.
 */
import assert from 'node:assert/strict';
import { FILE_COPY_MODES, parseLayoutFile } from '../apps/desktop/src/store/layoutsFormat.ts';
import {
  CLIPBOARD_MODES,
  DEFAULT_CLIPBOARD_MODE,
  isClipboardMode,
} from '../apps/desktop/src/utils/terminalClipboard.ts';

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

console.log('\nthe two lists:');

check('name the same modes, in the same order', () => {
  // Order as well as membership: both are shown to a person — the file's list appears in
  // the parser's error message, and the terminal's drives the Settings control — and two
  // orders would read as two different sets of options.
  assert.deepEqual([...FILE_COPY_MODES], [...CLIPBOARD_MODES]);
});

check('and every one the file accepts, the terminal acts on', () => {
  for (const mode of FILE_COPY_MODES) {
    assert.equal(isClipboardMode(mode), true, `the terminal refuses ${mode}`);
  }
});

console.log('\nwhat the parser does with it:');

const parse = (text) => parseLayoutFile(text);

check('a file with no [terminal] leaves the mode unset', () => {
  // Unset and not defaulted: the default belongs to the terminal, so a file that says
  // nothing must not look like a file that chose the default. Otherwise changing the
  // shipped default would stop reaching anyone whose file had ever been parsed.
  const out = parse('# nothing here\n');
  assert.equal(out.error, null);
  assert.deepEqual(out.terminal, {});
  assert.equal(out.terminal.copyMode, undefined);
});

check('a mode the file names is carried through', () => {
  for (const mode of FILE_COPY_MODES) {
    const out = parse(`[terminal]\ncopyMode = "${mode}"\n`);
    assert.equal(out.error, null, `${mode}: ${out.error?.message}`);
    assert.equal(out.terminal.copyMode, mode);
  }
});

check('it sits beside the layouts rather than instead of them', () => {
  // The file carries behaviour AND arrangement now (ADR 0023, addendum), so the sections
  // have to coexist in either order.
  // A layout needs at least one pane, which the parser is right to insist on — an
  // earlier version of this fixture left it out and failed for that instead.
  const LAYOUT = '[[layout]]\nname = "Morning"\n[[layout.pane]]\ncommand = ""\n';
  const after = parse(`[terminal]\ncopyMode = "select"\n\n${LAYOUT}`);
  assert.equal(after.error, null, after.error?.message);
  assert.equal(after.terminal.copyMode, 'select');
  assert.equal(after.layouts.length, 1);

  const before = parse(`${LAYOUT}\n[terminal]\ncopyMode = "ctrlC"\n`);
  assert.equal(before.error, null, before.error?.message);
  assert.equal(before.terminal.copyMode, 'ctrlC');
  assert.equal(before.layouts.length, 1);
  assert.equal(before.layouts[0].name, 'Morning');
});

check('a key after [terminal] does not leak into a layout', () => {
  // `[terminal]` is left on the next table header. Without that, a `name` meant for a
  // layout would be refused as an unknown terminal key — or worse, accepted by it.
  const out = parse(
    '[terminal]\ncopyMode = "select"\n[[layout]]\nname = "Morning"\n[[layout.pane]]\ncommand = ""\n',
  );
  assert.equal(out.error, null, out.error?.message);
  assert.equal(out.layouts[0].name, 'Morning');
});

console.log('\nwhat it refuses, with a line number:');

check('a mode that does not exist', () => {
  const out = parse('[terminal]\ncopyMode = "sideways"\n');
  assert.notEqual(out.error, null);
  assert.equal(out.error.line, 2);
  // The message names the options, because a refusal that does not say what IS accepted
  // sends someone to the documentation for a list the parser already has.
  for (const mode of FILE_COPY_MODES) {
    assert.ok(out.error.message.includes(mode), `the refusal does not name ${mode}`);
  }
});

check('a key [terminal] does not have', () => {
  const out = parse('[terminal]\npasteMode = "select"\n');
  assert.notEqual(out.error, null);
  assert.equal(out.error.line, 2);
  assert.ok(out.error.message.includes('copyMode'));
});

check('the same key twice', () => {
  // Two answers to one question. Taking the last would make the file's meaning depend on
  // reading order, which is exactly what a duplicate key hides.
  const out = parse('[terminal]\ncopyMode = "select"\ncopyMode = "chord"\n');
  assert.notEqual(out.error, null);
  assert.equal(out.error.line, 3);
});

check('an unquoted value, like everywhere else in this file', () => {
  const out = parse('[terminal]\ncopyMode = select\n');
  assert.notEqual(out.error, null);
  assert.equal(out.error.line, 2);
});

check('and a rejected file yields no mode at all', () => {
  // Half a file is worse than no file. A copy gesture quietly taken from a file that was
  // refused would be the one surviving half.
  const out = parse('[terminal]\ncopyMode = "select"\n[[layout.pane]]\n');
  assert.notEqual(out.error, null);
  assert.deepEqual(out.terminal, {});
  assert.deepEqual(out.layouts, []);
});

console.log('\nthe default:');

check('is the terminal’s to decide, and is what shipped before the modes', () => {
  assert.equal(DEFAULT_CLIPBOARD_MODE, 'chord');
  assert.ok(FILE_COPY_MODES.includes(DEFAULT_CLIPBOARD_MODE));
});

console.log();
if (failed) {
  console.log(`❌ ${failed} failed`);
  process.exit(1);
}
console.log('✅ the file and the terminal agree on what a copy mode is');
