// Direct cross-impl check: prints the browser-side (hash-wasm) Argon2id hex for
// fixed inputs, so a rite-core unit test can pin the exact same value and assert
// the Rust derivation matches byte-for-byte.
import { createRequire } from 'node:module';

// hash-wasm lives in the desktop package (pnpm doesn't hoist it to the repo root),
// and a bare ESM import resolves from THIS file's directory rather than the cwd —
// so it has to be required from there explicitly, like the other checks do. That
// also makes the script runnable from anywhere.
const { argon2id } = createRequire(new URL('../apps/desktop/index.html', import.meta.url))('hash-wasm');

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
