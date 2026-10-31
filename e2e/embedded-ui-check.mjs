/**
 * The UI inside the binary is the UI that was built.
 *
 * `rust-embed` reads `packages/rite-server/web/` at compile time (ADR 0004), and that
 * folder is filled by a copy step — `task build` does it, a bare `cargo build --release`
 * does not. Skip the copy and the binary ships the previous bundle: it compiles, it runs,
 * it serves a version of the app that is weeks behind the source, and the only symptom is
 * a feature that is "missing". That cost a review round on the account layouts, where the
 * whole surface was absent from a binary built minutes after it was written.
 *
 * A date comparison rather than a content hash: the question is only whether the copy was
 * skipped, and the copy is the fix. `e2e/gate.sh` does it in step 1 and `task build` does
 * it before the release build, so this fires on a hand-rolled `cargo build --release` —
 * which is exactly the one that went out wrong.
 *
 * THE DATE WAS NOT ENOUGH. A copy that only ever adds leaves every bundle it has ever
 * made in the folder, each under its own content hash, and the newest mtime says nothing
 * about the other hundred. Found at 106 asset files and 63 MB where the live bundle was 7
 * and 2.5 MB — the app worked, `index.html` naming the current one, while the binary
 * carried sixty megabytes of dead JavaScript. So the file lists have to match, and
 * `scripts/embed-ui.sh` is what makes them.
 *
 * Run: node e2e/embedded-ui-check.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BUILT = resolve(ROOT, 'apps/desktop/dist');
const EMBED = resolve(ROOT, 'packages/rite-server/web');

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

/** The newest mtime under a directory, or null when there is nothing to compare. */
function newest(dir) {
  if (!existsSync(dir)) return null;
  let at = null;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === '.gitkeep') continue;
      const next = resolve(path, entry.name);
      if (entry.isDirectory()) walk(next);
      else {
        const t = statSync(next).mtimeMs;
        if (at === null || t > at) at = t;
      }
    }
  };
  walk(dir);
  return at;
}

/** Every file under a directory, by its path relative to it. `.gitkeep` is not content. */
function files(dir) {
  const out = new Set();
  if (!existsSync(dir)) return out;
  const walk = (path, prefix) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === '.gitkeep') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(resolve(path, entry.name), rel);
      else out.add(rel);
    }
  };
  walk(dir, '');
  return out;
}

const built = newest(BUILT);
const embedded = newest(EMBED);
const when = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);

console.log('the embedded frontend is the one that was built:');

check('a frontend that was built is also copied into the embed folder', () => {
  if (built === null) {
    console.log('      (apps/desktop/dist is absent — nothing has been built here)');
    return;
  }
  assert.ok(
    embedded !== null,
    'apps/desktop/dist exists but packages/rite-server/web is empty: run ' +
      '`cp -r apps/desktop/dist/. packages/rite-server/web/` before building a release',
  );
});

check('and it is not older than it', () => {
  if (built === null || embedded === null) return;
  // One second of slack: a copy preserves nothing, but a filesystem may round.
  assert.ok(
    embedded >= built - 1000,
    `the embed is ${when(embedded)} and the build is ${when(built)} — ` +
      'a release built now would ship the older one. Run `task build`, or ' +
      '`cp -r apps/desktop/dist/. packages/rite-server/web/` first',
  );
});

check('and it holds that bundle and no other', () => {
  if (built === null || embedded === null) return;
  const there = files(BUILT);
  const here = files(EMBED);
  // Left behind by an earlier build. Harmless to serve and expensive to ship: every one
  // of them is compiled into the binary.
  const stale = [...here].filter((f) => !there.has(f));
  assert.deepEqual(
    stale.length > 3 ? [`${stale.length} files, e.g. ${stale.slice(0, 3).join(', ')}`] : stale,
    [],
    'the embed folder keeps bundles that are no longer built. Run `sh scripts/embed-ui.sh`',
  );
  // And the other direction, which the date check cannot see either: a copy that ran
  // before the last file was written.
  const missing = [...there].filter((f) => !here.has(f));
  assert.deepEqual(missing, [], 'the embed folder is missing part of the built bundle');
});

console.log(`\n${passed} checks passed`);
