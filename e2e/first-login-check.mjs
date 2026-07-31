// Smoke check for first-login force-password-change (ADR 0010 addendum). Proves: an admin
// provisions a user (mustChangePassword=true); the user logs in with the admin-set password
// and the flag is surfaced; they change it (fresh vault + keypair, server never sees the
// password) which clears the flag; the OLD password no longer works and the NEW one logs in
// with the flag cleared and a decryptable vault. Run: node ../../e2e/first-login-check.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('/home/ange/Dev/projects/Rite/apps/desktop/index.html', import.meta.url));
const { argon2id } = require('hash-wasm');
const sodium = require('libsodium-wrappers'); await sodium.ready;

const BASE = `http://127.0.0.1:${process.env.RITE_SMOKE_PORT ?? '1422'}`;
const KDF = { mem: 19456, iter: 2, par: 1 };
const hx = (h) => new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const bh = (b) => Buffer.from(b).toString('hex');
const argon = (password, saltHex) => argon2id({ password, salt: hx(saltHex), parallelism: KDF.par, iterations: KDF.iter, memorySize: KDF.mem, hashLength: 32, outputType: 'hex' });
async function aes(k, p) { const iv = crypto.getRandomValues(new Uint8Array(12)); const key = await crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt']); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, p)); const u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); return `v1.${u(iv)}.${u(ct)}`; }
async function aesD(k, t) { const [, iv, ct] = t.split('.'); const d = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')); const key = await crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['decrypt']); return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: d(iv) }, key, d(ct))); }
async function post(path, body, token) { return fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) }); }

// Build the account-crypto payload for a password.
async function vaultFor(password) {
  const authSalt = bh(sodium.randombytes_buf(16));
  const authHash = await argon(password, authSalt);
  const masterSalt = bh(sodium.randombytes_buf(16));
  const masterKey = hx(await argon(password, masterSalt));
  const userKey = sodium.randombytes_buf(32);
  const kp = sodium.crypto_box_keypair();
  return {
    authSalt, authHash, masterSalt, userKey, kp,
    body: { salt: authSalt, params: KDF, authHash, masterSalt, protectedUserKey: await aes(masterKey, userKey), publicKey: bh(kp.publicKey), protectedPrivateKey: await aes(userKey, kp.privateKey) },
  };
}
async function login(username, password) {
  const pre = await (await post('/api/server/prelogin', { username })).json();
  const authHash = await argon(password, pre.salt);
  return (await post('/api/server/login', { username, authHash })).json();
}

let step = '';
const ok = (m) => console.log('  ✓ ' + m);
try {
  // 1. Bootstrap admin (sets their own password → no forced change).
  step = 'bootstrap';
  const av = await vaultFor('AdminPass1!');
  const boot = await (await post('/api/server/bootstrap', { username: 'admin', ...av.body })).json();
  assert.equal(boot.user.mustChangePassword, false, 'admin does not need a change');
  ok('bootstrapped admin (mustChangePassword=false)');

  // 2. Admin provisions bob with an initial password → mustChangePassword=true.
  step = 'provision';
  const bv = await vaultFor('TempPass1!');
  const created = await (await post('/api/admin/users', { username: 'bob', role: 'user', ...bv.body }, boot.token)).json();
  assert.equal(created.mustChangePassword, true, 'provisioned user must change');
  ok('admin provisioned bob (mustChangePassword=true)');

  // 3. Bob logs in with the admin-set password → flag surfaced.
  step = 'first-login';
  const bobL = await login('bob', 'TempPass1!');
  assert.equal(bobL.user.mustChangePassword, true, 'flag surfaced at first login');
  ok('bob first login surfaces mustChangePassword');

  // 4. Bob sets his own password (fresh vault + keypair) → flag cleared.
  step = 'change-password';
  const nv = await vaultFor('MyOwnPass9!');
  assert.equal((await post('/api/server/change-password', nv.body, bobL.token)).status, 204, 'change accepted');
  ok('bob set his own password');

  // 5. The OLD password no longer works; the NEW one logs in with the flag cleared and a
  //    vault that decrypts (proving the fresh keypair is coherent).
  step = 'verify';
  const oldTry = await login('bob', 'TempPass1!');
  assert.ok(oldTry.error, 'old password rejected');
  const newL = await login('bob', 'MyOwnPass9!');
  assert.ok(newL.token, 'new password logs in');
  assert.equal(newL.user.mustChangePassword, false, 'flag cleared after change');
  const mk = hx(await argon('MyOwnPass9!', newL.vault.kdfMasterSalt));
  const uk = await aesD(mk, newL.vault.protectedUserKey);
  await aesD(uk, newL.vault.protectedPrivateKey); // decrypts → keypair coherent
  ok('old password rejected; new one logs in, flag cleared, vault decrypts');

  console.log('\nFIRST-LOGIN OK — force-change re-keys the vault; server never saw the password');
} catch (e) {
  console.error(`\n✗ FAILED at step "${step}":`, e.message);
  process.exit(1);
}
