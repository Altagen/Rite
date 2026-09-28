// Enrollment token smoke (ADR 0015 phase 3). Proves the invitation-token flow: an admin mints a
// single-use token encoding a role + team; redeeming it self-registers the holder with the recipe
// applied (role + team membership); the token is single-use, revocable, bypasses open_registration;
// an admin can mint a manager token but never an admin one; a manager can mint only user tokens.
// Self-contained: spawns one accounts server.  node e2e/enrollment-token-check.mjs
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

const PORT = 18457;
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
const H = (token) => (token ? { authorization: `Bearer ${token}` } : {});
const post = (path, body, token) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...H(token) }, body: JSON.stringify(body ?? {}) });
const del = (path, token) => fetch(BASE + path, { method: 'DELETE', headers: H(token) });
const get = (path, token) => fetch(BASE + path, { headers: H(token) });

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
const register = async (username, password, token) =>
  post('/api/server/register', { ...(await vaultBody(username, password)), ...(token ? { token } : {}) });
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
  home = mkdtempSync(join(tmpdir(), 'rite-tok-'));
  proc = spawn(BIN, [], {
    env: { ...process.env, HOME: home, RITE_WEB_DIR: WEB, RUST_LOG: 'warn', RITE_ADDR: `127.0.0.1:${PORT}`, RITE_ACCOUNTS: '1', RITE_ADMIN_USER: 'envadmin', RITE_ADMIN_PASSWORD: 'EnvPass123!' },
    stdio: 'ignore',
  });
  await up();
  const admin = (await login('envadmin', 'EnvPass123!')).token;
  assert.ok(admin, 'admin logged in');
  // open registration stays OFF the whole test — tokens must work regardless.
  const team = await (await post('/api/admin/teams', { name: 'Platform' }, admin)).json();
  assert.ok(team.id, 'admin created a team');
  ok('server up; admin logged in; team created (open registration stays off)');

  step = 'mint';
  const minted = await post('/api/admin/enrollment-tokens', { role: 'user', teams: [{ teamId: team.id, teamRole: 'member' }], expiresInSecs: 3600 }, admin);
  assert.equal(minted.status, 201, 'mint returns 201');
  const { token, info } = await minted.json();
  assert.ok(token.startsWith('rite_'), 'plaintext token returned once');
  assert.equal(info.prefix, token.slice(0, 9), 'stored prefix matches the token');
  assert.equal(info.role, 'user', 'token role is user');
  assert.equal(info.consumedAt, null, 'token starts unconsumed');
  const list = await (await get('/api/admin/enrollment-tokens', admin)).json();
  assert.ok(list.some((t) => t.id === info.id), 'token appears in the admin list');
  ok('admin minted a user+team token (shown once, listed, hashed at rest)');

  step = 'redeem';
  const red = await register('alice', 'AlicePass123!', token);
  assert.equal(red.status, 201, 'redeem creates the account');
  assert.equal((await red.json()).user.role, 'user', 'redeemed account has the recipe role');
  const aliceTok = (await login('alice', 'AlicePass123!')).token;
  const aliceTeams = await (await get('/api/teams', aliceTok)).json();
  assert.ok(aliceTeams.some((t) => t.id === team.id), 'redeemer joined the recipe team');
  ok('redeeming self-registered the holder with the role + team applied');

  step = 'single-use';
  assert.equal((await register('bob', 'BobPass1234!', token)).status, 403, 'a used token is refused');
  assert.equal((await register('bob', 'BobPass1234!', 'rite_deadbeefdeadbeef')).status, 403, 'an unknown token is refused');
  ok('tokens are single-use; unknown tokens rejected (403)');

  step = 'revoke';
  const t2 = await (await post('/api/admin/enrollment-tokens', { role: 'user' }, admin)).json();
  assert.equal((await del(`/api/admin/enrollment-tokens/${t2.info.id}`, admin)).status, 204, 'revoke returns 204');
  assert.equal((await register('carol', 'CarolPass12!', t2.token)).status, 403, 'a revoked token is refused');
  ok('a revoked token can no longer be redeemed (403)');

  step = 'role-recipe';
  const t3 = await (await post('/api/admin/enrollment-tokens', { role: 'manager' }, admin)).json();
  const red3 = await register('dave', 'DavePass123!', t3.token);
  assert.equal((await red3.json()).user.role, 'manager', 'admin can mint a manager token');
  assert.equal((await post('/api/admin/enrollment-tokens', { role: 'admin' }, admin)).status, 400, 'admin tokens are refused');
  ok('admin mints user/manager tokens but never admin');

  step = 'manager-limits';
  const mgr = await (await post('/api/admin/users', { ...(await vaultBody('mgr', 'MgrPass1234!')), role: 'manager' }, admin)).json();
  const mgrTok = (await login('mgr', 'MgrPass1234!')).token;
  assert.equal((await post('/api/admin/enrollment-tokens', { role: 'user' }, mgrTok)).status, 201, 'manager mints a user token');
  assert.equal((await post('/api/admin/enrollment-tokens', { role: 'manager' }, mgrTok)).status, 403, 'manager cannot mint a manager token');
  ok('a manager may mint user tokens only (403 on manager tokens)');

  console.log('\n✅ ENROLLMENT TOKENS OK — single-use recipe invites, role+team applied, admin/manager scoped (ADR 0015 phase 3)');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error(`\n✗ FAILED at "${step}": ${e.message}`);
  cleanup();
  process.exit(1);
}
