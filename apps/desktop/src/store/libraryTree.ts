/**
 * The per-user library tree (ADR 0016 view hierarchy): personal folders that
 * organise collections. It is a display-only tree — no permission inheritance —
 * kept as a blob encrypted with the user key and stored per-user on the server
 * (zero-knowledge: the server never sees folder names or the structure).
 *
 * `folders` are the personal top-level folders; `placement` maps a collection id
 * to the folder it sits in (absent ⇒ at the root). Deleting a folder moves its
 * collections back to the root.
 */

import { useCallback, useEffect, useState } from 'react';
import { Backend } from '../utils/backend';
import { useServerSession } from './serverSessionStore';
import { encryptString, decryptString } from '../utils/vaultCrypto';

export interface LibraryFolder {
  id: string;
  name: string;
  color: string | null;
}

interface LibraryTreeData {
  folders: LibraryFolder[];
  placement: Record<string, string>; // collectionId → folderId
}

const EMPTY: LibraryTreeData = { folders: [], placement: {} };
const rid = () => 'lf-' + Math.random().toString(36).slice(2, 9);

async function decryptTree(key: Uint8Array, blob: string): Promise<LibraryTreeData> {
  const data = JSON.parse(new TextDecoder().decode(await decryptString(key, blob))) as LibraryTreeData;
  return { folders: data.folders ?? [], placement: data.placement ?? {} };
}

function encryptTree(key: Uint8Array, tree: LibraryTreeData): Promise<string> {
  return encryptString(key, new TextEncoder().encode(JSON.stringify(tree)));
}

export interface LibraryTree {
  folders: LibraryFolder[];
  placement: Record<string, string>;
  createFolder: (name: string, color: string | null) => Promise<void>;
  renameFolder: (id: string, name: string, color: string | null) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  moveCollection: (collectionId: string, folderId: string | null) => Promise<void>;
  reload: () => Promise<void>;
}

export function useLibraryTree(): LibraryTree {
  const { userKey } = useServerSession();
  const [tree, setTree] = useState<LibraryTreeData>(EMPTY);

  const load = useCallback(async () => {
    if (!userKey) return;
    try {
      const { blob } = await Backend.Library.get();
      setTree(blob ? await decryptTree(userKey, blob) : EMPTY);
    } catch {
      // No library yet / undecryptable — start empty rather than fail the tree.
      setTree(EMPTY);
    }
  }, [userKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    load();
  }, [load]);

  const persist = useCallback(
    async (next: LibraryTreeData) => {
      setTree(next);
      if (userKey) await Backend.Library.set(await encryptTree(userKey, next));
    },
    [userKey],
  );

  const createFolder = (name: string, color: string | null) =>
    persist({ ...tree, folders: [...tree.folders, { id: rid(), name, color }] });

  const renameFolder = (id: string, name: string, color: string | null) =>
    persist({ ...tree, folders: tree.folders.map((f) => (f.id === id ? { ...f, name, color } : f)) });

  const deleteFolder = (id: string) =>
    persist({
      folders: tree.folders.filter((f) => f.id !== id),
      placement: Object.fromEntries(Object.entries(tree.placement).filter(([, fid]) => fid !== id)),
    });

  const moveCollection = (collectionId: string, folderId: string | null) => {
    const placement = { ...tree.placement };
    if (folderId) placement[collectionId] = folderId;
    else delete placement[collectionId];
    return persist({ ...tree, placement });
  };

  return {
    folders: tree.folders,
    placement: tree.placement,
    createFolder,
    renameFolder,
    deleteFolder,
    moveCollection,
    reload: load,
  };
}
