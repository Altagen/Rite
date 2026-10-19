/**
 * The release number is one number, declared in three files.
 *
 * `Cargo.toml` feeds `env!("CARGO_PKG_VERSION")`, which is what the server reports on
 * `/api/capabilities` and what ADR 0008's handshake compares against. The two
 * `package.json` files feed the bundle and the desktop package. Nothing makes them agree,
 * and the realistic mistake is not writing the wrong number — it is bumping one file and
 * forgetting another, which ships a server reporting 0.2.4 inside a package called 0.2.3.
 *
 * The exact value is pinned in the Rust test (`capabilities_reports_version`), where it
 * sits beside `apiVersion` and `minClient`. This check asserts the three files agree with
 * each other and that the number is a release — so a bump needs one deliberate edit here
 * rather than three hopeful ones.
 *
 * Run: node e2e/version-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// The workspace version, not a dependency's: the first `version = "…"` under
// `[workspace.package]`, read by line so a crate pinning `version = "1.0"` cannot win.
function cargoVersion() {
  const lines = read('Cargo.toml').split('\n');
  const at = lines.findIndex((l) => l.trim() === '[workspace.package]');
  assert.notEqual(at, -1, 'Cargo.toml has no [workspace.package] section');
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith('[')) break;
    const m = line.match(/^version\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }
  throw new Error('no version under [workspace.package]');
}

const sources = {
  'Cargo.toml': cargoVersion(),
  'package.json': JSON.parse(read('package.json')).version,
  'apps/desktop/package.json': JSON.parse(read('apps/desktop/package.json')).version,
};

console.log('the release number agrees with itself:');

check('every manifest declares a version', () => {
  for (const [file, version] of Object.entries(sources)) {
    assert.ok(version, `${file} declares no version`);
  }
});

check('all three say the same thing', () => {
  const distinct = [...new Set(Object.values(sources))];
  assert.equal(
    distinct.length,
    1,
    `they disagree: ${Object.entries(sources)
      .map(([f, v]) => `${f}=${v}`)
      .join(', ')}`,
  );
});

check('and it is a release number, not a placeholder', () => {
  const version = sources['Cargo.toml'];
  assert.match(version, /^\d+\.\d+\.\d+$/, `${version} is not major.minor.patch`);
  assert.notEqual(version, '0.0.0');
});

// INSTALL.md gives a reader commands to copy, and they carry a version: the tarball to
// download and the image tag to pull. A stale number there sends them to a URL that 404s
// or, worse, to a release two versions old that installs cleanly.
check('the version INSTALL.md tells a reader to fetch is this one', () => {
  const version = sources['Cargo.toml'];
  const found = [...new Set([...read('INSTALL.md').matchAll(/\b\d+\.\d+\.\d+\b/g)].map((m) => m[0]))];
  assert.ok(found.length > 0, 'INSTALL.md names no version at all — it used to name the commands');
  assert.deepEqual(found, [version], `INSTALL.md says ${found.join(', ')} and this is ${version}`);
});

console.log(`\n${passed} checks passed (version ${sources['Cargo.toml']})`);
