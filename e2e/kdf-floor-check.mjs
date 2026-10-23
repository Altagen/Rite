/**
 * The client refuses a key derivation weaker than its own floor (ADR 0029).
 *
 * `POST /api/server/prelogin` hands back the salt AND the Argon2 parameters, read from the
 * account's row, and the client derives its auth hash with them. So a server that lies —
 * compromised, or hostile from the start — could answer `mem: 8, iter: 1` and receive a
 * value that costs nothing to brute-force back to the password. The vault's own key uses a
 * fixed local KDF, so the blobs are not handed over directly; but the password derives that
 * key, so recovering it is recovering the vault.
 *
 * The mitigation can only live on the client: a parameter the server chose cannot be
 * policed by the server. So this holds the floor, and holds it where it matters — BEFORE
 * the derivation, because the point is never to compute the cheap hash at all.
 *
 * Run: node e2e/kdf-floor-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MIN_KDF_PARAMS,
  WeakKdfError,
  kdfIsStrongEnough,
} from '../apps/desktop/src/utils/kdfFloor.ts';

const AUTH_SRC = readFileSync(
  new URL('../apps/desktop/src/utils/serverAuth.ts', import.meta.url),
  'utf8',
);
/** What the client registers with, read from the source so the two cannot drift apart. */
const DEFAULT_KDF_PARAMS = (() => {
  const m = AUTH_SRC.match(/DEFAULT_KDF_PARAMS: KdfParams = \{ mem: (\d+), iter: (\d+), par: (\d+) \}/);
  assert.ok(m, 'serverAuth.ts no longer declares DEFAULT_KDF_PARAMS as expected');
  return { mem: +m[1], iter: +m[2], par: +m[3] };
})();

let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('the floor is the baseline this client registers with:');

await check('the shipped default meets it', () => {
  assert.ok(kdfIsStrongEnough(DEFAULT_KDF_PARAMS));
  // Equal, not merely above: a floor below what every account was created with would
  // leave a gap nobody notices, and one above it would lock those accounts out.
  assert.deepEqual(MIN_KDF_PARAMS, DEFAULT_KDF_PARAMS);
});

console.log('\nand each parameter is floored on its own:');

const WEAK = [
  ['memory', { ...DEFAULT_KDF_PARAMS, mem: DEFAULT_KDF_PARAMS.mem - 1 }],
  ['memory, absurdly', { ...DEFAULT_KDF_PARAMS, mem: 8 }],
  ['iterations', { ...DEFAULT_KDF_PARAMS, iter: 1 }],
  ['parallelism', { ...DEFAULT_KDF_PARAMS, par: 0 }],
  ['all three', { mem: 8, iter: 1, par: 0 }],
];

for (const [what, params] of WEAK) {
  await check(`${what} below the floor is refused`, async () => {
    assert.equal(kdfIsStrongEnough(params), false, 'the predicate must say no');
    // Named, so the login screen can say "this server asked for something weaker" instead
    // of "wrong password" — which would have the reader type it again, into a server that
    // is collecting cheap hashes of it.
    const err = new WeakKdfError(params);
    assert.equal(err.name, 'WeakKdfError');
    assert.match(err.message, /minimum/, err.message);
    assert.match(err.message, new RegExp(String(params.mem)), 'it names what was asked for');
  });
}

console.log('\nstronger than the floor is fine — a server may ask for more:');

for (const [what, params] of [
  ['more memory', { ...DEFAULT_KDF_PARAMS, mem: DEFAULT_KDF_PARAMS.mem * 2 }],
  ['more passes', { ...DEFAULT_KDF_PARAMS, iter: 4 }],
]) {
  await check(what, () => assert.ok(kdfIsStrongEnough(params)));
}

console.log('\nand the derivation asks before it derives:');

await check('deriveAuthHash refuses first, and argon2 runs after', () => {
  // The real derivation cannot be imported here — `serverAuth.ts` pulls in WebCrypto and
  // libsodium — so its ORDER is read from the source. Order is the point: a guard after
  // the derivation would still have computed the cheap hash, and the attack is the hash.
  const body = AUTH_SRC.match(/export async function deriveAuthHash\([\s\S]*?\n}/);
  assert.ok(body, 'deriveAuthHash is gone or no longer shaped as a function');
  const guard = body[0].indexOf('kdfIsStrongEnough');
  const derive = body[0].indexOf('argon2id');
  assert.notEqual(guard, -1, 'deriveAuthHash does not consult the floor at all');
  assert.notEqual(derive, -1, 'deriveAuthHash no longer calls argon2id');
  assert.ok(guard < derive, 'the floor must be checked BEFORE the derivation');
  assert.match(body[0], /throw new WeakKdfError/, 'it must refuse by name');
});

await check('and login is the only path that trusts the server for them', () => {
  // Everything else derives with the local default. If a second call site started taking
  // parameters from the wire, the floor would be its only protection and this would say so.
  const store = readFileSync(
    new URL('../apps/desktop/src/store/serverSessionStore.ts', import.meta.url),
    'utf8',
  );
  const fromWire = [...store.matchAll(/deriveAuthHash\([^)]*\)/g)].filter(
    (m) => !m[0].includes('DEFAULT_KDF_PARAMS'),
  );
  assert.equal(
    fromWire.length,
    1,
    `expected login alone to use server-sent parameters, found ${fromWire.length}: ` +
      fromWire.map((m) => m[0]).join(' | '),
  );
  // Whitespace-insensitive: prettier wraps the ternary across lines.
  assert.match(
    store.replace(/\s+/g, ' '),
    /e instanceof WeakKdfError \? translate\('session\.errWeakKdf'\)/,
    'the refusal must reach the screen as its own message, not as "wrong password"',
  );
});

console.log(`\n${passed} checks passed`);
