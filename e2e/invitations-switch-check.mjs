// Invitations master-switch + confirm-role-change smoke (mock "Allow invitations" / "Confirm role
// changes" instance settings). Proves the server-side enforcement of the invitation master switch:
// with it off, minting AND redeeming (even a token minted while it was on) are refused; flipping it
// back on restores both. Also: the switches surface in server_mode, only an admin may flip them,
// and confirm_role_change round-trips (a client UX policy, no server enforcement).
// Self-contained: spawns one accounts server.  node e2e/invitations-switch-check.mjs
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

const PORT = 18461;
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
const patch = (path, body, token) =>
  fetch(BASE + path, { method: 'PATCH', headers: { 'content-type': 'application/json', ...H(token) }, body: JSON.stringify(body ?? {}) });
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
const mode = async () => (await get('/api/server/mode')).json();
const mint = (token, role = 'user') => post('/api/admin/enrollment-tokens', { role }, token);

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
  home = mkdtempSync(join(tmpdir(), 'rite-inv-'));
  proc = spawn(BIN, [], {
    env: { ...process.env, HOME: home, RITE_WEB_DIR: WEB, RUST_LOG: 'warn', RITE_ADDR: `127.0.0.1:${PORT}`, RITE_ACCOUNTS: '1', RITE_ADMIN_USER: 'envadmin', RITE_ADMIN_PASSWORD: 'EnvPass123!' },
    stdio: 'ignore',
  });
  await up();
  const admin = (await login('envadmin', 'EnvPass123!')).token;
  assert.ok(admin, 'admin logged in');
  // Defaults: invitations ON (the invite path works out of the box), confirm-role OFF.
  const m0 = await mode();
  assert.equal(m0.allowInvitations, true, 'allowInvitations defaults on');
  assert.equal(m0.confirmRoleChange, false, 'confirmRoleChange defaults off');
  ok('server up; defaults are invitations=on, confirm-role=off');

  step = 'pre-mint';
  // Mint a valid token WHILE invitations are on, to prove the switch later closes redemption too.
  const pre = await (await mint(admin)).json();
  assert.ok(pre.token?.startsWith('rite_'), 'a token minted while on');
  ok('minted a still-valid token while invitations are on');

  step = 'disable';
  assert.equal((await patch('/api/admin/invitations', { enabled: false }, admin)).status, 204, 'disable returns 204');
  assert.equal((await mode()).allowInvitations, false, 'server_mode now reports invitations off');
  ok('admin turned invitations off (surfaces in server_mode)');

  step = 'enforce-off';
  assert.equal((await mint(admin)).status, 403, 'minting is refused while off');
  assert.equal((await register('mallory', 'MalloryPass1!', pre.token)).status, 403, 'redeeming a pre-minted token is refused while off');
  ok('with invitations off, both minting and redeeming are refused (403) — server-enforced');

  step = 'reenable';
  assert.equal((await patch('/api/admin/invitations', { enabled: true }, admin)).status, 204, 're-enable returns 204');
  assert.equal((await mint(admin)).status, 201, 'minting works again once on');
  const fresh = await (await mint(admin)).json();
  assert.equal((await register('nina', 'NinaPass1234!', fresh.token)).status, 201, 'redeeming works again once on');
  ok('re-enabling restores minting and redeeming');

  step = 'admin-only';
  // A manager may mint user tokens but must NOT flip the instance switch (it lives under /api/admin,
  // not /api/admin/{users,teams,enrollment-tokens}) — admin-only, like the other instance settings.
  const mgr = await (await post('/api/admin/users', { ...(await vaultBody('mgr', 'MgrPass1234!')), role: 'manager' }, admin)).json();
  assert.ok(mgr.id, 'admin created a manager');
  const mgrTok = (await login('mgr', 'MgrPass1234!')).token;
  assert.equal((await patch('/api/admin/invitations', { enabled: false }, mgrTok)).status, 403, 'a manager cannot flip the invitations switch');
  assert.equal((await patch('/api/admin/confirm-role-change', { enabled: true }, mgrTok)).status, 403, 'a manager cannot flip confirm-role-change');
  assert.equal((await mode()).allowInvitations, true, 'the switch is unchanged after the manager attempts');
  ok('only an admin may flip the instance switches (manager gets 403)');

  step = 'confirm-role';
  assert.equal((await patch('/api/admin/confirm-role-change', { enabled: true }, admin)).status, 204, 'set confirm-role on');
  assert.equal((await mode()).confirmRoleChange, true, 'server_mode reports confirm-role on');
  assert.equal((await patch('/api/admin/confirm-role-change', { enabled: false }, admin)).status, 204, 'set confirm-role off');
  assert.equal((await mode()).confirmRoleChange, false, 'server_mode reports confirm-role off');
  ok('confirm-role-change round-trips through server_mode (client UX policy)');

  console.log('\n✅ INVITATIONS SWITCH OK — master switch enforced on mint + redeem, admin-only, confirm-role round-trips');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error(`\n✗ FAILED at "${step}": ${e.message}`);
  cleanup();
  process.exit(1);
}
