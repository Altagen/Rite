/**
 * Client-side auth-hash derivation for server login (ADR 0010, Bitwarden-style).
 *
 * The password NEVER leaves the browser. From the password + the per-user KDF
 * salt/params (from `prelogin`) we derive an Argon2id auth hash and send only
 * that; the server stores an Argon2id verifier of it. The vault key (later,
 * phase 2) is a separate client-side derivation that is never sent.
 */

/**
 * Argon2id, loaded on demand.
 *
 * `hash-wasm` is a WASM blob needed only where a password is turned into a key: signing
 * in to a server, and unlocking a vault. Neither happens before the page is on screen, so
 * carrying it in the first chunk charged every reader for a step some of them never take.
 * The call sites were already `async`.
 */
const argon2id = async (...args: Parameters<typeof import('hash-wasm').argon2id>) =>
  (await import('hash-wasm')).argon2id(...args);
import {
  deriveMasterKey,
  generateUserKey,
  wrapUserKey,
  unwrapUserKey,
  encryptString,
  decryptString,
  hexToBytes,
  bytesToHex,
} from './vaultCrypto';
import { generateKeypair } from './sealbox';
import { kdfIsStrongEnough, WeakKdfError, type KdfParams } from './kdfFloor';

// The floor and its refusal live in their own module, which imports nothing, so a check
// can load the policy without pulling in WebCrypto and libsodium (ADR 0029).
export { MIN_KDF_PARAMS, kdfIsStrongEnough, WeakKdfError } from './kdfFloor';
export type { KdfParams } from './kdfFloor';

/** OWASP Argon2id baseline — must match the server's `KdfParams::recommended`. */
export const DEFAULT_KDF_PARAMS: KdfParams = { mem: 19456, iter: 2, par: 1 };

/** A fresh random salt (hex) for a new account. */
export function randomSaltHex(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** Derive the auth hash (hex) the server verifies — the password stays local. */
export async function deriveAuthHash(
  password: string,
  saltHex: string,
  params: KdfParams,
): Promise<string> {
  // Before the derivation, not after: the point is never to compute the cheap hash at all.
  if (!kdfIsStrongEnough(params)) throw new WeakKdfError(params);
  return argon2id({
    password,
    salt: hexToBytes(saltHex),
    parallelism: params.par,
    iterations: params.iter,
    memorySize: params.mem,
    hashLength: 32,
    outputType: 'hex',
  });
}

/**
 * Vault key material generated client-side at signup (ADR 0011). `masterSaltHex`
 * + `protectedUserKey` are sent to the server; `userKey` is kept locally (never
 * sent) so the caller can hold it without a second derivation.
 */
export interface VaultKeyMaterial {
  masterSaltHex: string;
  protectedUserKey: string;
  userKey: Uint8Array;
  // Per-user X25519 keypair (ADR 0013): public key hex is sent, private key is
  // wrapped by userKey (sent), and both raw keys are kept locally.
  publicKeyHex: string;
  protectedPrivateKey: string;
  privateKey: Uint8Array;
}

/** The unwrapped in-RAM keys held after login (never persisted). */
export interface UnlockedKeys {
  userKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Build a fresh per-user vault key + X25519 keypair. Called by whoever knows the
 * password at account creation (self at bootstrap, admin for a new user).
 */
export async function createVaultKey(password: string): Promise<VaultKeyMaterial> {
  const masterSaltHex = randomSaltHex();
  const masterKey = await deriveMasterKey(password, hexToBytes(masterSaltHex));
  const userKey = generateUserKey();
  const protectedUserKey = await wrapUserKey(masterKey, userKey);
  const { publicKey, secretKey } = await generateKeypair();
  const protectedPrivateKey = await encryptString(userKey, secretKey);
  return {
    masterSaltHex,
    protectedUserKey,
    userKey,
    publicKeyHex: bytesToHex(publicKey),
    protectedPrivateKey,
    privateKey: secretKey,
  };
}

/** Unwrap the user key + private key from the password + the server vault blob. */
export async function unwrapVaultKey(
  password: string,
  masterSaltHex: string,
  protectedUserKey: string,
  protectedPrivateKey: string,
): Promise<UnlockedKeys> {
  const masterKey = await deriveMasterKey(password, hexToBytes(masterSaltHex));
  const userKey = await unwrapUserKey(masterKey, protectedUserKey);
  const privateKey = await decryptString(userKey, protectedPrivateKey);
  return { userKey, privateKey };
}
