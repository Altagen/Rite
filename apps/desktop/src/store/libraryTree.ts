/**
 * The per-user library tree (ADR 0016 view hierarchy): personal folders that
 * organise collections. It is a display-only tree — no permission inheritance —
 * kept as a blob encrypted with the user key and stored per-user on the server
 * (zero-knowledge: the server never sees folder names or the structure).
 *
 * `folders` are the personal organiser folders — each may nest under another via
 * `parent` (absent ⇒ top level); `placement` maps a collection id to the folder it
 * sits in (absent ⇒ at the root). Deleting a folder also deletes its descendant
 * folders and moves every affected collection back to the root.
 */

import { useCallback, useEffect, useState } from 'react';
import { Backend } from '../utils/backend';
import { useServerSession } from './serverSessionStore';
import { encryptString, decryptString } from '../utils/vaultCrypto';

export interface LibraryFolder {
  id: string;
  name: string;
  color: string | null;
  parent?: string | null; // parent folder id; absent/null ⇒ top level
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
  createFolder: (name: string, color: string | null, parent?: string | null) => Promise<void>;
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

  const createFolder = (name: string, color: string | null, parent?: string | null) =>
    persist({ ...tree, folders: [...tree.folders, { id: rid(), name, color, parent: parent ?? null }] });

  const renameFolder = (id: string, name: string, color: string | null) =>
    persist({ ...tree, folders: tree.folders.map((f) => (f.id === id ? { ...f, name, color } : f)) });

  const deleteFolder = (id: string) => {
    // Cascade to descendant folders; any collection under a removed folder returns
    // to the root (organiser folders hold no data, so nothing is lost).
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of tree.folders) {
        if (f.parent && doomed.has(f.parent) && !doomed.has(f.id)) {
          doomed.add(f.id);
          grew = true;
        }
      }
    }
    return persist({
      folders: tree.folders.filter((f) => !doomed.has(f.id)),
      placement: Object.fromEntries(Object.entries(tree.placement).filter(([, fid]) => !doomed.has(fid))),
    });
  };

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
