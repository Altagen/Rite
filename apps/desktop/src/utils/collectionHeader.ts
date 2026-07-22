/**
 * A collection's encrypted header (ADR 0016): its display name/colour plus the
 * list of its shared sub-folders. Folders are part of the collection's encrypted
 * payload (the server only sees ciphertext), so members see the same curated
 * structure and empty folders survive. Machines reference a folder by name via
 * their own `folder` field.
 */

import { Backend } from './backend';
import {
  unwrapCollectionKey,
  encryptCollectionField,
  decryptCollectionField,
} from './collectionCrypto';

export interface CollectionFolder {
  name: string;
  color: string | null;
}

export interface CollectionHeader {
  name: string;
  color: string | null;
  folders?: CollectionFolder[];
}

/** Unwrap a collection's key and decrypt its header (name/colour/folders). */
export async function readCollectionHeader(
  collectionId: string,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): Promise<{ key: Uint8Array; header: CollectionHeader }> {
  const mine = await Backend.Collections.mine();
  const self = mine.find((c) => c.id === collectionId);
  if (!self?.protectedCollectionKey) throw new Error('you do not hold this collection key');
  const key = await unwrapCollectionKey(publicKey, privateKey, self.protectedCollectionKey);
  const header = await decryptCollectionField<CollectionHeader>(key, self.nameEnc);
  return { key, header };
}

/** Re-encrypt and store a collection's header with the collection key. */
export async function writeCollectionHeader(
  collectionId: string,
  key: Uint8Array,
  header: CollectionHeader,
): Promise<void> {
  await Backend.Collections.update(collectionId, await encryptCollectionField(key, header));
}

/** Add a folder to a collection's header (no-op if the name already exists). */
export async function addCollectionFolder(
  collectionId: string,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  folder: CollectionFolder,
): Promise<void> {
  const { key, header } = await readCollectionHeader(collectionId, publicKey, privateKey);
  const folders = header.folders ?? [];
  if (folders.some((f) => f.name === folder.name)) return;
  await writeCollectionHeader(collectionId, key, { ...header, folders: [...folders, folder] });
}
