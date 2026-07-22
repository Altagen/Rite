/**
 * Anonymous sealed boxes for team-key sharing (ADR 0013) — browser/webview side.
 *
 * libsodium `crypto_box_seal` (X25519 + XSalsa20-Poly1305), byte-compatible with
 * the Rust `rite_crypto::sealbox` (dryoc), pinned by `e2e/sealbox-check.mjs`.
 * Sealed bytes travel base64 (standard, padded — matching Rust's base64 STANDARD).
 */

import sodium from 'libsodium-wrappers';

/** A fresh X25519 keypair (raw bytes). */
export async function generateKeypair(): Promise<{
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}> {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

/** Seal `plaintext` to `recipientPublic` (raw 32 bytes) → base64 sealed box. */
export async function seal(recipientPublic: Uint8Array, plaintext: Uint8Array): Promise<string> {
  await sodium.ready;
  return b64encode(sodium.crypto_box_seal(plaintext, recipientPublic));
}

/** Open a base64 sealed box with the recipient's keypair (raw bytes). */
export async function open(
  publicKey: Uint8Array,
  secretKey: Uint8Array,
  sealedB64: string,
): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_box_seal_open(b64decode(sealedB64), publicKey, secretKey);
}

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
