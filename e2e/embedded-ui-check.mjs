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
 * skipped, and the copy is the fix.
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

console.log(`\n${passed} checks passed`);
