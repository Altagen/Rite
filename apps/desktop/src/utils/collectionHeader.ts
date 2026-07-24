/**
 * A collection's encrypted header (ADR 0016): its display name/colour plus the
 * list of its shared sub-folders. Folders are part of the collection's encrypted
 * payload (the server only sees ciphertext), so members see the same curated
 * structure and empty folders survive. Machines reference a folder by name via
 * their own `folder` field.
 */

import { Backend } from './backend';
import {
  unwrapCollectionKeys,
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
  // Marks the auto-provisioned per-user "Personal" collection (a real 1-member
  // collection, ADR 0016). The marker lives in the encrypted header so it stays
  // zero-knowledge; the client finds Personal by decrypting headers.
  personal?: boolean;
}

/**
 * Unwrap a collection's two keys and decrypt its header (name/colour/folders).
 * The header is encrypted with `metaKey`; `itemsKey` is returned for callers that
 * also need to re-tag the collection's machines (ADR 0016 split-key model).
 */
export async function readCollectionHeader(
  collectionId: string,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): Promise<{ metaKey: Uint8Array; itemsKey: Uint8Array; header: CollectionHeader }> {
  const mine = await Backend.Collections.mine();
  const self = mine.find((c) => c.id === collectionId);
  if (!self) throw new Error('you do not hold this collection key');
  const { metaKey, itemsKey } = await unwrapCollectionKeys(publicKey, privateKey, self);
  const header = await decryptCollectionField<CollectionHeader>(metaKey, self.nameEnc);
  return { metaKey, itemsKey, header };
}

/** Re-encrypt and store a collection's header with its metaKey. */
export async function writeCollectionHeader(
  collectionId: string,
  metaKey: Uint8Array,
  header: CollectionHeader,
): Promise<void> {
  await Backend.Collections.update(collectionId, await encryptCollectionField(metaKey, header));
}

/** Add a folder to a collection's header (no-op if the name already exists). */
export async function addCollectionFolder(
  collectionId: string,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  folder: CollectionFolder,
): Promise<void> {
  const { metaKey, header } = await readCollectionHeader(collectionId, publicKey, privateKey);
  const folders = header.folders ?? [];
  if (folders.some((f) => f.name === folder.name)) return;
  await writeCollectionHeader(collectionId, metaKey, { ...header, folders: [...folders, folder] });
}

/** Whether a machine's folder path is at, or nested under, a target folder path. */
function underPath(folder: string | null, path: string): boolean {
  return folder === path || (folder !== null && folder.startsWith(path + '/'));
}

/**
 * Re-tag a collection's machines: for each item, `transform` gets its current folder
 * and returns a new one (or `undefined` to leave it unchanged). Re-encrypts + stores
 * only the items that changed.
 */
async function retagCollectionItems(
  collectionId: string,
  key: Uint8Array,
  transform: (folder: string | null) => string | null | undefined,
): Promise<void> {
  for (const it of await Backend.Collections.items(collectionId)) {
    try {
      const record = await decryptCollectionField<Record<string, unknown>>(key, it.blob);
      const current = (record.folder as string | null | undefined) ?? null;
      const next = transform(current);
      if (next === undefined) continue;
      record.folder = next;
      await Backend.Collections.updateItem(collectionId, it.id, await encryptCollectionField(key, record));
    } catch {
      // undecryptable item — skip
    }
  }
}

/** The parent path of a folder path, or null at the top level. */
function parentPath(path: string): string | null {
  const i = path.lastIndexOf('/');
  return i === -1 ? null : path.slice(0, i);
}

/**
 * Rename a folder (and its sub-tree) inside a collection: rewrites the `oldPath`
 * prefix to `newPath` in the header folders and re-tags every affected machine.
 */
export async function renameCollectionFolder(
  collectionId: string,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  oldPath: string,
  newPath: string,
  newColor?: string | null,
): Promise<void> {
  if (!newPath.trim() || newPath === oldPath) {
    if (newColor === undefined) return;
  }
  const { metaKey, itemsKey, header } = await readCollectionHeader(collectionId, publicKey, privateKey);
  const rewrite = (name: string) =>
    name === oldPath ? newPath : name.startsWith(oldPath + '/') ? newPath + name.slice(oldPath.length) : name;
  const folders = (header.folders ?? []).map((f) => ({
    name: rewrite(f.name),
    color: f.name === oldPath && newColor !== undefined ? newColor : f.color,
  }));
  await writeCollectionHeader(collectionId, metaKey, { ...header, folders });
  await retagCollectionItems(collectionId, itemsKey, (folder) =>
    folder !== null && underPath(folder, oldPath) ? rewrite(folder) : undefined,
  );
}

/**
 * Delete a folder inside a collection: removes it (and its sub-tree) from the header
 * and moves the machines under it up to the deleted folder's parent (or the root).
 */
export async function deleteCollectionFolder(
  collectionId: string,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  path: string,
): Promise<void> {
  const { metaKey, itemsKey, header } = await readCollectionHeader(collectionId, publicKey, privateKey);
  const parent = parentPath(path);
  const folders = (header.folders ?? []).filter((f) => !underPath(f.name, path));
  await writeCollectionHeader(collectionId, metaKey, { ...header, folders });
  await retagCollectionItems(collectionId, itemsKey, (folder) => {
    if (folder === null || !underPath(folder, path)) return undefined;
    if (folder === path) return parent; // the folder itself → its parent (or root)
    const rest = folder.slice(path.length + 1); // strip "path/"
    return parent ? `${parent}/${rest}` : rest;
  });
}
