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
  assert.equal(
    (await post('/api/admin/users', { ...(await vaultBody('mgr', 'mgrPass123!')), role: 'manager' }, admin)).status,
    201,
  );
  const mgr = (await login('mgr', 'mgrPass123!')).token;
  assert.ok(mgr, 'a manager can sign in');
  ok('server up, with an administrator, a manager and a regular account');

  step = 'manager-reaches-org-and-nothing-else';
  // `/api/admin/*` is admin-only except org management, which a manager may also reach.
  // The guard used to decide that with a bare `starts_with`, so a route named
  // `/api/admin/users-export` would have matched `/api/admin/users` and been handed to
  // managers without anyone choosing that. It compares whole segments now, and this is
  // what holds the line: the three org paths open, every other admin path shut, and a
  // path that merely BEGINS like an org one shut too.
  for (const open of ['/api/admin/users', '/api/admin/teams', '/api/admin/enrollment-tokens']) {
    assert.notEqual((await get(open, mgr)).status, 403, `a manager may reach ${open}`);
  }
  for (const shut of ['/api/admin/collections', '/api/admin/group-keys']) {
    assert.equal((await get(shut, mgr)).status, 403, `a manager may not reach ${shut}`);
  }
  assert.equal(
    (await patch('/api/admin/instance', { name: 'nope' }, mgr)).status,
    403,
    'nor write an instance setting',
  );
  // The prefix trap itself: no such route exists, so 403 (the guard refusing) is the
  // answer that proves the guard looked, and 404 would mean it waved the request through
  // to the router. Either beats the old 405-or-whatever a manager would have got.
  assert.equal(
    (await get('/api/admin/users-export', mgr)).status,
    403,
    'a path that only begins like an org path is not an org path',
  );
  ok('a manager reaches org management and is refused everything else under /api/admin');

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
  // The host-key policy used to be the example here, as an instance default with no route
  // of its own. It has one now (and its own group below), so it answers 409 like its
  // neighbours — the refusal has to be specific rather than a blanket no to the table, so
  // a key that is NOT an instance policy still goes through.
  assert.equal((await put('/api/settings/host_key_verification_mode', { value: 'warn' }, admin)).status, 409,
    'a policy with a validated route is refused here too');
  assert.equal((await mode(admin)).hostKeyVerification, 'strict', 'and the refusal changed nothing');
  assert.equal((await put('/api/settings/clipboard_clear_timeout', { value: '45' }, admin)).status, 204,
    'a key that is nobody else\'s business is still an admin\'s to write');
  ok('the generic route is no way around a validated route or the configuration lock');

  step = 'local-terminal-runs-the-instance-shell';
  await patch('/api/admin/default-shell', { shell: 'sh' }, admin);
  const local = await post('/api/terminal/local', { shell: '/usr/bin/env' }, pleb);
  assert.equal(local.status, 200, 'a regular account still gets a terminal');
  const used = (await local.json()).shell;
  assert.match(used, /\/sh$/, `the session runs the instance's shell, not the caller's (got ${used})`);
  ok('the caller does not choose which program the server spawns');

  // An instance may now DELEGATE the choice. What it delegates is a name from its own
  // list, and nothing else — so this walks the three ways a caller can try to widen it,
  // and then the withdrawal. The withdrawal is asserted here rather than through the UI
  // because the UI stops sending a name at all: that tests the client, and the question
  // is what the server does with a name it is still sent.
  step = 'a-delegated-shell-choice-is-still-the-instance-s-list';
  const offered = (await mode(admin)).shells;
  assert.ok(Array.isArray(offered) && offered.includes('sh'), `the instance reports its shells (got ${JSON.stringify(offered)})`);
  const otherShell = offered.find((name) => name !== 'sh');
  assert.ok(otherShell, 'this machine has a second shell to ask for');

  assert.equal((await post('/api/terminal/local', { shell: otherShell }, pleb)).status, 200);
  assert.match((await (await post('/api/terminal/local', { shell: otherShell }, pleb)).json()).shell, /\/sh$/,
    'a name is ignored while the instance keeps the choice');

  await patch('/api/admin/shell-choice', { enabled: true }, admin);
  const picked = (await (await post('/api/terminal/local', { shell: otherShell }, pleb)).json()).shell;
  assert.match(picked, new RegExp(`/${otherShell}$`), `a delegated choice is honoured (got ${picked})`);
  for (const forged of [`/usr/bin/${otherShell}`, '/usr/bin/env', 'python3', '../bin/sh']) {
    const got = (await (await post('/api/terminal/local', { shell: forged }, pleb)).json()).shell;
    assert.match(got, /\/sh$/, `"${forged}" is not a shell this instance offered (got ${got})`);
  }

  await patch('/api/admin/shell-choice', { enabled: false }, admin);
  const withdrawn = (await (await post('/api/terminal/local', { shell: otherShell }, pleb)).json()).shell;
  assert.match(withdrawn, /\/sh$/, `a withdrawn choice stops being honoured (got ${withdrawn})`);
  ok('a delegated shell is a name off the instance list, and the instance can take it back');

  // A probe, not a known hole: the local-vault routes (ADR 0018) belong to a person's own
  // machine, and a shared server has no such vault. They are reachable by any session in
  // accounts mode, so what they answer there decides whether the reveal route added for a
  // local vault became a way to read someone's secrets on a server.
  // The host-key policy had no validated route at all: the only way to set it on a server
  // was the generic settings table, which is where the hole this check exists for was.
  step = 'the-host-key-policy-has-a-route-of-its-own';
  assert.equal((await patch('/api/admin/host-key-mode', { mode: 'warn' }, admin)).status, 204);
  assert.equal((await mode(admin)).hostKeyVerification, 'warn', 'an admin sets it through its own route');
  assert.equal((await patch('/api/admin/host-key-mode', { mode: 'trust-me' }, admin)).status, 400,
    'a value outside the three is refused rather than stored');
  assert.equal((await mode(admin)).hostKeyVerification, 'warn', 'and the refusal changed nothing');
  assert.equal((await patch('/api/admin/host-key-mode', { mode: 'accept' }, pleb)).status, 403,
    'a regular account cannot reach it, route or no route');
  await patch('/api/admin/host-key-mode', { mode: 'strict' }, admin);
  assert.equal((await mode(admin)).hostKeyVerification, 'strict');
  ok('the host-key policy is set through a validated admin route, by an admin');

  step = 'local-vault-routes-serve-nothing-on-a-shared-server';
  for (const [label, res] of [
    ['list collections', await get('/api/local/collections', pleb)],
    ['list machines', await get('/api/local/collections/any/machines', pleb)],
    ['reveal a secret', await get('/api/local/collections/any/machines/any/secret', pleb)],
  ]) {
    // 410, not merely "not 200": these answered 500 before, which is a refusal held up by
    // the vault having no key rather than by the server knowing what it is.
    assert.equal(res.status, 410, `${label} must be refused as not-here (got ${res.status})`);
    const body = await res.text();
    for (const leak of ['password', 'passphrase', 'PRIVATE KEY']) {
      assert.ok(!body.includes(leak), `${label} answered with "${leak}" in it: ${body.slice(0, 200)}`);
    }
  }
  ok('the local-vault routes hand nothing to a session on a shared server');

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

  step = 'a-key-path-is-not-read-off-the-server';
  // ADR 0028 §4. A path here names a file in the server's own container: a member cannot
  // put one there, and a file an administrator does put there authenticates EVERY account
  // that can read the record. So the refusal is in the handler, not in the form — and it
  // is asserted with the Quick SSH policy ON, or a 403 from that policy would look like
  // this guard working while it does nothing.
  await patch('/api/admin/quick-ssh', { enabled: true }, admin);
  const withPath = { host: '127.0.0.1', port: 65001, username: 'x', authMethod: { type: 'publicKey', keyPath: '/etc/ssh/ssh_host_ed25519_key' } };
  const refusedPath = await post('/api/terminal/quick-ssh', withPath, pleb);
  assert.equal(refusedPath.status, 400, `a key path must be refused, got ${refusedPath.status}`);
  const why = await refusedPath.text();
  assert.match(why, /desktop client/, `the refusal names what would work: ${why}`);
  // A carried key reaches the transport instead: it is refused by SSH, not by this guard.
  const carried = { ...withPath, authMethod: { type: 'vaultKey', key: 'not a key' } };
  assert.notEqual((await post('/api/terminal/quick-ssh', carried, pleb)).status, 400,
    'a carried key is not caught by the path guard');
  // The hop chain authenticates like any other target, so it is refused like one.
  const viaHop = { ...withPath, authMethod: { type: 'vaultKey', key: 'not a key' },
    jumps: [{ host: '127.0.0.1', port: 65002, username: 'x', authMethod: { type: 'publicKey', keyPath: '/etc/passwd' } }] };
  assert.equal((await post('/api/terminal/quick-ssh', viaHop, pleb)).status, 400,
    'a jump host with a path is refused too');
  // The other two routes that take one.
  assert.equal((await post('/api/terminal/exec-quick', { ...withPath, command: 'echo hi' }, pleb)).status, 400,
    'and exec-quick refuses it');
  assert.equal((await post('/api/forwards/quick', { ...withPath, connectionId: 'x', localPort: 65003, remoteHost: '127.0.0.1', remotePort: 22 }, pleb)).status, 400,
    'and so does the port-forward route');
  await patch('/api/admin/quick-ssh', { enabled: false }, admin);
  ok('a key path is refused by the server in accounts mode, on every route that takes one');

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
