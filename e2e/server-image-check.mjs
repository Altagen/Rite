/**
 * The shipped server image starts a shell somewhere a member can work.
 *
 * `rite-server` spawns a local terminal as a child process, so the PTY inherits the
 * server's working directory. Nothing makes a shell go to `$HOME` on its own — a non-login
 * interactive shell keeps the directory it was handed — and an image with no `WORKDIR`
 * runs in `/`. So until 0.2.8 a local terminal opened from the web UI landed in `/`: not
 * writable by the `rite` user, and holding nothing of theirs.
 *
 * Measured on the owner's running 0.2.6 instance before the fix, with `podman inspect`:
 * `workdir=/`, `user=rite`, `HOME=/home/rite`. The home was always defined and never used.
 *
 * TWO FILES CARRY THIS RECIPE. `Containerfile.server` builds what ships, and
 * `e2e/turnkey-acceptance.sh` wraps an already-built binary in a fixture image because the
 * real one compiles from source on the same distribution. A fixture left in `/` would
 * accept the regression it exists to catch, so what this asserts is mostly that the two
 * agree.
 *
 * Text and not `podman inspect`: this runs on every commit, where no image has been built.
 * The acceptance script asserts the built image itself.
 *
 * Run: node e2e/server-image-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SERVER = read('Containerfile.server');
const TURNKEY = read('e2e/turnkey-acceptance.sh');
const COMPOSE = read('deploy/compose.yml');

/** The home the image creates, read from the `useradd` that creates it. */
const homeIn = (text, what) => {
  const m = /useradd[^\n]*--home-dir (\S+)/.exec(text);
  assert.ok(m, `${what} no longer creates the rite user with a home`);
  return m[1];
};

/** The working directory the image runs in, or null when it never sets one — which is `/`. */
const workdirIn = (text) => {
  const all = [...text.matchAll(/^WORKDIR (\S+)$/gm)].map((m) => m[1]);
  return all.length === 0 ? null : all[all.length - 1];
};

console.log('the server image starts a shell in the home:');

check('the shipped image runs in the home it created', () => {
  const home = homeIn(SERVER, 'Containerfile.server');
  assert.equal(
    workdirIn(SERVER),
    home,
    'Containerfile.server does not run in the rite home — a local terminal would open in /',
  );
});

check('the acceptance fixture runs where the shipped image does', () => {
  // The fixture is what gate step 5 actually boots. Two recipes that disagree about this
  // is an acceptance test that passes while the product regresses.
  assert.equal(
    workdirIn(TURNKEY),
    homeIn(TURNKEY, 'the acceptance fixture'),
    'the acceptance fixture does not run in the rite home',
  );
  assert.equal(
    workdirIn(TURNKEY),
    workdirIn(SERVER),
    'the fixture and the shipped image start a shell in different places',
  );
});

check('the home is the user the server runs as', () => {
  // A working directory the process cannot write to is the same defect one level down.
  for (const [what, text] of [['Containerfile.server', SERVER], ['the fixture', TURNKEY]]) {
    assert.ok(/^USER rite$/m.test(text), `${what} no longer drops to the rite user`);
    assert.match(homeIn(text, what), /^\/home\/rite$/, `${what} moved the home`);
  }
});

check('the data volume mounts under that directory', () => {
  // Not decoration: it is what makes the starting directory somewhere with the member's
  // own files in it rather than an empty home.
  const home = homeIn(SERVER, 'Containerfile.server');
  const mount = /rite-data:(\S+)/.exec(COMPOSE);
  assert.ok(mount, 'deploy/compose.yml no longer mounts the data volume');
  assert.ok(
    mount[1].startsWith(`${home}/`),
    `the volume mounts at ${mount[1]}, outside the directory a shell starts in (${home})`,
  );
});

console.log(`\n${passed} checks passed`);
