// RBAC hierarchy smoke (owner rule). Proves each caller manages only accounts strictly BELOW their
// level: an admin promotes a user all the way to admin and can still offboard an admin (disable +
// delete); a manager manages regular users only and is 403 on every action against a peer manager or
// an admin, and cannot assign a role at/above manager. Self-contained.  node e2e/rbac-hierarchy-check.mjs
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

const PORT = 18458;
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
const H = (t) => (t ? { authorization: `Bearer ${t}` } : {});
const post = (path, body, t) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...H(t) }, body: JSON.stringify(body ?? {}) });
const patch = (path, body, t) =>
  fetch(BASE + path, { method: 'PATCH', headers: { 'content-type': 'application/json', ...H(t) }, body: JSON.stringify(body ?? {}) });
const del = (path, t) => fetch(BASE + path, { method: 'DELETE', headers: H(t) });

async function vaultBody(username, password) {
  const authSalt = bh(sodium.randombytes_buf(16));
  const masterSalt = bh(sodium.randombytes_buf(16));
  const masterKey = hx(await argon(password, masterSalt));
  const userKey = sodium.randombytes_buf(32);
  const kp = sodium.crypto_box_keypair();
  return {
    username,
    salt: authSalt,
    params: KDF,
    authHash: await argon(password, authSalt),
    masterSalt,
    protectedUserKey: await aes(masterKey, userKey),
    publicKey: bh(kp.publicKey),
    protectedPrivateKey: await aes(userKey, kp.privateKey),
  };
}
const createUser = async (adminTok, username, role) => {
  const body = await vaultBody(username, username + 'Pass1!');
  return (await post('/api/admin/users', { ...body, role }, adminTok)).json();
};
async function login(username, password) {
  const pre = await (await post('/api/server/prelogin', { username })).json();
  return (await post('/api/server/login', { username, authHash: await argon(password, pre.salt) })).json();
}
const listUsers = async (t) => (await (await fetch(BASE + '/api/admin/users', { headers: H(t) })).json());
const roleOf = async (t, id) => (await listUsers(t)).find((u) => u.id === id)?.role;

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
  home = mkdtempSync(join(tmpdir(), 'rite-rbac-'));
  proc = spawn(BIN, [], {
    env: { ...process.env, HOME: home, RITE_WEB_DIR: WEB, RUST_LOG: 'warn', RITE_ADDR: `127.0.0.1:${PORT}`, RITE_ACCOUNTS: '1', RITE_ADMIN_USER: 'root', RITE_ADMIN_PASSWORD: 'RootPass123!' },
    stdio: 'ignore',
  });
  await up();
  const admin = (await login('root', 'RootPass123!')).token;
  const mgr1 = await createUser(admin, 'mgr1', 'manager');
  const mgr2 = await createUser(admin, 'mgr2', 'manager');
  const bob = await createUser(admin, 'bob', 'user');
  const carol = await createUser(admin, 'carol', 'user');
  assert.ok(admin && mgr1.id && mgr2.id && bob.id && carol.id, 'admin + fixtures created');
  const mgrTok = (await login('mgr1', 'mgr1Pass1!')).token;
  ok('server up; admin + two managers + two users created');

  step = 'promote-to-admin';
  assert.equal((await patch(`/api/admin/users/${bob.id}/role`, { role: 'manager' }, admin)).status, 204, 'user → manager');
  assert.equal((await patch(`/api/admin/users/${bob.id}/role`, { role: 'admin' }, admin)).status, 204, 'manager → admin');
  assert.equal(await roleOf(admin, bob.id), 'admin', 'bob is now admin');
  ok('an admin can promote a user all the way to admin');

  step = 'admin-role-is-fixed';
  assert.equal((await patch(`/api/admin/users/${bob.id}/role`, { role: 'manager' }, admin)).status, 400, 'admin role not flipped here');
  ok("an existing admin's role can't be flipped via set-role (offboard via disable/delete)");

  step = 'manager-blocked-on-peers-and-admins';
  assert.equal((await patch(`/api/admin/users/${carol.id}/role`, { role: 'manager' }, mgrTok)).status, 403, 'manager cannot assign a peer role');
  assert.equal((await patch(`/api/admin/users/${mgr2.id}/role`, { role: 'user' }, mgrTok)).status, 403, 'manager cannot change a peer manager');
  assert.equal((await patch(`/api/admin/users/${mgr2.id}/status`, { status: 'disabled' }, mgrTok)).status, 403, 'manager cannot disable a peer');
  assert.equal((await del(`/api/admin/users/${mgr2.id}`, mgrTok)).status, 403, 'manager cannot delete a peer');
  assert.equal((await post(`/api/admin/users/${mgr2.id}/reset`, await vaultBody('mgr2', 'x'), mgrTok)).status, 403, 'manager cannot reset a peer');
  assert.equal((await patch(`/api/admin/users/${bob.id}/status`, { status: 'disabled' }, mgrTok)).status, 403, 'manager cannot disable an admin');
  ok('a manager is 403 on every action against a peer manager or an admin');

  step = 'manager-can-manage-users';
  assert.equal((await patch(`/api/admin/users/${carol.id}/status`, { status: 'disabled' }, mgrTok)).status, 204, 'manager disables a user');
  assert.equal((await del(`/api/admin/users/${carol.id}`, mgrTok)).status, 204, 'manager deletes a user');
  ok('a manager can still manage regular users (disable + delete)');

  step = 'admin-offboards-admin';
  assert.equal((await patch(`/api/admin/users/${bob.id}/status`, { status: 'disabled' }, admin)).status, 204, 'admin disables an admin');
  assert.equal((await del(`/api/admin/users/${bob.id}`, admin)).status, 204, 'admin deletes an admin');
  ok('an admin can still offboard another admin (disable + delete)');

  console.log('\n✅ RBAC HIERARCHY OK — manage strictly below your level; admins promote up to admin + self-govern');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error(`\n✗ FAILED at "${step}": ${e.message}`);
  cleanup();
  process.exit(1);
}
