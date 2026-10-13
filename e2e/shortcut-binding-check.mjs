/**
 * The keyboard engine's matching rules, and the defaults they have to satisfy.
 *
 * Loads apps/desktop/src/shortcuts/{binding,commands}.ts directly: Node strips the
 * types and neither module imports anything at runtime, so this tests the shipped
 * engine rather than a copy of it.
 *
 * Every check below is a defect this app has shipped or was about to:
 *
 *   * `Ctrl+F` accepted Cmd and `Ctrl+W` did not, so `Cmd+W` closed nothing on a
 *     Mac — four shortcuts written inline in two files with nothing comparing them;
 *   * splitting vertically was bound to `Ctrl+Shift+V`, which is **paste** in
 *     gnome-terminal, konsole and xfce4-terminal;
 *   * a binding that ignores the modifiers it does not ask for fires a command the
 *     user remapped away.
 *
 * Run: node e2e/shortcut-binding-check.mjs
 */
import assert from 'node:assert/strict';
import {
  parseBinding,
  formatBinding,
  displayBinding,
  matchesBinding,
  findConflicts,
  bindingFromEvent,
} from '../apps/desktop/src/shortcuts/binding.ts';
import {
  SHORTCUT_COMMANDS,
  RESERVED_BINDINGS,
  isReservedText,
} from '../apps/desktop/src/shortcuts/commands.ts';

/** The defaults, parsed. The app builds these in `store.ts`, which imports zustand
 *  and so cannot be loaded here; what matters is that the table and the parser agree,
 *  and both of those are the shipped files. */
const defaultBindings = () =>
  Object.fromEntries(SHORTCUT_COMMANDS.map((c) => [c.id, parseBinding(c.defaultBinding)]));

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

