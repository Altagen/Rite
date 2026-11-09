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
 * What this is NOT: a reproduction of the vulnerability. Two of russh's advisories
 * below are in its SERVER side, and the one place Rite runs a russh server is
 * `packages/rite-core/tests/ssh_transport.rs`; the shipped code is a client
 * (`russh::client`) and an agent client (`russh::keys::agent::client`). Reproducing
 * GHSA-j7h2-66j4-ghjf would mean offering a public key with a forged signature, which
 * russh's client API does not let us construct — and a test that looked like it covered
 * that without covering it would be worse than this file, because it would be believed.
 *
 * The behavioural coverage of those bumps is the 19 transport tests in
 * `ssh_transport.rs`, which drive the real client against an in-process russh server
 * across password, RSA key, keyboard-interactive, public-key + second factor, two jump
 * hops, local port forwarding, and host-key rejection — and, since the 0.65 bump, a
 * command that prints nothing, which is how the exec reader's lost exit status was
 * found.
 *
 * Run: node e2e/advisory-floor-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LOCK = readFileSync(new URL('../Cargo.lock', import.meta.url), 'utf8');

/**
 * crate -> [minimum, why]. The `why` is printed on failure, so it has to say what the
 * floor buys rather than restate the number.
 *
 * A floor applies to the copies on ITS OWN major line. Two incompatible majors of one
 * crate coexist legitimately — `webpki-roots` is in the tree twice, 1.0.x for
 * `rite-server` and 0.26.x for `tokio-tungstenite` — and the advisory named only one of
 * them. A floor that swept both would fail for a version nobody claimed was vulnerable,
 * which is the way a check stops being read. Every other copy is still asserted against
 * its own line's floor, and a floor matching NO copy fails: the list would be stale.
 */
const FLOORS = [
  [
    'rustls',
    '0.23.46',
    'RUSTSEC-2026-0349 — a server could be talked into a weaker key exchange than the ' +
      'one both sides had agreed on (#348)',
  ],
  [
    'rustls-webpki',
    '0.103.16',
    'RUSTSEC-2026-0382 — certificate verification could accept an intermediate that ' +
      'had been distrusted, so a chain Rite checked was not the chain it thought it ' +
      'had checked. Reached through rustls, on every TLS connection the server makes',
  ],
  [
    'webpki-roots',
    '1.0.10',
    'RUSTSEC-2026-0381 — the bundled trust anchors still carried distrusted emSign ' +
      'intermediates. `rite-server` depends on this directly for the proxied remote ' +
      'context (ADR 0012), so the roots it trusts are these',
  ],
  [
    'tokio',
    '1.54.1',
    'RUSTSEC-2026-0384 — a race in `tokio::time::Interval`, and 1.54.0 was yanked. ' +
      'Every timer in the server runs on it: the probe cooldown, the keep-alives, the ' +
      'login throttle',
  ],
  [
    'ctutils',
    '0.4.4',
    'RUSTSEC-2026-0385 — mask generation and `u128` comparisons that were not ' +
      'constant-time. It sits under `subtle`, so it is reached by every comparison Rite ' +
      'makes on a secret: the auth hash, the session token, the enrolment token',
  ],
  [
    'crypto-bigint',
    '0.7.9',
    'RUSTSEC-2026-0387 — subtraction, zero counting, division and Montgomery ' +
      'multiplication could branch on secret values, and `UintRef` equality could stop ' +
      'at the first unequal limb. It sits under russh\'s key handling, so it is reached ' +
      'by every SSH key operation. The advisory is answered from 0.7.6, and this floor ' +
      'is higher: 0.7.6 through 0.7.8 were all yanked within days',
  ],
  [
    'russh',
    '0.65.1',
    'Six advisories across two bumps. 0.64.1 answered GHSA-4wc5-f2rc-q74m (unbounded ' +
      'allocation in the agent-protocol server) and GHSA-j7h2-66j4-ghjf (a server ' +
      'accepting a public-key auth whose signature does not hold) (#313). 0.65 answered ' +
      'four more: GHSA-vp5q-ff62-jwqv, the high one — an agent server never calling ' +
      '`Agent::confirm`, so a key added with `ssh-add -c` signs without asking; ' +
      'GHSA-4p9f-7p9m-5vfg, unbounded allocation in the CLIENT via EXT_INFO packets, ' +
      'which is the one that reaches shipped code on every connection; ' +
      'GHSA-fw5c-8223-6h42, a peer declaring a zero maximum packet size stalling ' +
      'channel writes for good; and GHSA-9wfm-jcj8-jfv9, unbounded allocation from ' +
      'repeated SSH_AGENT_CONSTRAIN_CONFIRM. The floor is 0.65.1 rather than the 0.65 ' +
      'the advisories name because that is the version in the lock. ' +
      'THE BREAK IS THE FIX MADE INTO A TYPE: `Handler::auth_publickey` takes a ' +
      '`VerifiedPublicKey` where it took a `&PublicKey`, so a handler can no longer ' +
      'accept an unverified key by forgetting to ask',
  ],
  [
    'pageant',
    '0.2.5',
    'GHSA-662x-8wvj-2276 — unbounded frame buffering on a peer-controlled 4-byte ' +
      'length prefix. TRANSITIVE, under russh, and it DID NOT ARRIVE WITH IT: russh ' +
      '0.65.1 still accepts 0.2.4, so the parent was bumped and the advisory stayed ' +
      'until the lock was moved for this crate on purpose. That is the whole reason it ' +
      'has a line of its own here rather than being covered by russh\'s',
  ],
];

