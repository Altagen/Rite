// Enrollment-token RBAC scoping (ADR 0015 + owner rule). Proves a manager only sees/revokes tokens
// it could itself mint (user-role), and can only put team grants for teams it administers; an admin
// sees/manages everything and may grant any team; a past/zero expiry and an unknown team are refused.
// Self-contained.  node e2e/enrollment-scoping-check.mjs
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

const PORT = 18459;
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
const del = (path, t) => fetch(BASE + path, { method: 'DELETE', headers: H(t) });
const get = (path, t) => fetch(BASE + path, { headers: H(t) });

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
const createUser = async (adm, username, role) =>
  (await post('/api/admin/users', { ...(await vaultBody(username, username + 'Pass1!')), role }, adm)).json();
const mint = (body, t) => post('/api/admin/enrollment-tokens', body, t);
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
  home = mkdtempSync(join(tmpdir(), 'rite-tsc-'));
  proc = spawn(BIN, [], {
    env: { ...process.env, HOME: home, RITE_WEB_DIR: WEB, RUST_LOG: 'warn', RITE_ADDR: `127.0.0.1:${PORT}`, RITE_ACCOUNTS: '1', RITE_ADMIN_USER: 'root', RITE_ADMIN_PASSWORD: 'RootPass123!' },
    stdio: 'ignore',
  });
  await up();
  const admin = (await login('root', 'RootPass123!')).token;
  const mgr = await createUser(admin, 'mgr', 'manager');
  const teamA = await (await post('/api/admin/teams', { name: 'Team A' }, admin)).json(); // mgr will admin this
  const teamB = await (await post('/api/admin/teams', { name: 'Team B' }, admin)).json(); // mgr not a member
  assert.equal((await post(`/api/teams/${teamA.id}/members`, { userId: mgr.id, role: 'admin' }, admin)).status, 204, 'mgr made team-admin of A');
  const mgrTok = (await login('mgr', 'mgrPass1!')).token;
  ok('server up; a manager who team-admins Team A but not Team B');

  step = 'list-scoping';
  const adminMgrTok = await (await mint({ role: 'manager' }, admin)).json(); // an admin-only token
  const mgrUserTok = await (await mint({ role: 'user' }, mgrTok)).json();
  const adminList = await (await get('/api/admin/enrollment-tokens', admin)).json();
  const mgrList = await (await get('/api/admin/enrollment-tokens', mgrTok)).json();
  assert.ok(adminList.some((t) => t.id === adminMgrTok.info.id), 'admin sees the manager token');
  assert.ok(!mgrList.some((t) => t.id === adminMgrTok.info.id), 'manager does NOT see the manager token');
  assert.ok(mgrList.some((t) => t.id === mgrUserTok.info.id) && mgrList.every((t) => t.role === 'user'), 'manager sees only user tokens');
  ok('a manager lists only user-role tokens; an admin sees all');

  step = 'revoke-scoping';
  assert.equal((await del(`/api/admin/enrollment-tokens/${adminMgrTok.info.id}`, mgrTok)).status, 403, 'manager cannot revoke a manager token');
  assert.equal((await del(`/api/admin/enrollment-tokens/${mgrUserTok.info.id}`, mgrTok)).status, 204, 'manager revokes its own user token');
  ok('a manager can only revoke user-role tokens (403 on a manager token)');

  step = 'team-grant-auth';
  assert.equal((await mint({ role: 'user', teams: [{ teamId: teamB.id, teamRole: 'member' }] }, mgrTok)).status, 403, 'manager cannot grant a team it does not administer');
  assert.equal((await mint({ role: 'user', teams: [{ teamId: teamA.id, teamRole: 'admin' }] }, mgrTok)).status, 201, 'manager grants a team it administers');
  assert.equal((await mint({ role: 'user', teams: [{ teamId: teamB.id, teamRole: 'member' }] }, admin)).status, 201, 'an admin may grant any team');
  assert.equal((await mint({ role: 'user', teams: [{ teamId: 'nope', teamRole: 'member' }] }, admin)).status, 400, 'an unknown team is rejected');
  ok('team grants are authorized against the minter (unknown team → 400)');

  step = 'expiry-validation';
  assert.equal((await mint({ role: 'user', expiresInSecs: -5 }, admin)).status, 400, 'a past expiry is rejected');
  assert.equal((await mint({ role: 'user', expiresInSecs: 0 }, admin)).status, 400, 'a zero expiry is rejected');
  assert.equal((await mint({ role: 'user', expiresInSecs: 3600 }, admin)).status, 201, 'a future expiry is accepted');
  ok('a past/zero expiry is refused (400); a future one is accepted');

  console.log('\n✅ ENROLLMENT SCOPING OK — managers manage only user tokens + teams they admin; expiry validated');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error(`\n✗ FAILED at "${step}": ${e.message}`);
  cleanup();
  process.exit(1);
}
