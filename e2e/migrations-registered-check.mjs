/**
 * Every migration on disk is in the list that applies them.
 *
 * WHY THIS EXISTS, written the day it would have caught something. `026_user_marks.sql`
 * was added with the marks document and never registered in `db.rs`, whose migration list
 * is an explicit `vec![]` and not a scan of the directory. The table therefore existed in
 * a file and on no instance: `/api/user/marks` answered `no such table: user_marks` to
 * every account, and nothing noticed — the desktop bench runs without a vault, so marks
 * went to the file support on every run, and the format checks have no server in them.
 *
 * A directory scan in `db.rs` would be the other fix and it is the wrong one: the list is
 * ordered, versioned and auditable, and a migration must not start applying itself because
 * somebody dropped a file in a folder. So the list stays explicit and this holds it to the
 * folder — which is the same bargain as every other check here.
 *
 * Run: node e2e/migrations-registered-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message.split('\n').slice(0, 4).join('\n        ')}`);
    failed++;
  }
};

const DIR = 'packages/rite-core/migrations';
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
// Comment lines go first: the list carries a commented EXAMPLE of the next entry, and a
// check that counted it would report a file nobody wrote. Line by line, because the only
// comments in that list are whole-line ones and a `//` inside a string is not one.
const source = readFileSync('packages/rite-core/src/db.rs', 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

// `(26, include_str!("../migrations/026_user_marks.sql"))`, however rustfmt wrapped it.
const registered = [
  ...source.matchAll(/\(\s*(\d+)\s*,\s*include_str!\("\.\.\/migrations\/([^"]+)"\)/g),
].map((m) => ({ version: Number(m[1]), file: m[2] }));

console.log(`\n${files.length} migration files, ${registered.length} registered:`);

check('every file on disk is in the list', () => {
  const listed = new Set(registered.map((r) => r.file));
  const missing = files.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `not registered in db.rs: ${missing.join(', ')}`);
});

check('and every entry in the list is a file on disk', () => {
  const present = new Set(files);
  const absent = registered.filter((r) => !present.has(r.file)).map((r) => r.file);
  assert.deepEqual(absent, [], `registered but missing from ${DIR}: ${absent.join(', ')}`);
});

check('a version is the number its file name carries', () => {
  // The prefix is the version. A mismatch applies the wrong SQL at the wrong step, and
  // `include_str!` is happy to do it.
  for (const { version, file } of registered) {
    const prefix = Number(file.slice(0, 3));
    assert.equal(version, prefix, `${file} is registered as ${version}`);
  }
});

check('the versions are a run with no gap and no repeat', () => {
  const versions = registered.map((r) => r.version);
  const expected = Array.from({ length: versions.length }, (_, i) => i + 1);
  assert.deepEqual(
    [...versions].sort((a, b) => a - b),
    expected,
    'a gap applies nothing; a repeat applies one of the two',
  );
  // And in order, because the loop that applies them walks the list as written.
  assert.deepEqual(versions, expected, 'the list is out of order');
});

console.log();
if (failed) {
  console.log(`❌ ${failed} failed`);
  process.exit(1);
}
console.log('✅ every migration on disk is applied, at the version its name says');