/** A keyboard event, as the engine sees one. */
const ev = (key, mods = {}) => ({
  key,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

const MAC = true;
const PC = false;

console.log('parsing and formatting:');

check('a chord round-trips through parse and format', () => {
  assert.equal(formatBinding(parseBinding('Mod+Shift+H')), 'Mod+Shift+H');
});

check('modifier order and case do not change the chord', () => {
  // Two spellings of one chord must compare equal, or a conflict hides behind
  // whichever order the user happened to type.
  assert.equal(formatBinding(parseBinding('shift+mod+h')), 'Mod+Shift+H');
  assert.equal(formatBinding(parseBinding('MOD+SHIFT+H')), 'Mod+Shift+H');
});

check('nonsense parses to null rather than to half a binding', () => {
  assert.equal(parseBinding(''), null);
  assert.equal(parseBinding('Mod'), null, 'a modifier alone is not a binding');
  assert.equal(parseBinding('Mod+A+B'), null, 'two keys is not a binding');
  assert.equal(parseBinding('+++'), null);
});

check('a bare key parses — the table decides whether to allow it', () => {
  assert.deepEqual(parseBinding('F1'), { mod: false, shift: false, alt: false, key: 'F1' });
});

check('what the user reads says Cmd on a Mac and Ctrl elsewhere', () => {
  const b = parseBinding('Mod+W');
  assert.equal(displayBinding(b, MAC), 'Cmd+W');
  assert.equal(displayBinding(b, PC), 'Ctrl+W');
});

console.log('\nmatching — where the platform bugs live:');

check('Mod is Ctrl on a PC and Cmd on a Mac', () => {
  const b = parseBinding('Mod+W');
  assert.equal(matchesBinding(ev('w', { ctrl: true }), b, PC), true);
  assert.equal(matchesBinding(ev('w', { meta: true }), b, MAC), true);
});

check('the wrong platform modifier does not fire it', () => {
  // This is the half that was missing: Ctrl+W on a Mac was never Cmd+W, and
  // Cmd+W therefore closed nothing at all.
  const b = parseBinding('Mod+W');
  assert.equal(matchesBinding(ev('w', { ctrl: true }), b, MAC), false);
  assert.equal(matchesBinding(ev('w', { meta: true }), b, PC), false);
});

check('holding both Ctrl and Cmd does not fire a Mod binding', () => {
  // The platform modifier matching is not enough on its own: on a Mac, Cmd+W with
  // Ctrl also held still has metaKey set, so without refusing the *other* modifier
  // the chord fires anyway — and the user who pressed Ctrl+Cmd+W meant something
  // else. This is the case the first guard already passes, so it needs its own.
  const b = parseBinding('Mod+W');
  assert.equal(matchesBinding(ev('w', { meta: true, ctrl: true }), b, MAC), false);
  assert.equal(matchesBinding(ev('w', { ctrl: true, meta: true }), b, PC), false);
});

check('an extra modifier the binding did not ask for does not fire it', () => {
  // Otherwise Mod+Shift+W still closes a pane after the user remapped Mod+W away.
  const b = parseBinding('Mod+W');
  assert.equal(matchesBinding(ev('w', { ctrl: true, shift: true }), b, PC), false);
  assert.equal(matchesBinding(ev('w', { ctrl: true, alt: true }), b, PC), false);
});

check('a missing modifier does not fire it either', () => {
  const b = parseBinding('Mod+Shift+H');
  assert.equal(matchesBinding(ev('H', { ctrl: true }), b, PC), false);
  assert.equal(matchesBinding(ev('h', {}), b, PC), false);
});

check('the key compares case-insensitively, because Shift changes it', () => {
  // A shifted 'h' arrives as 'H'; a binding written 'Mod+Shift+h' must still fire.
  const b = parseBinding('Mod+Shift+h');
  assert.equal(matchesBinding(ev('H', { ctrl: true, shift: true }), b, PC), true);
  assert.equal(matchesBinding(ev('h', { ctrl: true, shift: true }), b, PC), true);
});

console.log('\nconflicts:');

check('two commands on one chord are reported', () => {
  const clashes = findConflicts({
    a: parseBinding('Mod+W'),
    b: parseBinding('Mod+W'),
    c: parseBinding('Mod+F'),
  });
  assert.deepEqual(clashes, ['Mod+W']);
});

check('the same chord spelled differently still conflicts', () => {
  const clashes = findConflicts({ a: parseBinding('Mod+Shift+H'), b: parseBinding('shift+mod+h') });
  assert.deepEqual(clashes, ['Mod+Shift+H']);
});

check('distinct chords do not conflict', () => {
  assert.deepEqual(findConflicts({ a: parseBinding('Mod+W'), b: parseBinding('Mod+Shift+W') }), []);
});

console.log('\nrecording a binding from a keypress:');

check('a modifier on its own is not a binding', () => {
  for (const key of ['Control', 'Meta', 'Shift', 'Alt']) {
    assert.equal(bindingFromEvent(ev(key, { ctrl: true }), PC), null, key);
  }
});

check('a bare letter is refused — it would swallow typing in every terminal', () => {
  assert.equal(bindingFromEvent(ev('k', {}), PC), null);
  assert.equal(bindingFromEvent(ev('k', { shift: true }), PC), null);
});

check('a chord with the platform modifier is recorded as Mod', () => {
  assert.equal(formatBinding(bindingFromEvent(ev('k', { ctrl: true }), PC)), 'Mod+K');
  assert.equal(formatBinding(bindingFromEvent(ev('k', { meta: true }), MAC)), 'Mod+K');
});

check('Alt alone is enough — it is a modifier, not typing', () => {
  assert.equal(formatBinding(bindingFromEvent(ev('k', { alt: true }), PC)), 'Alt+K');
});

console.log('\nthe shipped defaults:');

check('every default parses', () => {
  for (const command of SHORTCUT_COMMANDS) {
    assert.notEqual(parseBinding(command.defaultBinding), null, `${command.id}: ${command.defaultBinding}`);
  }
});

check('no two commands ship on the same chord', () => {
  assert.deepEqual(findConflicts(defaultBindings()), []);
});

check('every default uses Mod, so Cmd works on a Mac for all of them', () => {
  // Not for search alone, which is how it shipped.
  for (const [id, binding] of Object.entries(defaultBindings())) {
    assert.equal(binding.mod, true, `${id} does not use Mod`);
  }
});

check('no default takes a chord the terminal needs', () => {
  // Mod+Shift+V is paste in gnome-terminal, konsole and xfce4-terminal, and the
  // vertical split used to be bound to exactly that.
  for (const [id, binding] of Object.entries(defaultBindings())) {
    assert.equal(isReservedText(formatBinding(binding)), false, `${id} takes ${formatBinding(binding)}`);
  }
});

check('copy and paste are the reserved chords', () => {
  assert.deepEqual(RESERVED_BINDINGS, ['Mod+Shift+C', 'Mod+Shift+V']);
});

console.log(`\n${passed} checks passed`);
