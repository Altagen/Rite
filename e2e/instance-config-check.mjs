// Smoke check for instance configuration as code (ADR 0020). Proves that a server booted
// from a TOML file is governed by it: the values reach `server_mode`, the environment wins
// over the file leaf by leaf, and — the part that matters — a setting the configuration
// turns off is actually REFUSED, not merely reported as off.
//
// That last distinction is the whole point. Reported-but-not-enforced is the defect 0.2.2
// fixed on the dashboard: a client told "this is disabled" while the server happily served
// the request anyway. A policy nobody applies is worse than no policy, because it is
// believed. Run: node e2e/instance-config-check.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../apps/desktop/index.html', import.meta.url));
const { argon2id } = require('hash-wasm');
const sodium = require('libsodium-wrappers'); await sodium.ready;

const BASE = `http://127.0.0.1:${process.env.RITE_CONFIG_PORT ?? '1427'}`;
const KDF = { mem: 19456, iter: 2, par: 1 };
const hx = (h) => new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const bh = (b) => Buffer.from(b).toString('hex');
const argon = (password, saltHex) => argon2id({ password, salt: hx(saltHex), parallelism: KDF.par, iterations: KDF.iter, memorySize: KDF.mem, hashLength: 32, outputType: 'hex' });
async function aes(k, p) { const iv = crypto.getRandomValues(new Uint8Array(12)); const key = await crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt']); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, p)); const u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); return `v1.${u(iv)}.${u(ct)}`; }
async function post(path, body, token) { return fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) }); }
const getJson = (path) => fetch(BASE + path).then((r) => r.json());
async function vaultFor(password) {
  const authSalt = bh(sodium.randombytes_buf(16));
  const masterSalt = bh(sodium.randombytes_buf(16));
  const masterKey = hx(await argon(password, masterSalt));
  const userKey = sodium.randombytes_buf(32);
  const kp = sodium.crypto_box_keypair();
  return { kp, body: { salt: authSalt, params: KDF, authHash: await argon(password, authSalt), masterSalt, protectedUserKey: await aes(masterKey, userKey), publicKey: bh(kp.publicKey), protectedPrivateKey: await aes(userKey, kp.privateKey) } };
}

let step = '';
const ok = (m) => console.log('  ✓ ' + m);
try {
  step = 'file-reaches-server-mode';
  const mode = await getJson('/api/server/mode');
  assert.equal(mode.instanceName, 'Configured by file', 'a text setting comes from the file');
  assert.equal(mode.allowQuickSsh, true, 'a boolean flipped away from its default');
  assert.equal(mode.openRegistration, true, 'and one flipped away from its default too');
  ok('the file governs server_mode — text and booleans alike');

  step = 'partial-policy';
  // The file declares `webui` only. The other fields must still be there, at their shipped
  // defaults: the operator said one thing, not three.
  assert.equal(mode.dashboardPolicy.webui, false, 'declared in the file');
  assert.equal(mode.dashboardPolicy.clients, true, 'undeclared field keeps its default');
  ok('a partially declared policy is completed, not truncated');

  step = 'env-over-file';
  assert.equal(mode.dashboardPolicy.minInterval, 90, 'RITE__dashboard_policy__minInterval wins');
  assert.equal(mode.collectionPolicy.maxMembers, 7, 'and the rest of the file still stands');
  ok('the environment overrides one field of a policy the file declares');

  step = 'enforced-not-just-reported';
  // The configuration turns self-registration ON, which is not the default. Nothing was
  // ever written to the database, so an endpoint still reading the database refuses — and
  // that refusal would look exactly like a working guard if the file had merely agreed
  // with the default. Asserting on the flip is the only way to tell the two apart.
  const v = await vaultFor('Config-Str0ng!pass');
  const res = await post('/api/server/register', { username: 'walkin', ...v.body });
  assert.equal(res.status, 201, `the file allows registration, so it must succeed — got ${res.status}`);
  ok('open_registration is enforced at the endpoint, not only reported');

  console.log('\n✅ instance-config-check passed');
} catch (e) {
  console.error(`\n❌ instance-config-check failed at [${step}]:`, e.message);
  process.exit(1);
}
