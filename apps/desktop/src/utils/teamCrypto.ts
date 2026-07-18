/**
 * Team key sharing crypto (ADR 0013) — the browser-side flows.
 *
 * A team has a symmetric team key. The first key-holder generates it and seals it
 * to their own public key; a key-holder grants access by sealing it to a member's
 * public key (an X25519 sealed box). Members unwrap their sealed copy with their
 * private key. The team key then encrypts the team's connections.
 */

import { generateUserKey, hexToBytes } from './vaultCrypto';
import { seal, open } from './sealbox';

/** A fresh random 32-byte team key. */
export function generateTeamKey(): Uint8Array {
  return generateUserKey();
}

/** Seal a team key to a recipient's public key (raw bytes) → their sealed copy. */
export function sealTeamKey(recipientPublic: Uint8Array, teamKey: Uint8Array): Promise<string> {
  return seal(recipientPublic, teamKey);
}

/** Seal to a recipient whose public key is hex-encoded (from the member list). */
export function sealTeamKeyToHex(recipientPublicHex: string, teamKey: Uint8Array): Promise<string> {
  return seal(hexToBytes(recipientPublicHex), teamKey);
}

/** Unwrap my sealed team key with my own keypair. */
export function unwrapTeamKey(
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  protectedTeamKey: string,
): Promise<Uint8Array> {
  return open(publicKey, privateKey, protectedTeamKey);
}
