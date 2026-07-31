// Smoke check for admin-authorised account reset (ADR 0010 addendum). Proves: after a user
// has their own password + a collection membership, an admin reset (temp password) FLAGS the
// account must-change again, WIPES the user's sharing (their collection membership is gone —
// they'll re-request), KEEPS their team membership, the old password is rejected and the temp
// one logs in with must-change set. Run: node ../../e2e/reset-check.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('/home/ange/Dev/projects/Rite/apps/desktop/index.html', import.meta.url));
const { argon2id } = require('hash-wasm');
const sodium = require('libsodium-wrappers'); await sodium.ready;

const BASE = `http://127.0.0.1:${process.env.RITE_SMOKE_PORT ?? '1422'}`;
const KDF = { mem: 19456, iter: 2, par: 1 };
const hx = (h) => new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const bh = (b) => Buffer.from(b).toString('hex');
const b64 = (b) => Buffer.from(b).toString('base64');
const argon = (password, saltHex) => argon2id({ password, salt: hx(saltHex), parallelism: KDF.par, iterations: KDF.iter, memorySize: KDF.mem, hashLength: 32, outputType: 'hex' });
async function aes(k, p) { const iv = crypto.getRandomValues(new Uint8Array(12)); const key = await crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt']); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, p)); const u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); return `v1.${u(iv)}.${u(ct)}`; }
async function post(path, body, token) { return fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) }); }
const getJson = (path, token) => fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then((r) => r.json());
async function vaultFor(password) {
  const authSalt = bh(sodium.randombytes_buf(16));
  const masterSalt = bh(sodium.randombytes_buf(16));
  const masterKey = hx(await argon(password, masterSalt));
  const userKey = sodium.randombytes_buf(32);
  const kp = sodium.crypto_box_keypair();
  return { kp, body: { salt: authSalt, params: KDF, authHash: await argon(password, authSalt), masterSalt, protectedUserKey: await aes(masterKey, userKey), publicKey: bh(kp.publicKey), protectedPrivateKey: await aes(userKey, kp.privateKey) } };
}
async function login(username, password) { const pre = await (await post('/api/server/prelogin', { username })).json(); return (await post('/api/server/login', { username, authHash: await argon(password, pre.salt) })).json(); }

let step = '';
const ok = (m) => console.log('  ✓ ' + m);
try {
  step = 'setup';
  const av = await vaultFor('AdminPass1!');
  const boot = await (await post('/api/server/bootstrap', { username: 'admin', ...av.body })).json();
  const admin = boot.token, adminK = av.kp;
  const bv = await vaultFor('TempPass1!');
  const bob = await (await post('/api/admin/users', { username: 'bob', role: 'user', ...bv.body }, admin)).json();
  // Bob force-changes to his own password (fresh keypair).
  const bobL1 = await login('bob', 'TempPass1!');
  const nv = await vaultFor('BobOwnPass9!');
  await post('/api/server/change-password', nv.body, bobL1.token);
  const bobPub = nv.kp.publicKey; // bob's post-change public key
  ok('admin provisioned bob; bob set his own password');

  step = 'grant-membership';
  // Team + collection membership so we can see the reset wipe them / keep them.
  const eng = await (await post('/api/admin/teams', { name: 'eng' }, admin)).json();
  await post(`/api/teams/${eng.id}/members`, { userId: bob.id, role: 'member' }, admin);
  const metaKey = sodium.randombytes_buf(32), itemsKey = sodium.randombytes_buf(32);
  const nameEnc = await aes(metaKey, new TextEncoder().encode(JSON.stringify({ name: 'C', color: '#fff' })));
  const c = await (await post('/api/collections', { nameEnc, protectedMetaKey: b64(sodium.crypto_box_seal(metaKey, adminK.publicKey)), protectedItemsKey: b64(sodium.crypto_box_seal(itemsKey, adminK.publicKey)), metaKeyGroupEnc: null, groupEpoch: null }, admin)).json();
  await post(`/api/collections/${c.id}/members`, { userId: bob.id, role: 'viewer', protectedMetaKey: b64(sodium.crypto_box_seal(metaKey, bobPub)), protectedItemsKey: b64(sodium.crypto_box_seal(itemsKey, bobPub)) }, admin);
  assert.equal((await getJson('/api/collections', bobL1.token)).length, 1, 'bob has the collection');
  ok('bob is in team eng + a collection');

  step = 'reset';
  const tv = await vaultFor('ResetTemp2!');
  assert.equal((await post(`/api/admin/users/${bob.id}/reset`, tv.body, admin)).status, 204, 'reset accepted');
  ok('admin reset bob with a temp password');

  step = 'verify';
  // Old (self-set) password no longer works.
  assert.ok((await login('bob', 'BobOwnPass9!')).error, 'old password rejected');
  // Temp password logs in, must-change is set again.
  const bobL2 = await login('bob', 'ResetTemp2!');
  assert.ok(bobL2.token, 'temp password logs in');
  assert.equal(bobL2.user.mustChangePassword, true, 'must-change set after reset');
  // Sharing wiped: no collections. Identity + team KEPT.
  assert.equal((await getJson('/api/collections', bobL2.token)).length, 0, 'collection membership wiped');
  assert.equal((await getJson('/api/teams', bobL2.token)).length, 1, 'team membership kept');
  ok('old rejected; temp logs in (must-change); sharing wiped, team kept');

  console.log('\nRESET OK — identity+teams kept, sharing wiped, user re-keys on next login');
} catch (e) {
  console.error(`\n✗ FAILED at step "${step}":`, e.message);
  process.exit(1);
}
