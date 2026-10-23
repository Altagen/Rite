/**
 * The launcher entry, the app-id and the icon name are one string (ADR 0030 §3).
 *
 * A Wayland compositor does not take a window's icon from the surface. It matches the
 * surface's app-id against the BASENAME of a `.desktop` file, reads that file's `Icon=`
 * key, and resolves the name through the icon theme. So three things have to spell the
 * same string, and when they stop, the launcher entry keeps working and the icon silently
 * disappears — no error, no log line, on a surface no test can see.
 *
 * `install.rs` holds the one constant and derives all three from it, which is why the
 * unit tests there cannot catch a drift: both sides of their assertions move together.
 * What can still drift is `main.rs` putting a literal back in the app-id fallback, which
 * is exactly how the string got duplicated before this module existed.
 *
 * Run: node e2e/install-entry-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const INSTALL = read('apps/desktop/shell/src/install.rs');
const MAIN = read('apps/desktop/shell/src/main.rs');

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

console.log('the launcher entry and the app-id agree:');

const APP_ID = INSTALL.match(/pub const APP_ID: &str = "([^"]+)";/)?.[1];

check('install.rs declares exactly one app-id', () => {
  assert.ok(APP_ID, 'no `pub const APP_ID` in install.rs');
  const declarations = INSTALL.match(/const APP_ID\b/g) ?? [];
  assert.equal(declarations.length, 1, 'the app-id is declared more than once');
  assert.match(APP_ID, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/, 'not a reverse-DNS id');
});

check('the app-id is a valid GApplication id', () => {
  // tao refuses an id without a dot, and GTK aborts the process on an invalid one.
  assert.ok(APP_ID.includes('.'), 'a GApplication id needs at least one dot');
  assert.ok(!APP_ID.endsWith('.'), 'trailing dot');
  assert.ok(!APP_ID.includes('..'), 'empty segment');
});

check('the entry filename is built from the app-id, not written out', () => {
  assert.match(
    INSTALL,
    /format!\("\{APP_ID\}\.desktop"\)/,
    'the .desktop basename must be derived from APP_ID',
  );
  assert.match(
    INSTALL,
    /format!\("\{APP_ID\}\.png"\)/,
    'the icon filename must be derived from APP_ID',
  );
});

check('the entry names the icon and the WM class by the app-id', () => {
  // A literal here is the mutation that loses the icon: the file is called
  // <app-id>.png and `Icon=` would be looking for something else.
  assert.match(INSTALL, /\\n\s*Icon=\{APP_ID\}\\n/, '`Icon=` must interpolate APP_ID');
  assert.match(
    INSTALL,
    /\\n\s*StartupWMClass=\{APP_ID\}\\n/,
    '`StartupWMClass=` must interpolate APP_ID',
  );
});

check('the entry carries the keys a launcher needs', () => {
  for (const key of [
    'Type=Application',
    'Name=Rite',
    'Exec=',
    'Terminal=false',
    'Categories=',
    'StartupNotify=true',
  ]) {
    assert.ok(INSTALL.includes(key), `the entry template is missing ${key}`);
  }
});

check('Terminal is false, which is the whole point of the entry', () => {
  // `Terminal=true` makes the desktop host Rite inside a terminal, and the window then
  // dies with it — the symptom ADR 0030 exists for.
  assert.ok(!/\\n\s*Terminal=true\\n/.test(INSTALL), 'the entry asks for a terminal');
});

check('main.rs takes its app-id from install.rs and not from a literal', () => {
  assert.match(
    MAIN,
    /unwrap_or_else\(\|\| install::APP_ID\.to_string\(\)\)/,
    'the app-id fallback must be install::APP_ID',
  );
  const literals = MAIN.match(/"[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,}"/g) ?? [];
  assert.deepEqual(
    literals,
    [],
    `main.rs carries ${literals.length} reverse-DNS literal(s): ${literals.join(', ')}. ` +
      'The app-id lives in install.rs, where the entry filename comes from it.',
  );
});

check('every icon size the install writes, the uninstall removes', () => {
  // One list, walked by both. Two lists would leave icons behind that keep resolving
  // after the application is gone.
  const sizes = INSTALL.match(/const ICON_SIZES: \[u32; (\d+)\] = \[([^\]]+)\]/);
  assert.ok(sizes, 'no ICON_SIZES list');
  const declared = sizes[2].split(',').map((s) => s.trim()).filter(Boolean);
  assert.equal(Number(sizes[1]), declared.length, 'the ICON_SIZES length does not match');
  const loops = INSTALL.match(/for size in ICON_SIZES/g) ?? [];
  assert.ok(loops.length >= 2, 'install and uninstall must both walk ICON_SIZES');
});

check('the installer script never spells the app-id, it asks for it', () => {
  // The refactor that moved placement into the script (ADR 0030 §1) could have moved the
  // app-id with it, which is the drift this whole check exists to prevent. The script
  // reads it from the binary — including at uninstall, before removing the binary that
  // knows it — so there is still exactly one source for the string.
  const script = read('scripts/install.sh');
  assert.ok(
    script.includes('--print-app-id'),
    'the script must ask the binary for the app-id',
  );
  const spelled = script.match(/io\.github\.[a-z.]+/g) ?? [];
  assert.deepEqual(
    spelled,
    [],
    `scripts/install.sh spells the app-id ${spelled.length} time(s); it must ask for it`,
  );
  for (const emitter of ['--print-desktop-entry', '--print-icon-sizes', '--print-icon']) {
    assert.ok(script.includes(emitter), `the script must place content via ${emitter}`);
  }
});

check('the emitters write to stdout and the binary owns the content', () => {
  for (const flag of [
    '"--print-app-id"',
    '"--print-desktop-entry"',
    '"--print-icon"',
    '"--print-icon-sizes"',
  ]) {
    assert.ok(MAIN.includes(flag), `main.rs does not handle ${flag}`);
  }
  // One resize, reached by both the emitter and `--install`, so the bytes cannot differ.
  assert.match(
    INSTALL,
    /std::fs::write\(&path, icon_png\(size\)\?\)/,
    '`--install` must place the same bytes `--print-icon` emits',
  );
});

check('the cache helpers are optional', () => {
  // A shipped default must not assume a tool is installed: both helpers are refinements,
  // and the freedesktop specifications require no cache at all.
  for (const tool of ['update-desktop-database', 'gtk-update-icon-cache']) {
    assert.ok(INSTALL.includes(tool), `${tool} is not called at all`);
  }
  assert.ok(
    /if let Ok\(status\) = ran/.test(INSTALL),
    'a missing cache helper must not fail the install',
  );
});

if (process.exitCode) {
  console.error('\nthe launcher entry no longer agrees with the app-id');
} else {
  console.log(`\n${passed} checks passed (app-id ${APP_ID})`);
}
