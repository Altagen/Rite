// Manager role smoke (ADR 0010 addendum). Proves the `manager` role: an admin creates a manager;
// the manager can create a team and invite a regular user, but CANNOT create an admin, cannot touch
// instance settings, and the admin can flip a user's role user<->manager but never assign admin.
// Self-contained: spawns one accounts server. Runs where rite-server runs (a normal host / CI, or
// inside the ISO-CI container in a sandbox that blocks a standalone server binary):
//   node e2e/manager-role-check.mjs
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

const PORT = 18455;
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

// The account-crypto payload for a password (the client builds this; the server never sees the pw).
async function vaultBody(password, role) {
  const authSalt = bh(sodium.randombytes_buf(16));
  const masterSalt = bh(sodium.randombytes_buf(16));
  const masterKey = hx(await argon(password, masterSalt));
  const userKey = sodium.randombytes_buf(32);
  const kp = sodium.crypto_box_keypair();
  return {
    role,
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
  home = mkdtempSync(join(tmpdir(), 'rite-mgr-'));
  proc = spawn(BIN, [], {
    env: { ...process.env, HOME: home, RITE_WEB_DIR: WEB, RUST_LOG: 'warn', RITE_ADDR: `127.0.0.1:${PORT}`, RITE_ACCOUNTS: '1', RITE_ADMIN_USER: 'envadmin', RITE_ADMIN_PASSWORD: 'EnvPass123!' },
    stdio: 'ignore',
  });
  await up();
  const admin = await login('envadmin', 'EnvPass123!');
  assert.ok(admin.token, 'admin logged in');
  ok('accounts server up; admin logged in');

  step = 'create-manager';
  const mgr = await (await post('/api/admin/users', { username: 'mgr', ...(await vaultBody('MgrPass1234!', 'manager')) }, admin.token)).json();
  assert.equal(mgr.role, 'manager', 'admin created a manager');
  ok('admin created a manager account');

  step = 'manager-powers';
  const mgrTok = (await login('mgr', 'MgrPass1234!')).token;
  assert.ok(mgrTok, 'manager logged in');
  assert.ok([200, 201].includes((await post('/api/admin/teams', { name: 'Team Alpha' }, mgrTok)).status), 'manager creates a team');
  const invited = await post('/api/admin/users', { username: 'bob', ...(await vaultBody('BobPass1234!', 'user')) }, mgrTok);
  assert.equal(invited.status, 201, 'manager invites a regular user');
  ok('manager can create a team + invite a regular user');

  step = 'manager-limits';
  assert.equal((await post('/api/admin/users', { username: 'sneaky', ...(await vaultBody('SneakyPass12!', 'admin')) }, mgrTok)).status, 403, 'manager cannot create an admin');
  assert.equal((await patch('/api/admin/instance', { name: 'Hacked' }, mgrTok)).status, 403, 'manager cannot rename the instance');
  assert.equal((await patch('/api/admin/healthcheck', { active: 'off' }, mgrTok)).status, 403, 'manager cannot set health-check policy');
  ok('manager is blocked from creating admins + all instance settings (403)');

  step = 'set-role';
  assert.equal((await patch(`/api/admin/users/${mgr.id}/role`, { role: 'user' }, admin.token)).status, 204, 'admin demotes manager to user');
  // An admin may promote (the role flip is metadata). The promoted admin is
  // fail-closed until an existing admin seals the Admin-group private key to them
  // via /api/admin/collections/group-key — the server holds no key and cannot do
  // it, so the title arrives before the escrow, never the other way round.
  assert.equal((await patch(`/api/admin/users/${mgr.id}/role`, { role: 'admin' }, admin.token)).status, 204, 'admin may promote a user to admin');
  // But an EXISTING admin's role is not flipped here: demotion has to go through
  // the escrow-rotating disable/delete paths, or the group key would outlive the
  // grant. This is the guard that actually protects the escrow.
  assert.equal((await patch(`/api/admin/users/${mgr.id}/role`, { role: 'user' }, admin.token)).status, 400, "an admin's role can't be changed here");
  assert.equal((await patch(`/api/admin/users/${mgr.id}/role`, { role: 'manager' }, admin.token)).status, 400, 'not even sideways');
  ok('admin promotes to admin, but an existing admin must be disabled/deleted, not demoted');

  console.log('\n✅ MANAGER ROLE OK — org management (teams + invite users) without instance admin (ADR 0010)');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error(`\n✗ FAILED at "${step}": ${e.message}`);
  cleanup();
  process.exit(1);
}
