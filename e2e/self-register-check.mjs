// Self-service registration smoke (ADR 0015 phase 1). Proves the open_registration gate:
// register is 403 while off; an admin flips it on; a visitor self-registers (role user) and can
// log in; a duplicate username is 409; an empty username is 400; a manager cannot flip the setting
// (admin-only); and turning it back off closes registration again.
// Self-contained: spawns one accounts server. Runs where rite-server runs (host / CI, or inside the
// ISO-CI container in a sandbox that blocks a standalone server binary):  node e2e/self-register-check.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BIN = join(ROOT, 'target/debug/rite-server');
const WEB = join(ROOT, 'apps/desktop/dist');
const require = createRequire(join(ROOT, 'apps/desktop/index.html'));
const { argon2id } = require('hash-wasm');
const sodium = require('libsodium-wrappers');
await sodium.ready;

const PORT = 18456;
const BASE = `http://127.0.0.1:${PORT}`;
const KDF = { mem: 19456, iter: 2, par: 1 };
const hx = (h) => new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const bh = (b) => Buffer.from(b).toString('hex');
const argon = (password, saltHex) =>
  argon2id({ password, salt: hx(saltHex), parallelism: KDF.par, iterations: KDF.iter, memorySize: KDF.mem, hashLength: 32, outputType: 'hex' });
async function aes(k, p) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, p));
  const u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `v1.${u(iv)}.${u(ct)}`;
}
const post = (path, body, token) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
const patch = (path, body, token) =>
  fetch(BASE + path, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });

// The account-crypto payload a client builds for a signup (the server never sees the password).
async function vaultBody(username, password, role) {
  const authSalt = bh(sodium.randombytes_buf(16));
  const masterSalt = bh(sodium.randombytes_buf(16));
  const masterKey = hx(await argon(password, masterSalt));
  const userKey = sodium.randombytes_buf(32);
  const kp = sodium.crypto_box_keypair();
  return {
    username,
    role, // ignored by /register (forced to user); harmless extra field
    salt: authSalt,
    params: KDF,
    authHash: await argon(password, authSalt),
    masterSalt,
    protectedUserKey: await aes(masterKey, userKey),
    publicKey: bh(kp.publicKey),
    protectedPrivateKey: await aes(userKey, kp.privateKey),
  };
}
async function login(username, password) {
  const pre = await (await post('/api/server/prelogin', { username })).json();
  return (await post('/api/server/login', { username, authHash: await argon(password, pre.salt) })).json();
}

let proc, home;
async function up(tries = 100) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/api/server/mode'); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server never came up');
}
function cleanup() {
  try { proc?.kill('SIGKILL'); } catch { /* gone */ }
  try { rmSync(home, { recursive: true, force: true }); } catch { /* gone */ }
}

const ok = (m) => console.log('  ✓ ' + m);
let step = '';
try {
  step = 'boot';
  home = mkdtempSync(join(tmpdir(), 'rite-reg-'));
  proc = spawn(BIN, [], {
    env: { ...process.env, HOME: home, RITE_WEB_DIR: WEB, RUST_LOG: 'warn', RITE_ADDR: `127.0.0.1:${PORT}`, RITE_ACCOUNTS: '1', RITE_ADMIN_USER: 'envadmin', RITE_ADMIN_PASSWORD: 'EnvPass123!' },
    stdio: 'ignore',
  });
  await up();
  const mode = await (await fetch(BASE + '/api/server/mode')).json();
  assert.equal(mode.openRegistration, false, 'open registration is off by default');
  ok('server up; open registration off by default');

  step = 'closed-rejects';
  assert.equal((await post('/api/server/register', await vaultBody('alice', 'AlicePass123!', 'user'))).status, 403, 'register 403 while closed');
  ok('registration is refused (403) while the setting is off');

  step = 'admin-opens';
  const admin = (await login('envadmin', 'EnvPass123!')).token;
  assert.ok(admin, 'admin logged in');
  assert.equal((await patch('/api/admin/registration', { enabled: true }, admin)).status, 204, 'admin enables registration');
  ok('admin turned open registration on');

  step = 'self-register';
  const reg = await post('/api/server/register', await vaultBody('alice', 'AlicePass123!', 'user'));
  assert.equal(reg.status, 201, 'register succeeds');
  const body = await reg.json();
  assert.equal(body.user.role, 'user', 'self-registered account is role user');
  assert.ok(body.token, 'register returns a session token');
  assert.ok((await login('alice', 'AlicePass123!')).token, 'the new user can log in');
  ok('a visitor self-registered (role user) and can log in');

  step = 'guards';
  assert.equal((await post('/api/server/register', await vaultBody('alice', 'Other12345!', 'user'))).status, 409, 'duplicate username 409');
  assert.equal((await post('/api/server/register', await vaultBody('   ', 'Blank12345!', 'user'))).status, 400, 'empty username 400');
  ok('duplicate username → 409, empty username → 400');

  step = 'manager-cannot-toggle';
  const mgr = await (await post('/api/admin/users', { ...(await vaultBody('mgr', 'MgrPass1234!', 'manager')) }, admin)).json();
  assert.equal(mgr.role, 'manager', 'admin made a manager');
  const mgrTok = (await login('mgr', 'MgrPass1234!')).token;
  assert.equal((await patch('/api/admin/registration', { enabled: false }, mgrTok)).status, 403, 'manager cannot flip registration');
  ok('a manager cannot change the registration setting (admin-only, 403)');

  step = 'admin-closes';
  assert.equal((await patch('/api/admin/registration', { enabled: false }, admin)).status, 204, 'admin disables registration');
  assert.equal((await post('/api/server/register', await vaultBody('bob', 'BobPass1234!', 'user'))).status, 403, 'register 403 again once closed');
  ok('admin closed registration again → new signups refused (403)');

  console.log('\n✅ SELF-REGISTRATION OK — opt-in open_registration gate, role user, admin-only toggle (ADR 0015 phase 1)');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error(`\n✗ FAILED at "${step}": ${e.message}`);
  cleanup();
  process.exit(1);
}