/**
 * Advisories we have READ and decided not to act on, with the decision.
 *
 * This exists because of a gap the floors above do not cover: `cargo audit` and GitHub's
 * advisory database do not see the same things. GHSA-wrw7-89jp-8q8g has been open against
 * this repository since March 2026 and `cargo audit` has never mentioned it — so the gate
 * was green for seven months on a medium advisory, and nothing compared the two lists.
 *
 * A floor above says "do not go below this version". A line here says "this one is known,
 * and here is why nothing moved" — which is the other half, and the half that rots fastest
 * when it lives in someone's memory instead of a file.
 *
 * Nothing is asserted against these: an accepted advisory has no version to hold. They are
 * here to be read, and to be re-read when the reopen condition arrives.
 */
const ACCEPTED = [
  {
    id: 'GHSA-wrw7-89jp-8q8g',
    crate: 'glib 0.18.5',
    what:
      'Unsoundness in Iterator/DoubleEndedIterator for glib::VariantStrIter — undefined ' +
      'behaviour, not a remotely reachable flaw. Rite never calls VariantStrIter.',
    reach: 'The desktop client only, through gtk → tao/wry. rite-server does not link it.',
    why:
      'There is nothing to bump to. tao 0.37.1 and wry 0.57.0 ARE the latest, and on Linux ' +
      'wry renders in webkit2gtk, which is GTK3. The fix landed in glib 0.20, which belongs ' +
      'to the GTK4 line; gtk-rs froze its GTK3 bindings at 0.18/0.19 and moved on to gtk4. ' +
      'So the correction is not available to us at any version — it needs wry to migrate to ' +
      'GTK4 + webkitgtk-6 upstream.',
    decision:
      'Accepted. Stay on wry/GTK3. If this becomes a real problem — an exploit path, or a ' +
      'distribution dropping webkit2gtk — move the shell to GTK4, which is large work and a ' +
      'deliberate project rather than a bump.',
    reopen: 'wry ships a GTK4 backend, or the advisory gains a demonstrated exploit path.',
  },
  {
    id: 'RUSTSEC-2026-0459',
    crate: 'libsqlite3-sys 0.30.1 (CVE-2026-119375, 6.8 medium)',
    what:
      'SQLite before 3.54.0 can return UNINITIALISED PAGE-CACHE MEMORY when a process ' +
      'opens a database alongside a sibling `-wal` file whose page size differs from the ' +
      "database's. The crafted pair makes ordinary queries hand back stale bytes from the " +
      'process. The advisory states the vector itself: local, and the victim must open ' +
      'the files — "only a process that opens a database and WAL that a less trusted ' +
      'party could have written is exposed".',
    reach:
      'The whole product, and the C is COMPILED IN rather than linked: `ldd` on ' +
      '`rite-server` shows no `libsqlite3.so`, so this is not something an operating ' +
      'system patch reaches. Rite runs in WAL mode (`db.rs`), so the sibling file exists. ' +
      'WHAT DOES NOT REACH IT is an untrusted file: the path is fixed and Rite chose it ' +
      '— `dirs::data_dir()/rite/vault.db` — there is no file picker anywhere that opens a ' +
      'database somebody else wrote, and every statement is Rite\'s own and parameterised. ' +
      'Planting the pair means already being able to write the user\'s data directory, ' +
      'where the vault itself is.',
    why:
      'There is nothing to bump to. The fix is `libsqlite3-sys` 0.39.0 and `sqlx-sqlite` ' +
      '0.9.0 will not go past 0.37 — `cargo update -p libsqlite3-sys` reaches 0.37.0 and ' +
      'stops, which answers no advisory. So the choices are to stay, or to move the whole ' +
      'database layer onto an sqlx that does not exist yet.',
    decision:
      'Accepted, on the vector rather than on the inconvenience of the bump. Rite never ' +
      'opens a database a less trusted party could have written, which is the one ' +
      'condition the advisory names. An OPERATOR could create the exposure by mounting a ' +
      'volume somebody else can write at `deploy/compose.yml`\'s data path — that is a ' +
      'deployment decision and it is already the vault, not a bug to fix here.',
    reopen:
      'sqlx allows libsqlite3-sys >= 0.39 (then bump, do not argue), or Rite grows any ' +
      'path that opens a database file the user did not create — importing one, attaching ' +
      'a second vault, a file picker. That last one is the condition to watch, because it ' +
      'is a feature somebody could add without ever reading this.',
  },
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
  check(`${crate} >= ${floor} (on its own major line)`, () => {
    const versions = lockedVersions(crate);
    // A crate that left the tree entirely is not "fine by default": the floor was
    // written for a dependency we have, and its absence means this list is now wrong.
    assert.notEqual(versions.length, 0, `${crate} is not in Cargo.lock — is this floor stale?`);
    const line = (v) => v.split('.').slice(0, v.startsWith('0.') ? 2 : 1).join('.');
    const onThisLine = versions.filter((v) => line(v) === line(floor));
    assert.notEqual(
      onThisLine.length,
      0,
      `${crate} is in Cargo.lock as ${versions.join(', ')}, none on the ${line(floor)} ` +
        `line this floor was written for — is it stale?`,
    );
    for (const v of onThisLine) {
      assert.ok(
        cmp(v, floor) >= 0,
        `Cargo.lock pins ${crate} ${v}, below the ${floor} floor.\n        Why the floor: ${why}`,
      );
    }
  });
}

check('every accepted advisory carries its reasoning', () => {
  // Not an assertion about versions — an assertion that the record is usable. An accepted
  // advisory without a reach, a reason and a reopen condition is a shrug with an id on it.
  for (const a of ACCEPTED) {
    // `crate` is a name and a version; the rest have to be sentences, because a reader
    // arriving at this file is asking "why is this still open" and wants an answer.
    assert.ok(a.crate?.length > 4, `${a.id} does not say which crate`);
    for (const field of ['what', 'reach', 'why', 'decision', 'reopen']) {
      assert.ok(
        typeof a[field] === 'string' && a[field].length > 30,
        `${a.id} has no usable ${field}`,
      );
    }
    assert.match(a.id, /^(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|RUSTSEC-\d{4}-\d{4})$/);
  }
});

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
