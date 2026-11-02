// The agent-manager policy (ADR 0022 §3). Proves the policy round-trips through
// server_mode with the shipped defaults, that each half turns off on its own, that a
// non-admin cannot touch it, that validation refuses a non-boolean half — and the reason
// it is its own key rather than a third field of `dashboard_policy`: the two gates move
// independently, so an administrator can allow container listings while refusing to let
// the product enumerate home directories, and the reverse.
// Run: node e2e/agent-policy-check.mjs
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
const agents = () => getJson('/api/server/mode').then((m) => m.agentPolicy);
const dash = () => getJson('/api/server/mode').then((m) => m.dashboardPolicy);
const setAgents = (body, token) => patch('/api/admin/agent-policy', body, token);
const BOTH = { webui: true, clients: true };

let step = '';
const ok = (m) => console.log('  ✓ ' + m);
try {
  step = 'setup';
  const av = await vaultFor('AdminPass1!');
  const admin = (await (await post('/api/server/bootstrap', { username: 'admin', ...av.body })).json()).token;
  const bv = await vaultFor('BobTemp1!');
  await post('/api/admin/users', { username: 'bob', role: 'user', ...bv.body }, admin);
  const bob = (await login('bob', 'BobTemp1!')).token;
  // Ad-hoc Quick SSH on, for the whole run. The routes below take a host from the caller,
  // so they also answer to `allow_quick_ssh` — and a 403 from that refusal would read
  // exactly like the policy gate this file is about, which is how one gets asserted while
  // the other does the work. `server-authz-check` is where that one is held.
  assert.equal((await patch('/api/admin/quick-ssh', { enabled: true }, admin)).status, 204, 'ad-hoc on');
  ok('admin + non-admin bob provisioned');

  step = 'defaults';
  // On/on, for ADR 0019's reason: a policy that silently disables a working feature on
  // upgrade is a worse surprise than the traffic it saves.
  assert.deepEqual(await agents(), BOTH, 'shipped defaults in server_mode');
  // And no `minInterval`, because discovery is explicit — the user picks a machine and
  // asks. A floor would be a knob for traffic that is never automatic.
  assert.equal(Object.keys(await agents()).length, 2, 'two keys, no floor');
  ok('unconfigured server → { webui: true, clients: true }, and nothing else');

  step = 'per-shell';
  assert.equal((await setAgents({ webui: false, clients: true }, admin)).status, 204, 'webui off');
  assert.deepEqual(await agents(), { webui: false, clients: true }, 'only the web UI is refused');
  assert.equal((await setAgents({ webui: true, clients: false }, admin)).status, 204, 'clients off');
  assert.deepEqual(await agents(), { webui: true, clients: false }, 'only the clients are refused');
  ok('each half turns off on its own, and server_mode says which');

  step = 'enforcement';
  // A browser cannot open SSH, so the exec it asks for happens on this server or not at
  // all — which is why the refusal has to live here and not only in the UI.
  const target = { host: '127.0.0.1', port: 2222, username: 'riteuser', authMethod: { type: 'password', password: 'ritepass123' }, command: 'echo probe' };
  const probeAgents = (token) => post('/api/agents/probe-quick', target, token);
  const probeDash = (token) => post('/api/terminal/exec-quick', target, token);
  assert.equal((await setAgents({ webui: false, clients: true }, admin)).status, 204, 'webui off');
  assert.equal((await probeAgents(bob)).status, 403, 'discovery refused while the web UI is off');
  // Not about who is asking: the policy is about this server's egress and the files it
  // reads on a user's behalf. An admin who wants discovery back turns it back on.
  assert.equal((await probeAgents(admin)).status, 403, 'and refused for an admin too');
  assert.equal((await setAgents(BOTH, admin)).status, 204, 'webui on');
  assert.notEqual((await probeAgents(bob)).status, 403, 'and served again once allowed');
  // The saved route too, and it needs no connection to prove: the gate runs before the
  // vault is touched, so a connection id that does not exist still gets the refusal
  // while the policy is closed, and something other than a refusal once it is open.
  const probeSaved = (token) => post('/api/agents/probe', { connectionId: 'no-such-connection', command: 'echo probe' }, token);
  assert.equal((await setAgents({ webui: false, clients: true }, admin)).status, 204, 'webui off');
  assert.equal((await probeSaved(bob)).status, 403, 'the saved route is refused as well');
  assert.equal((await setAgents(BOTH, admin)).status, 204, 'webui on');
  assert.notEqual((await probeSaved(bob)).status, 403, 'and gets past the gate once allowed');
  ok('webui:false is enforced on both agent routes, not just hidden in the UI');

  step = 'two-gates';
  // THE REASON THERE ARE TWO KEYS. Each gate governs its own route and neither moves the
  // other: allowing `docker ps` is not the same decision as allowing a home directory to
  // be enumerated. If this ever passed with one key, splitting it later is a migration.
  assert.equal((await setAgents({ webui: false, clients: true }, admin)).status, 204, 'agents off');
  assert.equal((await probeAgents(bob)).status, 403, 'discovery refused');
  assert.notEqual((await probeDash(bob)).status, 403, 'and the dashboard still runs');
  assert.deepEqual(await dash(), { webui: true, clients: true, minInterval: 30 }, 'untouched');
  assert.equal((await patch('/api/admin/dashboard-policy', { webui: false, clients: true, minInterval: 30 }, admin)).status, 204, 'dashboard off');
  assert.equal((await setAgents(BOTH, admin)).status, 204, 'agents on');
  assert.equal((await probeDash(bob)).status, 403, 'the dashboard is refused');
  assert.notEqual((await probeAgents(bob)).status, 403, 'and discovery runs');
  assert.equal((await patch('/api/admin/dashboard-policy', { webui: true, clients: true, minInterval: 30 }, admin)).status, 204, 'dashboard on');
  ok('either gate closes without the other, in both directions');

  step = 'admin-only';
  assert.equal((await setAgents({ webui: false, clients: false }, bob)).status, 403, 'non-admin refused');
  assert.deepEqual(await agents(), BOTH, 'and the policy is untouched');
  ok('a non-admin cannot change it (403), and nothing moved');

  step = 'validation';
  for (const [body, why] of [
    [{ webui: 'yes', clients: true }, 'a non-boolean half'],
    [{ webui: true, clients: 1 }, 'a numeric half'],
  ]) {
    assert.equal((await setAgents(body, admin)).status, 400, `rejected: ${why}`);
  }
  assert.deepEqual(await agents(), BOTH, 'no rejected write landed');
  ok('validation refuses what would silently disable the feature; nothing partial stored');

  console.log('\n✅ agent-policy-check passed');
} catch (e) {
  console.error(`\n❌ agent-policy-check failed at [${step}]:`, e.message);
  process.exit(1);
}
