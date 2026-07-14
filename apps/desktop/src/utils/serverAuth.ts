/**
 * Client-side auth-hash derivation for server login (ADR 0010, Bitwarden-style).
 *
 * The password NEVER leaves the browser. From the password + the per-user KDF
 * salt/params (from `prelogin`) we derive an Argon2id auth hash and send only
 * that; the server stores an Argon2id verifier of it. The vault key (later,
 * phase 2) is a separate client-side derivation that is never sent.
 */

import { argon2id } from 'hash-wasm';

export interface KdfParams {
  mem: number; // memory in KiB
  iter: number; // iterations
  par: number; // parallelism
}

/** OWASP Argon2id baseline — must match the server's `KdfParams::recommended`. */
export const DEFAULT_KDF_PARAMS: KdfParams = { mem: 19456, iter: 2, par: 1 };

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

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
