// Smoke check for the active health-check probe endpoint (ADR 0017 active phase). Proves the
// server-side probe engine + its guardrails end-to-end: probing is refused while the policy is
// off; once the admin turns it on-demand it returns up/down verdicts for live/dead TCP ports;
// a second immediate request is rate-limited (429); a restrict-users allowlist that excludes the
// caller is refused (403); ssh-handshake confirms a real SSH banner; and a method outside the
// policy allowlist comes back "unsupported" rather than probing. Run: node e2e/healthcheck-check.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import net from 'node:net';
const require = createRequire(new URL('/home/ange/Dev/projects/Rite/apps/desktop/index.html', import.meta.url));
const { argon2id } = require('hash-wasm');
const sodium = require('libsodium-wrappers'); await sodium.ready;

const BASE = `http://127.0.0.1:${process.env.RITE_SMOKE_PORT ?? '1422'}`;
const KDF = { mem: 19456, iter: 2, par: 1 };
const hx = (h) => new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const bh = (b) => Buffer.from(b).toString('hex');
const argon = (password, saltHex) => argon2id({ password, salt: hx(saltHex), parallelism: KDF.par, iterations: KDF.iter, memorySize: KDF.mem, hashLength: 32, outputType: 'hex' });
async function aes(k, p) { const iv = crypto.getRandomValues(new Uint8Array(12)); const key = await crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt']); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, p)); const u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); return `v1.${u(iv)}.${u(ct)}`; }
async function post(path, body, token) { return fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) }); }
async function patch(path, body, token) { return fetch(BASE + path, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) }); }
const getJson = (path, token) => fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then((r) => r.json());
async function vaultFor(password) {
  const authSalt = bh(sodium.randombytes_buf(16));
  const masterSalt = bh(sodium.randombytes_buf(16));
  const masterKey = hx(await argon(password, masterSalt));
  const userKey = sodium.randombytes_buf(32);
  const kp = sodium.crypto_box_keypair();
  return { kp, body: { salt: authSalt, params: KDF, authHash: await argon(password, authSalt), masterSalt, protectedUserKey: await aes(masterKey, userKey), publicKey: bh(kp.publicKey), protectedPrivateKey: await aes(userKey, kp.privateKey) } };
}
// A throwaway TCP listener on a free port. `banner` (if set) is written on connect (to mimic sshd).
function listen(banner) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => { if (banner) sock.write(banner); });
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let step = '';
const ok = (m) => console.log('  ✓ ' + m);
try {
  step = 'setup';
  const av = await vaultFor('AdminPass1!');
  const boot = await (await post('/api/server/bootstrap', { username: 'admin', ...av.body })).json();
  const admin = boot.token;
  const plain = await listen();          // a live TCP port (no banner)
  const ssh = await listen('SSH-2.0-OpenSSH_9.6\r\n'); // a fake sshd
  const dead = await listen(); const deadPort = dead.port; dead.close(); // bind→close: a closed port
  ok('admin bootstrapped; test listeners up');

  step = 'off-by-default';
  const mode0 = await getJson('/api/server/mode');
  assert.equal(mode0.healthcheck.active, 'off', 'active probing off by default');
  const denied = await post('/api/healthcheck/probe', { targets: [{ id: 'a', host: '127.0.0.1', port: plain.port }] }, admin);
  assert.equal(denied.status, 403, 'probe refused while policy is off');
  ok('probing refused while the policy is off (403)');

  step = 'enable';
  assert.equal((await patch('/api/admin/healthcheck', { passiveStatus: true, active: 'on-demand', methods: ['tcp-connect'], restrictUsers: [], minInterval: 60 }, admin)).status, 204, 'policy set');
  ok('admin enabled on-demand probing (tcp-connect)');

  step = 'probe-up-down';
  const res = await (await post('/api/healthcheck/probe', { targets: [
    { id: 'live', host: '127.0.0.1', port: plain.port },
    { id: 'dead', host: '127.0.0.1', port: deadPort },
  ] }, admin)).json();
  const by = Object.fromEntries(res.results.map((r) => [r.id, r]));
  assert.equal(by.live.status, 'up', 'live port reads up');
  assert.ok(typeof by.live.latencyMs === 'number', 'up carries a latency');
  assert.equal(by.dead.status, 'down', 'closed port reads down');
  ok('live port → up (with latency), closed port → down');

  step = 'cooldown';
  const flood = await post('/api/healthcheck/probe', { targets: [{ id: 'x', host: '127.0.0.1', port: plain.port }] }, admin);
  assert.equal(flood.status, 429, 'immediate second probe is rate-limited');
  ok('back-to-back probe rate-limited (429)');

  step = 'restrict-users';
  assert.equal((await patch('/api/admin/healthcheck', { passiveStatus: true, active: 'on-demand', methods: ['tcp-connect', 'ssh-handshake'], restrictUsers: ['nobody'], minInterval: 60 }, admin)).status, 204, 'restrict set');
  const blocked = await post('/api/healthcheck/probe', { targets: [{ id: 'x', host: '127.0.0.1', port: plain.port }] }, admin);
  assert.equal(blocked.status, 403, 'caller not in restrict-users is refused');
  ok('restrict-users allowlist excludes admin → 403');

  step = 'ssh-and-unsupported';
  assert.equal((await patch('/api/admin/healthcheck', { passiveStatus: true, active: 'on-demand', methods: ['tcp-connect', 'ssh-handshake'], restrictUsers: [], minInterval: 60 }, admin)).status, 204, 'reopen');
  await sleep(3100); // wait out the per-user cooldown from the up/down probe
  const res2 = await (await post('/api/healthcheck/probe', { targets: [
    { id: 'ssh', host: '127.0.0.1', port: ssh.port, method: 'ssh-handshake' },
    { id: 'notssh', host: '127.0.0.1', port: plain.port, method: 'ssh-handshake' },
    { id: 'icmp', host: '127.0.0.1', port: plain.port, method: 'icmp' },
  ] }, admin)).json();
  const by2 = Object.fromEntries(res2.results.map((r) => [r.id, r]));
  assert.equal(by2.ssh.status, 'up', 'ssh-handshake confirms a real banner');
  assert.equal(by2.notssh.status, 'down', 'ssh-handshake rejects a non-ssh port');
  assert.equal(by2.icmp.status, 'unsupported', 'icmp not in allowlist → unsupported');
  ok('ssh-handshake up/down + method outside allowlist → unsupported');

  plain.close(); ssh.close();
  console.log('\n✅ healthcheck-check passed');
} catch (e) {
  console.error(`\n❌ healthcheck-check failed at [${step}]:`, e.message);
  process.exit(1);
}
