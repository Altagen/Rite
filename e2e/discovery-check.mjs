// End-to-end smoke check for the collections offer → request → grant loop (ADR 0016,
// Parts B+C). Drives a running rite-server in accounts mode on :1422 over HTTP with the
// REAL client crypto (Argon2id auth hash, X25519 sealed boxes, AES-256-GCM), proving:
//   1. an owner offers a collection to a team (plaintext discovery label);
//   2. a team member discovers it (/offered) and requests access — a non-team user can't;
//   3. an owner/editor sees the request (/requests), grants it (re-seals metaKey+itemsKey),
//      and clears it; the granted user can then unwrap the keys and DECRYPT the name + a
//      machine — i.e. real access, zero-knowledge preserved (server stored only ciphertext).
// Run from apps/desktop so libsodium-wrappers / hash-wasm resolve:
//   node ../../e2e/discovery-check.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
// hash-wasm + libsodium are declared in apps/desktop — resolve from there.
const require = createRequire(new URL('../apps/desktop/index.html', import.meta.url));
const { argon2id } = require('hash-wasm');
const sodium = require('libsodium-wrappers');
await sodium.ready;

const BASE = `http://127.0.0.1:${process.env.RITE_SMOKE_PORT ?? '1422'}`;
const KDF = { mem: 19456, iter: 2, par: 1 };
const hexToBytes = (h) => new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const bytesToHex = (b) => Buffer.from(b).toString('hex');
const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b) => JSON.parse(new TextDecoder().decode(b));
const rand = (n) => sodium.randombytes_buf(n);

async function post(path, body, token) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return r;
}
async function req(method, path, token, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return r;
}
const getJson = async (path, token) => (await req('GET', path, token)).json();

// --- AES-256-GCM in the vault wire format (v1.iv.ct, base64url) ---
async function aesEncrypt(keyBytes, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `v1.${u(iv)}.${u(ct)}`;
}
async function aesDecrypt(keyBytes, token) {
  const [, ivB, ctB] = token.split('.');
  const d = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: d(ivB) }, key, d(ctB)));
}

// --- account crypto (ADR 0011): build a fresh vault for `password` ---
async function makeAccount(username, password, role) {
  const authSalt = bytesToHex(rand(16));
  const authHash = await argon2id({ password, salt: hexToBytes(authSalt), parallelism: KDF.par, iterations: KDF.iter, memorySize: KDF.mem, hashLength: 32, outputType: 'hex' });
  const masterSalt = bytesToHex(rand(16));
  const masterKey = hexToBytes(await argon2id({ password, salt: hexToBytes(masterSalt), parallelism: KDF.par, iterations: KDF.iter, memorySize: KDF.mem, hashLength: 32, outputType: 'hex' }));
  const userKey = rand(32);
  const kp = sodium.crypto_box_keypair();
  return {
    username, role,
    salt: authSalt, params: KDF, authHash, masterSalt,
    protectedUserKey: await aesEncrypt(masterKey, userKey),
    publicKey: bytesToHex(kp.publicKey),
    protectedPrivateKey: await aesEncrypt(userKey, kp.privateKey),
  };
}
async function loginFull(username, password) {
  const pre = await (await post('/api/server/prelogin', { username })).json();
  const authHash = await argon2id({ password, salt: hexToBytes(pre.salt), parallelism: pre.params.par, iterations: pre.params.iter, memorySize: pre.params.mem, hashLength: 32, outputType: 'hex' });
  return (await post('/api/server/login', { username, authHash })).json();
}
async function unlockKeys(password, vault) {
  const masterKey = hexToBytes(await argon2id({ password, salt: hexToBytes(vault.kdfMasterSalt), parallelism: KDF.par, iterations: KDF.iter, memorySize: KDF.mem, hashLength: 32, outputType: 'hex' }));
  const userKey = await aesDecrypt(masterKey, vault.protectedUserKey);
  const privateKey = await aesDecrypt(userKey, vault.protectedPrivateKey);
  return { userKey, privateKey, publicKey: hexToBytes(vault.publicKey) };
}

