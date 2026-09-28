// Cross-impl gate for the collection envelope (ADR 0016 / ADR 0018).
//
// A collection blob written on one side must be readable on the other: the desktop
// decrypts in Rust, the browser in JS, and both hit the same collections. This
// reproduces the browser side of `encryptCollectionField` (JSON → AES-256-GCM,
// `v1.<b64url(iv)>.<b64url(ct‖tag)>`) for fixed inputs and asserts it byte-matches
// the vector pinned in the Rust unit test
// `rite_core::collection_crypto::tests::cross_impl_vector_from_the_browser`.
//
// Run from the repo root: `node e2e/collection-crypto-check.mjs`
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

// The same vector the Rust test pins.
const BLOB = 'v1.AAAAAAAAAAAAAAAA.GvrK05b3KdLDT-AJoVsnz9_NhdsQs8c0ZDe66mzQfwWI_yh2_hHzcXACJ94nccUUERMhthg';
const HEADER = { name: 'Home lab', color: '#9ece6a' };

const b64urlEncode = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) =>
  new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

const key = new Uint8Array(32).fill(7);
const iv = new Uint8Array(12);
const ck = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);

// 1. Browser → Rust: encrypting the header must reproduce the pinned blob exactly.
//    Field order is part of the contract (JSON.stringify follows insertion order,
//    serde_json follows struct declaration order — they must agree).
const json = new TextEncoder().encode(JSON.stringify(HEADER));
const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, ck, json));
assert.equal(`v1.${b64urlEncode(iv)}.${b64urlEncode(ct)}`, BLOB, 'collection field encoding mismatch');

// 2. Rust → browser: the pinned blob must decrypt back to the same value.
const parts = BLOB.split('.');
assert.equal(parts.length, 3, 'malformed envelope');
assert.equal(parts[0], 'v1', 'unexpected envelope version');
const pt = new Uint8Array(
  await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(parts[1]) }, ck, b64urlDecode(parts[2])),
);
assert.deepEqual(JSON.parse(new TextDecoder().decode(pt)), HEADER, 'collection field round-trip mismatch');

// 3. A wrong key must fail rather than return garbage.
const wrong = await webcrypto.subtle.importKey('raw', new Uint8Array(32).fill(8), 'AES-GCM', false, ['decrypt']);
await assert.rejects(
  webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(parts[1]) }, wrong, b64urlDecode(parts[2])),
  'a foreign key must not open a collection blob',
);

console.log('collection-crypto: browser ↔ Rust envelope matches');
