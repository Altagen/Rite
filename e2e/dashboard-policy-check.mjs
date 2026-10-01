// Smoke check for the machine-dashboard policy (ADR 0019). Proves the policy round-trips
// through server_mode with the shipped defaults, that each half can be turned off on its own,
// that a non-admin cannot touch it, and that the validation refuses what would silently
// disable the feature for a whole organisation (a non-boolean half, a zero or absurd
// interval). Run: node e2e/dashboard-policy-check.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../apps/desktop/index.html', import.meta.url));
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
async function login(username, password) { const pre = await (await post('/api/server/prelogin', { username })).json(); return (await post('/api/server/login', { username, authHash: await argon(password, pre.salt) })).json(); }
const policy = () => getJson('/api/server/mode').then((m) => m.dashboardPolicy);

let step = '';
const ok = (m) => console.log('  ✓ ' + m);
try {
  step = 'setup';
  const av = await vaultFor('AdminPass1!');
  const admin = (await (await post('/api/server/bootstrap', { username: 'admin', ...av.body })).json()).token;
  const bv = await vaultFor('BobTemp1!');
  await post('/api/admin/users', { username: 'bob', role: 'user', ...bv.body }, admin);
  const bob = (await login('bob', 'BobTemp1!')).token;
  ok('admin + non-admin bob provisioned');

  step = 'defaults';
  // A server that has never been configured has not said no. Reading silence as a refusal
  // would disable a shipped feature on upgrade, which is the one outcome nobody asked for.
  assert.deepEqual(await policy(), { webui: true, clients: true, minInterval: 30 }, 'shipped defaults in server_mode');
  ok('unconfigured server → { webui: true, clients: true, minInterval: 30 }');

  step = 'per-shell';
  // The two halves cost different things (the server's egress vs the users' endpoints), so
  // an admin must be able to aim the switch at one without hitting the other.
  assert.equal((await patch('/api/admin/dashboard-policy', { webui: false, clients: true, minInterval: 30 }, admin)).status, 204, 'webui off');
  assert.deepEqual(await policy(), { webui: false, clients: true, minInterval: 30 }, 'only the web UI is refused');
  assert.equal((await patch('/api/admin/dashboard-policy', { webui: true, clients: false, minInterval: 60 }, admin)).status, 204, 'clients off');
  assert.deepEqual(await policy(), { webui: true, clients: false, minInterval: 60 }, 'only the clients are refused');
  ok('each half turns off on its own, and server_mode says which');

  step = 'enforcement';
  // ADR 0019 §6: in the web UI the refusal is enforcement, not policy — a client that
  // ignores its own gate must still be refused here, because this server is the thing
  // that would run the command. The alternative is an admin console that promises
  // "nothing runs" while anything that can POST still gets an answer.
  const probe = (token) =>
    post('/api/terminal/exec-quick', {
      host: '127.0.0.1', port: 2222, username: 'riteuser',
      authMethod: { type: 'password', password: 'ritepass123' },
      command: 'echo probe',
    }, token);
  assert.equal((await patch('/api/admin/dashboard-policy', { webui: false, clients: true, minInterval: 30 }, admin)).status, 204, 'webui off');
  assert.equal((await probe(bob)).status, 403, 'exec refused while the web UI is off');
  // The admin is not special here: the policy is about this server's egress, not about
  // who is asking. An admin who wants the cards back turns them back on.
  assert.equal((await probe(admin)).status, 403, 'and refused for an admin too');
  assert.equal((await patch('/api/admin/dashboard-policy', { webui: true, clients: true, minInterval: 30 }, admin)).status, 204, 'webui on');
  assert.notEqual((await probe(bob)).status, 403, 'and served again once allowed');
  ok('webui:false is enforced on /api/terminal/exec-quick, not just hidden in the UI');

  step = 'admin-only';
  assert.equal((await patch('/api/admin/dashboard-policy', { webui: false, clients: false, minInterval: 30 }, bob)).status, 403, 'non-admin refused');
  assert.deepEqual(await policy(), { webui: true, clients: true, minInterval: 30 }, 'and the policy is untouched');
  ok('a non-admin cannot change it (403), and nothing moved');

  step = 'validation';
  for (const [body, why] of [
    [{ webui: 'yes', clients: true, minInterval: 30 }, 'a non-boolean half'],
    [{ webui: true, clients: 1, minInterval: 30 }, 'a numeric half'],
    [{ webui: true, clients: true, minInterval: 0 }, 'a zero floor (that is the self-DoS)'],
    [{ webui: true, clients: true, minInterval: 3601 }, 'a floor past any plausible dashboard'],
  ]) {
    assert.equal((await patch('/api/admin/dashboard-policy', body, admin)).status, 400, `rejected: ${why}`);
  }
  assert.deepEqual(await policy(), { webui: true, clients: true, minInterval: 30 }, 'no rejected write landed');
  ok('validation refuses what would silently disable the feature; nothing partial stored');

  step = 'reopen';
  assert.equal((await patch('/api/admin/dashboard-policy', { webui: true, clients: true, minInterval: 30 }, admin)).status, 204, 'reopen');
  assert.deepEqual(await policy(), { webui: true, clients: true, minInterval: 30 }, 'back to both allowed');
  ok('the policy reopens cleanly');

  console.log('\n✅ dashboard-policy-check passed');
} catch (e) {
  console.error(`\n❌ dashboard-policy-check failed at [${step}]:`, e.message);
  process.exit(1);
}
