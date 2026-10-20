/**
 * The crates we bumped to answer an advisory cannot slide back.
 *
 * `cargo audit` runs in CI and is the right tool for "is anything we depend on
 * vulnerable today". It is not the tool for "do not undo this particular fix": it reads
 * the advisory database at the moment it runs, so a withdrawn advisory, a database
 * outage, or a `--ignore` added for an unrelated reason all make it quiet again. And it
 * tells you nothing about WHY a floor exists — the next person reading `Cargo.lock` sees
 * a version, not a decision.
 *
 * So each crate we moved for a security reason gets a line here, with the advisory it
 * answers. A downgrade fails by name, and the name is the explanation.
 *
 * What this is NOT: a reproduction of the vulnerability. Two of the three advisories
 * below are in russh's SERVER side, and the one place Rite runs a russh server is
 * `packages/rite-core/tests/ssh_transport.rs`; the shipped code is a client
 * (`russh::client`) and an agent client (`russh::keys::agent::client`). Reproducing
 * GHSA-j7h2-66j4-ghjf would mean offering a public key with a forged signature, which
 * russh's client API does not let us construct — and a test that looked like it covered
 * that without covering it would be worse than this file, because it would be believed.
 *
 * The behavioural coverage of those bumps is the 14 transport tests in
 * `ssh_transport.rs`, which drive the real client against an in-process russh server
 * across password, RSA key, keyboard-interactive, public-key + second factor, two jump
 * hops, local port forwarding, and host-key rejection.
 *
 * Run: node e2e/advisory-floor-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LOCK = readFileSync(new URL('../Cargo.lock', import.meta.url), 'utf8');

/**
 * crate -> [minimum, why]. The `why` is printed on failure, so it has to say what the
 * floor buys rather than restate the number.
 */
const FLOORS = [
  [
    'rustls',
    '0.23.46',
    'RUSTSEC-2026-0349 — a server could be talked into a weaker key exchange than the ' +
      'one both sides had agreed on (#348)',
  ],
  [
    'russh',
    '0.64.1',
    'GHSA-4wc5-f2rc-q74m (unbounded allocation in the agent-protocol server) and ' +
      'GHSA-j7h2-66j4-ghjf (a server accepting a public-key auth whose signature does ' +
      'not hold) (#313)',
  ],
];

/** Every version recorded for a crate in Cargo.lock — a lockfile may hold several. */
function lockedVersions(crate) {
  const found = [];
  const blocks = LOCK.split('\n[[package]]');
  for (const block of blocks) {
    const name = block.match(/^\s*name = "([^"]+)"/m)?.[1];
    if (name !== crate) continue;
    const version = block.match(/^\s*version = "([^"]+)"/m)?.[1];
    if (version) found.push(version);
  }
  return found;
}

/** Semver compare on the numeric triple; pre-release tails are not in play here. */
const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

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

console.log('a security floor holds:');

for (const [crate, floor, why] of FLOORS) {
  check(`${crate} >= ${floor}`, () => {
    const versions = lockedVersions(crate);
    // A crate that left the tree entirely is not "fine by default": the floor was
    // written for a dependency we have, and its absence means this list is now wrong.
    assert.notEqual(versions.length, 0, `${crate} is not in Cargo.lock — is this floor stale?`);
    for (const v of versions) {
      assert.ok(
        cmp(v, floor) >= 0,
        `Cargo.lock pins ${crate} ${v}, below the ${floor} floor.\n        Why the floor: ${why}`,
      );
    }
  });
}

check('every floor names an advisory', () => {
  // A floor without a reason is a number nobody will dare to move. If a bump was not
  // about security it does not belong in this file.
  for (const [crate, , why] of FLOORS) {
    assert.ok(
      /RUSTSEC-\d{4}-\d{4}|GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/.test(why),
      `${crate}'s floor cites no advisory`,
    );
  }
});

console.log(`\n${passed} checks passed`);
