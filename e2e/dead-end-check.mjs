/**
 * Every full-screen surface offers a way out.
 *
 * The server sign-in screen did not. A desktop window is dedicated to its context (ADR
 * 0006/0014), so that screen carried no chrome at all: clicking the wrong server in the hub
 * left the person at a sign-in form for an account they may not have, with the window
 * manager as the only exit. The forced-password screen was worse — authenticated, blocking
 * on purpose, and offering not even a sign-out.
 *
 * Blocking is legitimate; trapping is not. A surface may refuse to let you past it and still
 * let you leave it.
 *
 * Checked in source rather than by driving each screen: reaching some of them needs a
 * particular server state (a bootstrap, an admin-set password, a webui-less deployment), and
 * what went wrong was not a broken button but a screen written without one.
 *
 * Run: node e2e/dead-end-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../apps/desktop/src/components/', import.meta.url);

/** A surface that fills the window, rather than sitting inside one. */
const FULLSCREEN = /className="(?:[^"]*\s)?(?:flex h-screen|fixed inset-0 z-50 flex flex-col|flex min-h-screen)/;

/**
 * Anything that gets the person off this screen. Deliberately broad — the point is that an
 * exit EXISTS, not which one: a nav, a sign-out, a context switch, a dismissal, a retry.
 */
const EXIT =
  /OverlayHeaderControls|logout\(\)|requestSwitchContext|navigate\('\/'\)|onSignOut|resetError|onClose/;

/** Surfaces with nothing to leave to, and why. */
const ALLOWED = new Map([
  ['SetupScreen.tsx', 'first run in a browser: there is no app behind it yet'],
  ['UnlockScreen.tsx', 'the vault is the app; the reset path is in it'],
]);

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

console.log('no screen is a dead end:');

const screens = readdirSync(DIR)
  .filter((f) => f.endsWith('.tsx'))
  // Imports stripped before the test: an unused `import { requestSwitchContext }` satisfied
  // the pattern while the button that called it was gone. A mutation found that, which is
  // the argument for mutating a check and not only trusting it.
  .map((f) => [f, readFileSync(new URL(f, DIR), 'utf8').replace(/^import .*$/gm, '')])
  .filter(([, src]) => FULLSCREEN.test(src));

check('every full-screen surface offers an exit', () => {
  assert.ok(screens.length >= 8, `only ${screens.length} full-screen surfaces found — the scan is wrong`);
  const trapped = screens
    .filter(([f, src]) => !EXIT.test(src) && !ALLOWED.has(f))
    .map(([f]) => f);
  assert.deepEqual(
    trapped,
    [],
    `${trapped.length} surface(s) with no way out:\n        ` + trapped.join('\n        '),
  );
});

check('every allowed dead end still exists, and says why', () => {
  // An exemption for a file that is gone, or that grew an exit, is a line nobody will question.
  const found = new Set(screens.map(([f]) => f));
  for (const [file, why] of ALLOWED) {
    assert.ok(found.has(file), `${file} is no longer a full-screen surface — drop its exemption`);
    assert.ok(why.length > 10, `${file} is exempt without a reason`);
  }
});

console.log(`\n${passed} checks passed`);
