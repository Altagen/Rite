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

/**
 * A fresh pair of collection keys (ADR 0016 split-key model): `metaKey` encrypts the
 * name/colour header, `itemsKey` the machines/credentials. They are independent so an
 * admin can be granted the name (via the metaKey escrow) without the credentials.
 */
export function generateCollectionKeys(): { metaKey: Uint8Array; itemsKey: Uint8Array } {
  return { metaKey: generateUserKey(), itemsKey: generateUserKey() };
}

/** My sealed copies of a collection's keys (from `Collections.mine()`). */
export interface ProtectedCollectionKeys {
  protectedMetaKey?: string | null;
  protectedItemsKey?: string | null;
}

/**
 * Unwrap a collection's metaKey (name/colour) and itemsKey (machines) with my own
 * keypair. `itemsKey` is null for a roster-only member (admin meta-add) — they hold
 * the metaKey (see the name) but not the itemsKey until a member seals machine access.
 */
export async function unwrapCollectionKeys(
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  keys: ProtectedCollectionKeys,
): Promise<{ metaKey: Uint8Array; itemsKey: Uint8Array | null }> {
  if (!keys.protectedMetaKey) throw new Error('you do not hold this collection key');
  const metaKey = await open(publicKey, privateKey, keys.protectedMetaKey);
  const itemsKey = keys.protectedItemsKey
    ? await open(publicKey, privateKey, keys.protectedItemsKey)
    : null;
  return { metaKey, itemsKey };
}

/** Seal the collection key to a raw X25519 public key (e.g. my own, on create). */
export function sealCollectionKey(recipientPublic: Uint8Array, key: Uint8Array): Promise<string> {
  return seal(recipientPublic, key);
}

/** Seal the collection key to a member whose public key is hex-encoded (directory). */
export function sealCollectionKeyToHex(recipientPublicHex: string, key: Uint8Array): Promise<string> {
  return seal(hexToBytes(recipientPublicHex), key);
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
