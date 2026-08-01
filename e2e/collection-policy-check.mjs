// Smoke check for collection governance policy (admin → Collections). Proves the policy
// round-trips through server_mode and that "allow users to create collections" is actually
// enforced: with it off a non-admin is refused (403) while an admin still creates; back on,
// the non-admin can create again. Run: node e2e/collection-policy-check.mjs
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
async function patch(path, body, token) { return fetch(BASE + path, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) }); }
const getJson = (path, token) => fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then((r) => r.json());
async function vaultFor(password) {
  const authSalt = bh(sodium.randombytes_buf(16)); const masterSalt = bh(sodium.randombytes_buf(16));
  const masterKey = hx(await argon(password, masterSalt)); const userKey = sodium.randombytes_buf(32); const kp = sodium.crypto_box_keypair();
  return { kp, body: { salt: authSalt, params: KDF, authHash: await argon(password, authSalt), masterSalt, protectedUserKey: await aes(masterKey, userKey), publicKey: bh(kp.publicKey), protectedPrivateKey: await aes(userKey, kp.privateKey) } };
}
async function login(username, password) { const pre = await (await post('/api/server/prelogin', { username })).json(); return (await post('/api/server/login', { username, authHash: await argon(password, pre.salt) })).json(); }
// A minimal, well-formed create-collection body sealed to `kp`.
async function newCollectionBody(kp) {
  const metaKey = sodium.randombytes_buf(32), itemsKey = sodium.randombytes_buf(32);
  const nameEnc = await aes(metaKey, new TextEncoder().encode(JSON.stringify({ name: 'X', color: '#fff' })));
  return { nameEnc, protectedMetaKey: b64(sodium.crypto_box_seal(metaKey, kp.publicKey)), protectedItemsKey: b64(sodium.crypto_box_seal(itemsKey, kp.publicKey)), metaKeyGroupEnc: null, groupEpoch: null };
}

let step = '';
const ok = (m) => console.log('  ✓ ' + m);
try {
  step = 'setup';
  const av = await vaultFor('AdminPass1!');
  const admin = (await (await post('/api/server/bootstrap', { username: 'admin', ...av.body })).json()).token;
  const bv = await vaultFor('BobTemp1!');
  await post('/api/admin/users', { username: 'bob', role: 'user', ...bv.body }, admin);
  const bobL = await login('bob', 'BobTemp1!');
  ok('admin + non-admin bob provisioned');

  step = 'default-policy';
  const mode0 = await getJson('/api/server/mode');
  assert.deepEqual(mode0.collectionPolicy, { allowCreate: true, allowSharingOutsideTeams: true, maxMembers: 0, defaultRole: 'viewer' }, 'permissive defaults in server_mode');
  ok('default policy surfaced in server_mode');

  step = 'allow-create-on';
  assert.equal((await post('/api/collections', await newCollectionBody(bv.kp), bobL.token)).status, 201, 'bob can create by default');
  ok('with create allowed, bob creates a collection (201)');

  step = 'restrict-create';
  assert.equal((await patch('/api/admin/collection-policy', { allowCreate: false, allowSharingOutsideTeams: true, maxMembers: 0, defaultRole: 'viewer' }, admin)).status, 204, 'policy set');
  assert.equal((await getJson('/api/server/mode')).collectionPolicy.allowCreate, false, 'server_mode reflects the change');
  assert.equal((await post('/api/collections', await newCollectionBody(bv.kp), bobL.token)).status, 403, 'non-admin create refused');
  assert.equal((await post('/api/collections', await newCollectionBody(av.kp), admin)).status, 201, 'admin still creates');
  ok('create off → bob 403, admin bypasses (201)');

  step = 'validation';
  assert.equal((await patch('/api/admin/collection-policy', { defaultRole: 'owner' }, admin)).status, 400, 'invalid default role rejected');
  ok('policy validation rejects a bad default role');

  step = 'reopen';
  assert.equal((await patch('/api/admin/collection-policy', { allowCreate: true, allowSharingOutsideTeams: true, maxMembers: 0, defaultRole: 'editor' }, admin)).status, 204, 'reopen');
  assert.equal((await post('/api/collections', await newCollectionBody(bv.kp), bobL.token)).status, 201, 'bob creates again');
  ok('create re-allowed → bob creates again (201)');

  console.log('\n✅ collection-policy-check passed');
} catch (e) {
  console.error(`\n❌ collection-policy-check failed at [${step}]:`, e.message);
  process.exit(1);
}
