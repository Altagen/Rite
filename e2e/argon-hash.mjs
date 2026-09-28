// Tiny helper: print the Rite login auth-hash (Argon2id, the client's KDF params) for a
// password + hex salt. Used by shell e2e checks that can't do WASM crypto in pure sh.
//   node e2e/argon-hash.mjs <password> <saltHex>
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/desktop/index.html', import.meta.url));
const { argon2id } = require('hash-wasm');
const [password, saltHex] = process.argv.slice(2);
const hx = (h) => new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
process.stdout.write(
  await argon2id({ password, salt: hx(saltHex), parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32, outputType: 'hex' }),
);