// ---------------------------------------------------------------------------
const P = 'Pass123!word';
let step = '';
const ok = (m) => console.log('  ✓ ' + m);
try {
  // 1. Bootstrap the first admin (alice = collection owner + team member).
  step = 'bootstrap';
  const aliceAcc = await makeAccount('alice', P, 'admin');
  const bootstrap = await post('/api/server/bootstrap', aliceAcc);
  assert.equal(bootstrap.status, 200, 'bootstrap should succeed');
  const aliceL = await bootstrap.json();
  const aliceTok = aliceL.token;
  const aliceK = await unlockKeys(P, aliceL.vault);
  ok('bootstrapped admin alice');

  // 2. Alice provisions bob (team member/requester) and carol (outsider).
  const provision = async (u) => {
    const acc = await makeAccount(u, P, 'user');
    assert.equal((await post('/api/admin/users', acc, aliceTok)).status, 201, `create ${u}`);
  };
  await provision('bob');
  await provision('carol');
  const dir = await getJson('/api/directory', aliceTok);
  const uid = (n) => dir.find((u) => u.username === n).id;
  const bobPub = hexToBytes(dir.find((u) => u.username === 'bob').publicKey);
  ok('provisioned bob + carol');

  // 3. Team 'eng' with alice + bob (carol excluded).
  const eng = await (await post('/api/admin/teams', { name: 'eng' }, aliceTok)).json();
  await post(`/api/teams/${eng.id}/members`, { userId: uid('alice'), role: 'admin' }, aliceTok);
  await post(`/api/teams/${eng.id}/members`, { userId: uid('bob'), role: 'member' }, aliceTok);
  ok('created team eng (alice + bob)');

  // 4. Alice creates a split-key collection (metaKey=name, itemsKey=machines), sealed to
  //    herself, with one encrypted machine.
  const metaKey = rand(32), itemsKey = rand(32);
  const nameEnc = await aesEncrypt(metaKey, enc({ name: 'Prod servers', color: '#f7768e' }));
  const created = await post('/api/collections', {
    nameEnc,
    protectedMetaKey: b64(sodium.crypto_box_seal(metaKey, aliceK.publicKey)),
    protectedItemsKey: b64(sodium.crypto_box_seal(itemsKey, aliceK.publicKey)),
    metaKeyGroupEnc: null, groupEpoch: null,
  }, aliceTok);
  assert.equal(created.status, 201, 'collection create');
  const { id: cid } = await created.json();
  const machineBlob = await aesEncrypt(itemsKey, enc({ name: 'web-01', host: 'coll-secret-host', user: 'deploy', port: 22 }));
  assert.equal((await post(`/api/collections/${cid}/items`, { blob: machineBlob }, aliceTok)).status, 201, 'add machine');
  ok('created collection with an encrypted machine');

  // 5. Offer it to eng (owner-only). A non-owner can't.
  assert.equal((await req('PUT', `/api/collections/${cid}/offer`, aliceTok, { teamId: eng.id, discoveryLabel: 'Production servers' })).status, 204, 'offer');
  ok('offered collection to eng');

  // 6. Discovery RBAC: bob (team member, not collection member) sees the label; carol (not
  //    in the team) sees nothing.
  const bobL = await loginFull('bob', P);
  const carolL = await loginFull('carol', P);
  const bobOffered = await getJson('/api/collections/offered', bobL.token);
  assert.equal(bobOffered.length, 1, 'bob sees 1 offered');
  assert.equal(bobOffered[0].discoveryLabel, 'Production servers');
  assert.equal(bobOffered[0].memberRole, null, 'bob is not yet a member');
  assert.equal((await getJson('/api/collections/offered', carolL.token)).length, 0, 'carol (outsider) sees nothing — no leak');
  ok('discovery RBAC: bob discovers it, carol sees nothing');

  // 7. Bob can't read the machines yet, then requests access.
  assert.equal((await req('GET', `/api/collections/${cid}/items`, bobL.token)).status, 403, 'bob 403 before grant');
  assert.equal((await post(`/api/collections/${cid}/request`, {}, bobL.token)).status, 204, 'bob requests');
  // carol can't request (not discoverable by her).
  assert.equal((await post(`/api/collections/${cid}/request`, {}, carolL.token)).status, 403, 'carol cannot request');
  ok('bob requested access; carol refused');

  // 8. Alice (owner) sees the request in her inbox, grants it (re-seal), clears it.
  const inbox = await getJson('/api/collections/requests', aliceTok);
  assert.equal(inbox.length, 1, 'one incoming request');
  assert.equal(inbox[0].username, 'bob');
  assert.equal(inbox[0].teamName, 'eng', 'request carries the team context');
  assert.equal((await post(`/api/collections/${cid}/members`, {
    userId: uid('bob'), role: 'viewer',
    protectedMetaKey: b64(sodium.crypto_box_seal(metaKey, bobPub)),
    protectedItemsKey: b64(sodium.crypto_box_seal(itemsKey, bobPub)),
  }, aliceTok)).status, 204, 'grant (add member)');
  assert.equal((await req('DELETE', `/api/collections/${cid}/request`, aliceTok, { userId: uid('bob') })).status, 204, 'clear request');
  assert.equal((await getJson('/api/collections/requests', aliceTok)).length, 0, 'inbox now empty');
  ok('alice granted bob + cleared the request');

  // 9. Bob now has real access: unwrap HIS sealed keys and DECRYPT the name + the machine.
  const bobK = await unlockKeys(P, bobL.vault);
  const mine = (await getJson('/api/collections', bobL.token)).find((c) => c.id === cid);
  assert.ok(mine, 'bob now lists the collection');
  assert.equal(mine.role, 'viewer');
  const bobMeta = sodium.crypto_box_seal_open(unb64(mine.protectedMetaKey), bobK.publicKey, bobK.privateKey);
  const bobItems = sodium.crypto_box_seal_open(unb64(mine.protectedItemsKey), bobK.publicKey, bobK.privateKey);
  assert.equal(dec(await aesDecrypt(bobMeta, mine.nameEnc)).name, 'Prod servers', 'bob decrypts the real name');
  const items = await getJson(`/api/collections/${cid}/items`, bobL.token);
  assert.equal(dec(await aesDecrypt(bobItems, items[0].blob)).host, 'coll-secret-host', 'bob decrypts the machine');
  // Zero-knowledge: the server never held the plaintext.
  assert.match(mine.nameEnc, /^v1\./);
  assert.ok(!JSON.stringify(items).includes('coll-secret-host'), 'server stored only ciphertext');
  ok('bob decrypts the real name + machine (grant works, zero-knowledge holds)');

  // 10. Leave-team: a member self-leaves; the last manager can't (≥1-manager invariant).
  step = 'leave-team';
  assert.equal((await req('DELETE', `/api/teams/${eng.id}/members/${uid('bob')}`, bobL.token)).status, 204, 'bob self-leaves');
  assert.equal((await getJson('/api/teams', bobL.token)).find((t) => t.id === eng.id), undefined, 'bob no longer in eng');
  // Alice is now the only manager → she can't leave.
  assert.equal((await req('DELETE', `/api/teams/${eng.id}/members/${uid('alice')}`, aliceTok)).status, 409, 'last manager blocked');
  ok('bob left the team; the last manager is blocked from leaving');

  console.log('\nDISCOVERY LOOP OK — offer → discover → request → grant → leave, RBAC + zero-knowledge verified');
} catch (e) {
  console.error(`\n✗ FAILED at step "${step}":`, e.message);
  process.exit(1);
}
