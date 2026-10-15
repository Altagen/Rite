// What a regular account may NOT do on a shared server.
//
// Four holes, found by reading the router against the guard. The guard only ever checked
// the admin role for `/api/admin/*`, and four routes outside it were doing instance-level
// work:
//
//   * `/api/settings/{key}` wrote any key in the server's settings table — the INSTANCE's
//     table, one row per key, no owner column. `rite-core` reads
//     `host_key_verification_mode` from it for every connection it opens, so a regular
//     account could turn host-key verification off for everyone. It also bypassed the
//     validation and the ADR 0020 configuration lock of the admin routes.
//   * `/api/terminal/local` ran the program the caller named, if the path existed in the
//     container: a PTY on anything, for any account, whatever shell the admin had chosen.
//   * `/api/terminal/quick-ssh` never consulted `allow_quick_ssh`, so the policy existed
//     only as a hidden button. The same route also opens a SAVED connection (the browser
//     decrypts the target, ADR 0011) — which is why it was missed, and why the refusal
//     has to let a proven collection item through.
//   * `/api/shells` answered for any path the caller sent — an existence oracle.
//
// Self-contained: own port, own HOME, own throwaway admin.  node e2e/server-authz-check.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const H = (t) => (t ? { authorization: `Bearer ${t}` } : {});
const get = (path, t) => fetch(BASE + path, { headers: H(t) });
const post = (path, body, t) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...H(t) }, body: JSON.stringify(body ?? {}) });
const put = (path, body, t) =>
  fetch(BASE + path, { method: 'PUT', headers: { 'content-type': 'application/json', ...H(t) }, body: JSON.stringify(body ?? {}) });
const patch = (path, body, t) =>
  fetch(BASE + path, { method: 'PATCH', headers: { 'content-type': 'application/json', ...H(t) }, body: JSON.stringify(body ?? {}) });

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
async function login(username, password) {
  const pre = await (await post('/api/server/prelogin', { username })).json();
  return (await post('/api/server/login', { username, authHash: await argon(password, pre.salt) })).json();
}
const mode = async (t) => (await get('/api/server/mode', t)).json();

let proc, home;
function cleanup() {
  try { proc?.kill('SIGKILL'); } catch { /* gone */ }
  try { rmSync(home, { recursive: true, force: true }); } catch { /* gone */ }
}
process.on('exit', cleanup);

const ok = (m) => console.log('  ✓ ' + m);
let step = '';
try {
  step = 'boot';
  home = mkdtempSync(join(tmpdir(), 'rite-authz-'));
  // One declared key, so the configuration lock has something to defend (ADR 0020).
  const cfg = join(home, 'rite.toml');
  writeFileSync(cfg, 'open_registration = false\n');
  proc = spawn(BIN, [], {
    env: { ...process.env, HOME: home, RITE_WEB_DIR: WEB, RUST_LOG: 'error', RITE_ADDR: `127.0.0.1:${PORT}`,
           RITE_ACCOUNTS: '1', RITE_CONFIG: cfg, RITE_ADMIN_USER: 'root', RITE_ADMIN_PASSWORD: 'RootPass123!' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await get('/api/server/mode')).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const admin = (await login('root', 'RootPass123!')).token;
  assert.ok(admin, 'the administrator can sign in');
  assert.equal((await post('/api/admin/users', { ...(await vaultBody('pleb', 'plebPass1!')), role: 'user' }, admin)).status, 201);
  const pleb = (await login('pleb', 'plebPass1!')).token;
  assert.ok(pleb, 'a regular account can sign in');
  ok('server up, with an administrator and a regular account');

  step = 'settings-table-is-the-instance';
  assert.equal((await put('/api/settings/host_key_verification_mode', { value: 'accept' }, pleb)).status, 403,
    'a regular account cannot write the instance settings table');
  assert.equal((await get('/api/settings', pleb)).status, 403, 'nor read the whole table');
  assert.equal((await get('/api/settings/host_key_verification_mode', pleb)).status, 403, 'nor read one key of it');
  assert.equal((await mode(pleb)).hostKeyVerification, 'strict', 'host-key verification is untouched');
  ok('host-key verification cannot be switched off by an account that is not an admin');

  step = 'settings-route-does-not-outrank-the-admin-routes';
  assert.equal((await put('/api/settings/default_shell', { value: '/usr/bin/env' }, admin)).status, 409,
    'a key with a validated admin route is refused here, even for an admin');
  assert.equal((await patch('/api/admin/default-shell', { shell: '/usr/bin/env' }, admin)).status, 400,
    'and that route still refuses a path');
  assert.equal((await put('/api/settings/open_registration', { value: '1' }, admin)).status, 409, 'likewise a declared key');
  assert.equal((await mode(admin)).defaultShell, 'bash', 'so the shell is still the default');
  assert.equal((await mode(admin)).openRegistration, false, 'and the file still owns registration');
  // What an admin may still do: an instance default with no route of its own.
  assert.equal((await put('/api/settings/host_key_verification_mode', { value: 'warn' }, admin)).status, 204);
  assert.equal((await mode(admin)).hostKeyVerification, 'warn', 'an admin sets the instance default');
  await put('/api/settings/host_key_verification_mode', { value: 'strict' }, admin);
  ok('the generic route is no way around a validated route or the configuration lock');

  step = 'local-terminal-runs-the-instance-shell';
  await patch('/api/admin/default-shell', { shell: 'sh' }, admin);
  const local = await post('/api/terminal/local', { shell: '/usr/bin/env' }, pleb);
  assert.equal(local.status, 200, 'a regular account still gets a terminal');
  const used = (await local.json()).shell;
  assert.match(used, /\/sh$/, `the session runs the instance's shell, not the caller's (got ${used})`);
  ok('the caller does not choose which program the server spawns');

  step = 'quick-ssh-policy';
  assert.equal((await mode(admin)).allowQuickSsh, false, 'ad-hoc Quick SSH is off by default');
  const adhoc = { host: '127.0.0.1', port: 65001, username: 'x', authMethod: { type: 'password', password: 'x' } };
  assert.equal((await post('/api/terminal/quick-ssh', adhoc, pleb)).status, 403, 'an ad-hoc target is refused');
  assert.equal(
    (await post('/api/terminal/quick-ssh', { ...adhoc, collectionId: 'not-mine', itemId: 'nope' }, pleb)).status, 403,
    'and naming a collection one is not a member of is not a way in');
  await patch('/api/admin/quick-ssh', { enabled: true }, admin);
  const allowed = await post('/api/terminal/quick-ssh', adhoc, pleb);
  assert.notEqual(allowed.status, 403, 'with the policy on, the refusal is gone (the connection itself fails)');
  await patch('/api/admin/quick-ssh', { enabled: false }, admin);
  ok('`allow_quick_ssh` is a refusal from the server, not a hidden button');

  step = 'shells-is-not-an-oracle';
  const probe = await (await post('/api/shells', { shells: ['/etc/shadow', '/etc/passwd', '/bin/sh'] }, pleb)).json();
  assert.deepEqual(probe, ['/bin/sh'], `only shells are answered for (got ${JSON.stringify(probe)})`);
  ok('/api/shells answers for shells, not for whatever path was sent');

  console.log('\nserver-authz-check: PASS');
} catch (e) {
  console.error(`\nserver-authz-check: FAIL at ${step}\n`, e.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
