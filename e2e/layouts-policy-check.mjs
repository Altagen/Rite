// The layouts policy and the account's sealed copy (ADR 0027). Proves the policy
// round-trips through server_mode with the shipped defaults, that each half turns off on
// its own, that a non-admin cannot touch it, that validation refuses a non-boolean half —
// and that the blob route is per-account, opaque, and reports when it was written.
// Run: node e2e/layouts-policy-check.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../apps/desktop/index.html', import.meta.url));
const { argon2id } = require('hash-wasm');
const sodium = require('libsodium-wrappers');
await sodium.ready;

const BASE = `http://127.0.0.1:${process.env.RITE_SMOKE_PORT ?? '1422'}`;
const KDF = { mem: 19456, iter: 2, par: 1 };
const hx = (h) => new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const bh = (b) => Buffer.from(b).toString('hex');
const argon = (password, saltHex) =>
  argon2id({
    password,
    salt: hx(saltHex),
    parallelism: KDF.par,
    iterations: KDF.iter,
    memorySize: KDF.mem,
    hashLength: 32,
    outputType: 'hex',
  });
async function aes(k, p) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, p));
  const u = (b) =>
    Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `v1.${u(iv)}.${u(ct)}`;
}
async function post(path, body, token) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
}
async function patch(path, body, token) {
  return fetch(BASE + path, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
}
async function put(path, body, token) {
  return fetch(BASE + path, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
}
const get = (path, token) =>
  fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const getJson = (path, token) => get(path, token).then((r) => r.json());
async function vaultFor(password) {
  const authSalt = bh(sodium.randombytes_buf(16));
  const masterSalt = bh(sodium.randombytes_buf(16));
  const masterKey = hx(await argon(password, masterSalt));
  const userKey = sodium.randombytes_buf(32);
  const kp = sodium.crypto_box_keypair();
  return {
    kp,
    body: {
      salt: authSalt,
      params: KDF,
      authHash: await argon(password, authSalt),
      masterSalt,
      protectedUserKey: await aes(masterKey, userKey),
      publicKey: bh(kp.publicKey),
      protectedPrivateKey: await aes(userKey, kp.privateKey),
    },
  };
}
async function login(username, password) {
  const pre = await (await post('/api/server/prelogin', { username })).json();
  return (
    await post('/api/server/login', { username, authHash: await argon(password, pre.salt) })
  ).json();
}
const policy = () => getJson('/api/server/mode').then((m) => m.layoutsPolicy);

let step = '';
const ok = (m) => console.log('  ✓ ' + m);
try {
  step = 'setup';
  const av = await vaultFor('AdminPass1!');
  const admin = (
    await (await post('/api/server/bootstrap', { username: 'admin', ...av.body })).json()
  ).token;
  const bv = await vaultFor('BobTemp1!');
  await post('/api/admin/users', { username: 'bob', role: 'user', ...bv.body }, admin);
  const bob = (await login('bob', 'BobTemp1!')).token;
  ok('admin + non-admin bob provisioned');

  step = 'defaults';
  // Both true, so an instance that has never been configured has the feature on. Reading
  // silence as a refusal would turn layouts off for every server on upgrade.
  assert.deepEqual(
    await policy(),
    { webui: true, clients: true },
    'shipped defaults in server_mode',
  );
  ok('unconfigured server → { webui: true, clients: true }');

  step = 'per-shell';
  // Two shells, two statements: a browser reads the account's copy, a desktop window may
  // read a local file instead, and an admin may want one without the other.
  assert.equal(
    (await patch('/api/admin/layouts-policy', { webui: false, clients: true }, admin)).status,
    204,
    'webui off',
  );
  assert.deepEqual(await policy(), { webui: false, clients: true }, 'only the web UI is refused');
  assert.equal(
    (await patch('/api/admin/layouts-policy', { webui: true, clients: false }, admin)).status,
    204,
    'clients off',
  );
  assert.deepEqual(await policy(), { webui: true, clients: false }, 'only the clients are refused');
  assert.equal(
    (await patch('/api/admin/layouts-policy', { webui: false, clients: false }, admin)).status,
    204,
    'both off',
  );
  assert.deepEqual(await policy(), { webui: false, clients: false }, 'both off is the feature off');
  ok('each half turns off on its own, and both off is the whole feature');

  step = 'admin-only';
  assert.equal(
    (await patch('/api/admin/layouts-policy', { webui: true, clients: true }, bob)).status,
    403,
    'non-admin refused',
  );
  assert.deepEqual(await policy(), { webui: false, clients: false }, 'and the policy is untouched');
  ok('a non-admin cannot change it (403), and nothing moved');

  step = 'validation';
  for (const [body, why] of [
    [{ webui: 'yes', clients: true }, 'a non-boolean half'],
    [{ webui: true, clients: 1 }, 'a numeric half'],
  ]) {
    assert.equal(
      (await patch('/api/admin/layouts-policy', body, admin)).status,
      400,
      `rejected: ${why}`,
    );
  }
  assert.deepEqual(await policy(), { webui: false, clients: false }, 'no rejected write landed');
  ok('validation refuses a half that is not a boolean; nothing partial stored');

  step = 'reopen';
  assert.equal(
    (await patch('/api/admin/layouts-policy', { webui: true, clients: true }, admin)).status,
    204,
    'reopen',
  );
  assert.deepEqual(await policy(), { webui: true, clients: true }, 'back to both allowed');
  ok('the policy reopens cleanly');

  step = 'blob';
  // The policy governs the surfaces; the route stays open either way, because the server
  // cannot tell a sealed layouts write from any other and has nothing to enforce.
  assert.deepEqual(
    await getJson('/api/user/layouts', bob),
    { blob: null, updatedAt: null },
    'nothing stored yet',
  );
  const sealed = 'v1.ZmFrZS1pdg.c2VhbGVkLWxheW91dHM';
  assert.equal((await put('/api/user/layouts', { blob: sealed }, bob)).status, 204, 'stored');
  const read = await getJson('/api/user/layouts', bob);
  assert.equal(read.blob, sealed, 'returned verbatim — the server never parses it');
  assert.equal(typeof read.updatedAt, 'number', 'and says when it was written');
  ok('the blob round-trips untouched, with its write time');

  step = 'per-account';
  // One row per user. Two accounts on one instance must not see each other's workspace,
  // and the admin is not an exception: they hold no key for it either.
  assert.equal(
    (await getJson('/api/user/layouts', admin)).blob,
    null,
    "the admin sees nothing of bob's",
  );
  const mine = 'v1.b3RoZXItaXY.b3RoZXItY3Q';
  assert.equal(
    (await put('/api/user/layouts', { blob: mine }, admin)).status,
    204,
    'the admin stores their own',
  );
  assert.equal((await getJson('/api/user/layouts', bob)).blob, sealed, "and bob's is unchanged");
  ok('one row per account, and nobody reads another one');

  step = 'overwrite';
  // Last write wins, documented rather than guarded (ADR 0027). Asserted so a future
  // conflict guard has to come with a decision rather than appearing by accident.
  const second = 'v1.c2Vjb25kLWl2.c2Vjb25kLWN0';
  const before = (await getJson('/api/user/layouts', bob)).updatedAt;
  assert.equal(
    (await put('/api/user/layouts', { blob: second }, bob)).status,
    204,
    'second write accepted',
  );
  const after = await getJson('/api/user/layouts', bob);
  assert.equal(after.blob, second, 'the second write won, with no merge and no 409');
  assert.ok(after.updatedAt >= before, 'and the write time moved forward');
  ok('a second write overwrites the first, as documented');

  step = 'anonymous';
  assert.equal((await get('/api/user/layouts')).status, 401, 'no session, no blob');
  assert.equal(
    (await put('/api/user/layouts', { blob: sealed })).status,
    401,
    'and nothing to write to',
  );
  ok('the route needs a session');

  console.log('\n✅ layouts-policy-check passed');
} catch (e) {
  console.error(`\n❌ layouts-policy-check failed at [${step}]:`, e.message);
  process.exit(1);
}
