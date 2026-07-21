/**
 * Collection crypto (ADR 0016) — the browser side.
 *
 * A collection has a symmetric key. It is sealed to each member's X25519 public key
 * (an X25519 sealed box, ADR 0013 sealbox); members unwrap their sealed copy with
 * their private key. The key then encrypts the collection's name/colour and its
 * items. Same primitives as team crypto — collections generalise teams (ADR 0016).
 */

import { generateUserKey, hexToBytes, encryptString, decryptString } from './vaultCrypto';
import { seal, open } from './sealbox';

/** A fresh random 32-byte collection key. */
export function generateCollectionKey(): Uint8Array {
  return generateUserKey();
}

/** Seal the collection key to a member whose public key is hex-encoded (directory). */
export function sealCollectionKeyToHex(recipientPublicHex: string, key: Uint8Array): Promise<string> {
  return seal(hexToBytes(recipientPublicHex), key);
}

/** Unwrap my sealed collection key with my own keypair. */
export function unwrapCollectionKey(
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  protectedCollectionKey: string,
): Promise<Uint8Array> {
  return open(publicKey, privateKey, protectedCollectionKey);
}

/** Encrypt a field (the {name,color} header, or an item record) → an opaque blob. */
export function encryptCollectionField(key: Uint8Array, value: unknown): Promise<string> {
  return encryptString(key, new TextEncoder().encode(JSON.stringify(value)));
}

/** Decrypt a collection blob back to its value. */
export async function decryptCollectionField<T>(key: Uint8Array, blob: string): Promise<T> {
  const pt = await decryptString(key, blob);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
