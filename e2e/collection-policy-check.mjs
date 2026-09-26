// Smoke check for collection governance policy (admin → Collections). Proves the policy
// round-trips through server_mode and that "allow users to create collections" is actually
// enforced: with it off a non-admin is refused (403) while an admin still creates; back on,
// the non-admin can create again. Run: node e2e/collection-policy-check.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../apps/desktop/index.html', import.meta.url));
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
// Create a collection owned by `kp` and keep its keys, so we can seal them to another member.
async function createColl(token, kp) {
  const metaKey = sodium.randombytes_buf(32), itemsKey = sodium.randombytes_buf(32);
  const nameEnc = await aes(metaKey, new TextEncoder().encode(JSON.stringify({ name: 'C', color: '#fff' })));
  const { id } = await (await post('/api/collections', { nameEnc, protectedMetaKey: b64(sodium.crypto_box_seal(metaKey, kp.publicKey)), protectedItemsKey: b64(sodium.crypto_box_seal(itemsKey, kp.publicKey)), metaKeyGroupEnc: null, groupEpoch: null }, token)).json();
  return { id, metaKey, itemsKey };
}
// Add `userPubHex` as a member of `id`, sealing the collection keys to them.
const addMember = (id, userId, userPubHex, metaKey, itemsKey, token, role = 'viewer') =>
  post(`/api/collections/${id}/members`, { userId, role, protectedMetaKey: b64(sodium.crypto_box_seal(metaKey, hx(userPubHex))), protectedItemsKey: b64(sodium.crypto_box_seal(itemsKey, hx(userPubHex))) }, token);

let step = '';
const ok = (m) => console.log('  ✓ ' + m);
try {
  step = 'setup';
  const av = await vaultFor('AdminPass1!');
  const admin = (await (await post('/api/server/bootstrap', { username: 'admin', ...av.body })).json()).token;
  const bv = await vaultFor('BobTemp1!');
  const bob = await (await post('/api/admin/users', { username: 'bob', role: 'user', ...bv.body }, admin)).json();
  const bobL = await login('bob', 'BobTemp1!');
  const cv = await vaultFor('CarolTemp1!');
  const carol = await (await post('/api/admin/users', { username: 'carol', role: 'user', ...cv.body }, admin)).json();
  const carolPub = bh(cv.kp.publicKey);
  ok('admin + non-admins bob & carol provisioned');

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

  step = 'max-members';
  // Cap at 1: bob's fresh collection already has him (owner) → adding anyone exceeds it.
  assert.equal((await patch('/api/admin/collection-policy', { allowCreate: true, allowSharingOutsideTeams: true, maxMembers: 1, defaultRole: 'viewer' }, admin)).status, 204, 'cap set');
  const capped = await createColl(bobL.token, bv.kp);
  assert.equal((await addMember(capped.id, carol.id, carolPub, capped.metaKey, capped.itemsKey, bobL.token)).status, 409, 'add past cap refused');
  ok('member cap enforced → adding past the limit is 409');

  step = 'sharing-outside-teams';
  assert.equal((await patch('/api/admin/collection-policy', { allowCreate: true, allowSharingOutsideTeams: false, maxMembers: 0, defaultRole: 'viewer' }, admin)).status, 204, 'external sharing off');
  const shared = await createColl(bobL.token, bv.kp);
  // bob and carol share no team yet → refused.
  assert.equal((await addMember(shared.id, carol.id, carolPub, shared.metaKey, shared.itemsKey, bobL.token)).status, 403, 'outside-team add refused');
  // Admin puts them in the same team → now bob may add carol.
  const team = await (await post('/api/admin/teams', { name: 'eng' }, admin)).json();
  await post(`/api/teams/${team.id}/members`, { userId: bob.id, role: 'member' }, admin);
  await post(`/api/teams/${team.id}/members`, { userId: carol.id, role: 'member' }, admin);
  assert.equal((await addMember(shared.id, carol.id, carolPub, shared.metaKey, shared.itemsKey, bobL.token)).status, 204, 'teammate add allowed');
  ok('no-sharing-outside-teams enforced → non-teammate 403, teammate 204');

  console.log('\n✅ collection-policy-check passed');
} catch (e) {
  console.error(`\n❌ collection-policy-check failed at [${step}]:`, e.message);
  process.exit(1);
}
