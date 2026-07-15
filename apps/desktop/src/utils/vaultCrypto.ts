/**
 * Per-user zero-knowledge vault crypto (ADR 0011) — browser/webview side.
 *
 * The password and all derived keys NEVER leave the client. Byte-compatible with
 * the Rust implementation in `packages/crypto/src/vault.rs` (pinned by the
 * cross-impl test / `e2e/vault-check.mjs`):
 *
 * - masterKey = Argon2id(password, master-salt) — via hash-wasm, never sent.
 * - userKey   = random 32 bytes, generated once per account.
 * - protectedUserKey = AES-256-GCM(masterKey, userKey), stored on the server.
 * - vault items = AES-256-GCM(userKey, plaintext).
 *
 * AES-256-GCM via WebCrypto (native, hardware-accelerated). Wire format for an
 * encrypted value: `v1.<b64url(iv)>.<b64url(ciphertext‖tag)>` (12-byte IV,
 * 16-byte tag appended to the ciphertext, as WebCrypto/`aes-gcm` both produce).
 */

import { argon2id } from 'hash-wasm';

/** Argon2id params for the master key — identical to the auth-hash KDF (ADR 0010). */
const KDF = { mem: 19456, iter: 2, par: 1 } as const;
const IV_LEN = 12;
export const KEY_LEN = 32;

/** A fresh random 32-byte user key. */
export function generateUserKey(): Uint8Array {
  const k = new Uint8Array(KEY_LEN);
  crypto.getRandomValues(k);
  return k;
}

/**
 * Derive the 32-byte master key from a password + salt (Argon2id). The salt MUST
 * differ from the auth-hash salt (see ADR 0011). Returns raw key bytes.
 */
export async function deriveMasterKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const hex = await argon2id({
    password,
    salt,
    parallelism: KDF.par,
    iterations: KDF.iter,
    memorySize: KDF.mem,
    hashLength: KEY_LEN,
    outputType: 'hex',
  });
  return hexToBytes(hex);
}

/** Encrypt `plaintext` under `key` (AES-256-GCM) → a `v1.iv.ct` string. */
export async function encryptString(key: Uint8Array, plaintext: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  return encryptWithIv(key, iv, plaintext);
}

/** Deterministic variant with a caller-supplied IV — for test vectors only. */
export async function encryptWithIv(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Promise<string> {
  const ck = await importKey(key);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, ck, plaintext as BufferSource),
  );
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}

/** Decrypt a `v1.iv.ct` string produced by {@link encryptString}. */
export async function decryptString(key: Uint8Array, token: string): Promise<Uint8Array> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('malformed encrypted value');
  const iv = b64urlDecode(parts[1]);
  const ct = b64urlDecode(parts[2]);
  if (iv.length !== IV_LEN) throw new Error('bad iv length');
  const ck = await importKey(key);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, ck, ct as BufferSource),
  );
}

/** Wrap the user key with the master key → the stored `protectedUserKey`. */
export function wrapUserKey(masterKey: Uint8Array, userKey: Uint8Array): Promise<string> {
  return encryptString(masterKey, userKey);
}

/** Unwrap the stored `protectedUserKey` back to the 32-byte user key. */
export async function unwrapUserKey(masterKey: Uint8Array, protectedKey: string): Promise<Uint8Array> {
  const k = await decryptString(masterKey, protectedKey);
  if (k.length !== KEY_LEN) throw new Error('unwrapped user key has wrong length');
  return k;
}

// --- helpers ---------------------------------------------------------------

function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
