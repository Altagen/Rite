/**
 * Whose shell a new local terminal starts (ADR 0031).
 *
 * The rule's discriminator is `isNativeShell()`, which reads a global the wry shell
 * injects. Playwright drives Chromium, where that global is absent, so every browser-based
 * suite exercises one arm and the desktop arm would ship untested. That gap is not
 * theoretical — a `mouseleave` Chromium delivers and WebKitGTK does not shipped a sidebar
 * arrow that never hid.
 *
 * So the rule is a pure function with its inputs passed in, and this holds every arm.
 *
 * Run: node e2e/local-shell-source-check.mjs
 */
import assert from 'node:assert/strict';
import { instanceChoosesShell, shellToStart } from '../apps/desktop/src/utils/localShellSource.ts';

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

const base = {
  localDefault: '/usr/bin/fish',
  instanceDefault: '/bin/bash',
  instanceOffers: ['bash', 'zsh'],
};

console.log('whose shell a new local terminal starts:');

check('the desktop starts its own, even against an instance', () => {
  assert.equal(
    shellToStart({ ...base, runsHere: true, serverContext: true }),
    '/usr/bin/fish',
    "the instance's shell would be a path on another computer",
  );
});

check('the desktop honours a shell the user named', () => {
  assert.equal(
    shellToStart({ ...base, runsHere: true, serverContext: true, asked: '/usr/bin/nu' }),
    '/usr/bin/nu',
  );
});

check("the desktop is not held to the instance's list", () => {
  // `nu` is not among the offers. On this machine that is none of the instance's business.
  assert.equal(
    shellToStart({ ...base, runsHere: true, serverContext: true, asked: '/usr/bin/nu' }),
    '/usr/bin/nu',
  );
});

check('a browser against an instance takes the instance default', () => {
  assert.equal(
    shellToStart({ ...base, runsHere: false, serverContext: true }),
    '/bin/bash',
  );
});

check('a browser may pick one the instance offers', () => {
  assert.equal(
    shellToStart({ ...base, runsHere: false, serverContext: true, asked: 'zsh' }),
    'zsh',
  );
});

check('a browser asking for one it was not offered gets the default instead', () => {
  assert.equal(
    shellToStart({ ...base, runsHere: false, serverContext: true, asked: '/usr/bin/nu' }),
    '/bin/bash',
    'a client must not name a program the instance does not offer',
  );
});

check('an instance that offers nothing keeps the decision', () => {
  // Saying nothing, rather than echoing a default back: an administrator who changes it
  // then carries everyone, instead of being overridden by a value we copied earlier.
  assert.equal(
    shellToStart({ ...base, runsHere: false, serverContext: true, instanceOffers: [] }),
    undefined,
  );
});

check('a local vault starts this machine\'s shell', () => {
  assert.equal(
    shellToStart({ ...base, runsHere: true, serverContext: false }),
    '/usr/bin/fish',
  );
});

/* The same rule, asked directly — because four toolbar sites ask it rather than asking for
   a shell value, and the first pass at ADR 0031 left them on a bare `isServerCtx`: the
   picker hidden, the chevron listing the instance's shells, the tooltip saying "New server
   terminal", and probing switched off. One function, one check. */
console.log('\nand who narrows the choice:');

check('the instance narrows only a client with no machine of its own', () => {
  assert.equal(instanceChoosesShell({ runsHere: false, serverContext: true }), true);
});

check('the desktop is never narrowed, context or not', () => {
  assert.equal(instanceChoosesShell({ runsHere: true, serverContext: true }), false);
  assert.equal(instanceChoosesShell({ runsHere: true, serverContext: false }), false);
});

check('and a local vault has nobody to narrow it', () => {
  assert.equal(instanceChoosesShell({ runsHere: false, serverContext: false }), false);
});

console.log(`\n${passed} checks passed`);
