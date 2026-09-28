// Cross-impl gate for the per-user vault crypto (ADR 0011 phase 1). Recomputes
// the browser-side (hash-wasm + WebCrypto AES-256-GCM) master key and an AES-GCM
// token for fixed inputs and asserts they byte-match the vectors pinned in the
// Rust unit test `rite_crypto::vault::tests::cross_impl_vectors`. Run from
// apps/desktop (so hash-wasm resolves): `node ../../e2e/vault-check.mjs`.
import { createRequire } from 'node:module';

// Resolved from the desktop package: a bare ESM import would look next to this
// file instead of the cwd, so the script only ran from one directory.
const { argon2id } = createRequire(new URL('../apps/desktop/index.html', import.meta.url))('hash-wasm');
import assert from 'node:assert/strict';

const MASTER = 'e55975c388c8b9fc9109cab6d6911195edc0b11ae937efcdebbc599f189be4df';
const TOKEN = 'v1.AAAAAAAAAAAAAAAA.E7HQ19bhbouTYvuw6lZG9L8YnnKYj2V5ZPNN';

const utf8 = (s) => new TextEncoder().encode(s);
const b64urlEncode = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

// 1. Argon2id master key must match the Rust vector.
const masterHex = await argon2id({
  password: 'correct horse battery staple',
  salt: utf8('rite-master-salt'),
  parallelism: 1,
  iterations: 2,
  memorySize: 19456,
  hashLength: 32,
  outputType: 'hex',
});
assert.equal(masterHex, MASTER, 'master key mismatch');

// 2. AES-256-GCM with the fixed key + IV must reproduce the pinned token.
const key = new Uint8Array(32).fill(7);
const iv = new Uint8Array(12);
const ck = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ck, utf8('rite-secret')));
const token = `v1.${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
assert.equal(token, TOKEN, 'aes-gcm token mismatch');

// 3. Round-trip the Rust-pinned token back to plaintext.
const parts = TOKEN.split('.');
const pt = new Uint8Array(
  await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(parts[1]) }, ck, b64urlDecode(parts[2])),
);
assert.equal(new TextDecoder().decode(pt), 'rite-secret', 'decrypt mismatch');

console.log('vault cross-impl OK (master key + AES-256-GCM token match Rust)');
