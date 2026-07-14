// Direct cross-impl check: prints the browser-side (hash-wasm) Argon2id hex for
// fixed inputs, so a rite-core unit test can pin the exact same value and assert
// the Rust derivation matches byte-for-byte.
import { argon2id } from 'hash-wasm';

const salt = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const hex = await argon2id({
  password: 'rite-crossimpl',
  salt,
  parallelism: 1,
  iterations: 2,
  memorySize: 19456,
  hashLength: 32,
  outputType: 'hex',
});
console.log(hex);
