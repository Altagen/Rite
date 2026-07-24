/**
 * Admin-group escrow (ADR 0016 split-key model) — the browser side.
 *
 * The Admin group is a versioned X25519 keypair. A collection's `metaKey` (name/colour)
 * is sealed once to the group PUBLIC key (`meta_key_group_enc`); the group PRIVATE key
 * is sealed to each admin (`admin_group_grants`). So an admin unwraps the group key with
 * their own keypair, then unwraps any collection's metaKey → the name — but never the
 * `itemsKey` (machines), which is sealed to members only. The server holds no key.
 *
 * Adding an admin = one new grant (no per-collection work). Removing one = a fresh
 * epoch (rotation): re-seal every collection's escrow + re-grant to the remaining
 * admins — done here, client-side, by an admin who holds the current key.
 */

import { Backend, type AdminKey } from './backend';
import { generateKeypair, seal, open } from './sealbox';
import { hexToBytes, bytesToHex } from './vaultCrypto';
import { decryptCollectionField } from './collectionCrypto';

/** The current group key as raw bytes + epoch (public key is hex on the wire). */
export interface GroupKey {
  epoch: number;
  publicKey: Uint8Array;
}

/**
 * Escrow a new collection's metaKey to the Admin group, for the create call. Fetches the
 * (member-readable) group public key and seals `metaKey` to it. Returns null when no
 * group exists yet — the collection is created without escrow (name stays admin-private
 * until a later re-escrow), which keeps creation working before any admin bootstrap.
 */
export async function escrowForCreate(
  metaKey: Uint8Array,
): Promise<{ metaKeyGroupEnc: string; groupEpoch: number } | null> {
  const gk = await Backend.Collections.groupKey().catch(() => null);
  if (!gk) return null;
  return { metaKeyGroupEnc: await seal(hexToBytes(gk.publicKey), metaKey), groupEpoch: gk.epoch };
}

/** Seal a group private key to every admin who has a published public key. */
async function grantsFor(
  admins: AdminKey[],
  groupSecret: Uint8Array,
): Promise<{ userId: string; protectedPrivateKey: string }[]> {
  return Promise.all(
    admins.map(async (a) => ({
      userId: a.userId,
      protectedPrivateKey: await seal(hexToBytes(a.publicKey), groupSecret),
    })),
  );
}

/**
 * Ensure the Admin group key exists, bootstrapping it if not (admin-only path). Returns
 * the current group public key + epoch, or null if it can't be established yet (e.g. no
 * admin has a published keypair). Safe to call on every admin session start.
 */
export async function ensureGroupKey(): Promise<GroupKey | null> {
  const existing = await Backend.Admin.groupKey().catch(() => null);
  if (existing) return { epoch: existing.epoch, publicKey: hexToBytes(existing.publicKey) };

  const admins = await Backend.Admin.listAdmins().catch(() => [] as AdminKey[]);
  if (!admins.length) return null;
  const { publicKey, secretKey } = await generateKeypair();
  const epoch = 1;
  await Backend.Admin.setGroupKey(epoch, bytesToHex(publicKey), await grantsFor(admins, secretKey));
  return { epoch, publicKey };
}

/**
 * Grant a newly-added/promoted admin the CURRENT group private key, sealed to their
 * public key — the O(1) "add an admin" path (no rotation, no per-collection work). The
 * acting admin unwraps the group key with their own keypair to re-seal it. No-op if the
 * group isn't established yet (the new admin will bootstrap + self-grant on first visit).
 */
export async function grantToAdmin(
  myPublicKey: Uint8Array,
  myPrivateKey: Uint8Array,
  targetUserId: string,
  targetPublicKeyHex: string,
): Promise<void> {
  const secret = await myGroupPrivateKey(myPublicKey, myPrivateKey).catch(() => null);
  if (!secret) return;
  await Backend.Admin.grantAdmin(targetUserId, await seal(hexToBytes(targetPublicKeyHex), secret));
}

/**
 * This admin's group private key (unwrapped with their own keypair), or null if they
 * hold no grant for the current epoch yet (promoted after the last rotation).
 */
export async function myGroupPrivateKey(
  myPublicKey: Uint8Array,
  myPrivateKey: Uint8Array,
): Promise<Uint8Array | null> {
  const grant = await Backend.Admin.groupGrant().catch(() => null);
  if (!grant) return null;
  return open(myPublicKey, myPrivateKey, grant.protectedPrivateKey);
}

/**
 * Rotate the group after an admin is removed: mint a fresh epoch keypair, re-seal every
 * collection's metaKey escrow to the new public key (unwrapping each with the OLD group
 * key the caller still holds), and re-grant the new private key to the remaining admins.
 * The server only ever stores sealed blobs. Idempotent-ish: safe to retry a failed run.
 */
export async function rotateGroup(oldGroup: GroupKey, oldSecret: Uint8Array): Promise<void> {
  const admins = await Backend.Admin.listAdmins();
  if (!admins.length) return;
  const { publicKey, secretKey } = await generateKeypair();
  const epoch = oldGroup.epoch + 1;

  // Re-seal each escrowed collection's metaKey to the new group public key.
  const collections = await Backend.Admin.listCollections();
  for (const c of collections) {
    if (!c.metaKeyGroupEnc) continue;
    try {
      const metaKey = await open(oldGroup.publicKey, oldSecret, c.metaKeyGroupEnc);
      await Backend.Admin.setEscrow(c.id, await seal(publicKey, metaKey), epoch);
    } catch {
      // couldn't unseal (not our epoch / corrupt) — leave it; a later pass can retry
    }
  }
  // New epoch + grants land last, so the re-sealed escrows are already in place.
  await Backend.Admin.setGroupKey(epoch, bytesToHex(publicKey), await grantsFor(admins, secretKey));
}

/** Convenience: unwrap a metaKey from an escrow blob with the group keypair. */
export async function unsealMetaKey(
  group: GroupKey,
  groupSecret: Uint8Array,
  metaKeyGroupEnc: string,
): Promise<Uint8Array> {
  return open(group.publicKey, groupSecret, metaKeyGroupEnc);
}

/** Decrypt a name/colour blob with a metaKey (thin wrapper over collectionCrypto). */
export function decryptName<T>(metaKey: Uint8Array, nameEnc: string): Promise<T> {
  return decryptCollectionField<T>(metaKey, nameEnc);
}
