// Cross-impl gate for the sealed-box crypto (ADR 0013 phase 1). Proves the
// browser's libsodium `crypto_box_seal` is byte-compatible with the Rust
// `rite_crypto::sealbox` (dryoc): opens a Rust-produced sealed box with a pinned
// keypair, and emits a JS-produced one the Rust test opens in turn. Run from
// apps/desktop (so libsodium-wrappers resolves): `node ../../e2e/sealbox-check.mjs`.
// libsodium-wrappers' ESM build has a broken internal import under raw Node
// (the bundler handles it fine for the app); load the CJS build here.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const sodium = createRequire(import.meta.url)('libsodium-wrappers');

const hexToBytes = (h) => new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const PK = hexToBytes('f1e708d2d28121dae7e360cbcd9764e2a49f3181f63f74d11b119e9ab1882435');
const SK = hexToBytes('9369583ab7fb00c0422863576d238369a693b1039b534fac19af628fa4bb704e');
const SEALED_R = '9GFLaHCDRN2ej7kq0xb9I3zNs9AwQc/z9u+LUGr0syvrVOA80Qmh/r6erpgiJUwACMFbK7g/g+HZb4WFZzOCSdKf';
const MSG = 'rite-sealed-secret';

await sodium.ready;
const dec = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const enc = (b) => Buffer.from(b).toString('base64');

// 1. JS opens the Rust-produced sealed box → the key cross-impl direction.
const opened = sodium.crypto_box_seal_open(dec(SEALED_R), PK, SK);
assert.equal(new TextDecoder().decode(opened), MSG, 'JS could not open the Rust sealed box');

// 2. JS produces a sealed box (the Rust test opens it) + round-trips in JS.
const sealedJ = enc(sodium.crypto_box_seal(new TextEncoder().encode(MSG), PK));
const rt = sodium.crypto_box_seal_open(dec(sealedJ), PK, SK);
assert.equal(new TextDecoder().decode(rt), MSG, 'JS round-trip failed');

console.log('SEALED_J=' + sealedJ);
console.log('sealbox cross-impl OK (JS opened the Rust sealed box)');
