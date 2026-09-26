/**
 * The local vault's connection source (ADR 0018).
 *
 * A vault holds collections exactly as a server does, so the sidebar, the
 * collection views and the Board all work the same in both contexts. What differs
 * is where the decryption happens: rite-core owns the master key and answers in
 * plaintext over loopback, so nothing in this file holds a key and no machine it
 * receives carries credentials — `authType` says how a machine authenticates, never
 * with what. Connecting stays "by id"; the core resolves and decrypts.
 *
 * Contrast `accountsConnectionsSource`, which is the zero-knowledge mirror of this:
 * there the browser holds the keys because the server must not.
 */

import { useCallback, useRef, useState } from 'react';
import { Backend, type LocalCollection } from '../utils/backend';
import {
  type ConnectionInfo,
  type ConnectionsSource,
  type CreateConnectionInput,
  type UpdateConnectionInput,
} from './connectionsStore';
import { type BoardCard, parseBoard } from '../utils/board';

/** True for `path` itself and anything nested under it. */
function underPath(folder: string | null | undefined, path: string): boolean {
  return folder === path || (folder?.startsWith(`${path}/`) ?? false);
}

/** The record shape stored inside a collection item — the browser's StoredRecord. */
function recordFromInput(input: CreateConnectionInput) {
  return {
    name: input.name,
    protocol: input.protocol,
    hostname: input.hostname,
    port: input.port,
    username: input.username,
    authMethod: input.authMethod,
    color: input.color ?? null,
    icon: input.icon ?? null,
    folder: input.folder ?? null,
    notes: input.notes ?? null,
    sshKeepAliveOverride: input.sshKeepAliveOverride ?? null,
    sshKeepAliveInterval: input.sshKeepAliveInterval ?? null,
    preconnect: input.preconnect ?? null,
    jump: input.jump ?? null,
    forwards: input.forwards ?? [],
    hc: input.hc ?? null,
  };
}

export function useLocalCollectionsSource(): ConnectionsSource {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [collectionList, setCollectionList] = useState<LocalCollection[]>([]);
  /** item id → which collection holds it, so update/delete know where to write. */
  const owner = useRef<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    const cols = await Backend.Local.collections();
    const all: ConnectionInfo[] = [];
    const where = new Map<string, string>();
    for (const c of cols) {
      for (const m of await Backend.Local.machines(c.id)) {
        where.set(m.id, c.id);
        all.push(m);
      }
    }
    owner.current = where;
    setCollectionList(cols);
    setConnections(all);
  }, []);

  const select = useCallback((id: string | null) => setSelectedConnectionId(id), []);

  const create = useCallback(
    async (input: CreateConnectionInput) => {
      // No loose machines (ADR 0016): a machine is always created inside a
      // collection, and a local vault has no Personal to fall back on.
      if (!input.collectionId) throw new Error('pick a collection for this machine');
      await Backend.Local.createMachine(input.collectionId, recordFromInput(input));
      await refresh();
    },
    [refresh],
  );

  const update = useCallback(
    async (input: UpdateConnectionInput) => {
      const collectionId = owner.current.get(input.id);
      if (!collectionId) throw new Error('connection is not available');
      // Send only what changed. The core merges onto the stored record, which is
      // the only way an edit that never saw the password can keep it — a machine
      // comes back with `authType` and never the credentials themselves.
      const { id: _id, ...patch } = input;
      await Backend.Local.updateMachine(collectionId, input.id, patch);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      const collectionId = owner.current.get(id);
      if (!collectionId) return;
      await Backend.Local.deleteMachine(collectionId, id);
      await refresh();
    },
    [refresh],
  );

  // Connecting is by id: the core resolves the machine, decrypts it and opens SSH,
  // so credentials never pass through here.
  const connect = useCallback(
    async (c: ConnectionInfo) => {
      const id = await Backend.Terminal.connectTerminal(c.id);
      void refresh(); // pick up the new "last used"
      return id;
    },
    [refresh],
  );

  const createCollection = useCallback(
    async (name: string, color: string | null, hc: boolean | null) => {
      const created = await Backend.Local.createCollection(name, color);
      // A fresh collection health-checks like the rest; only the opt-out has to be
      // written, and the header it lives in exists only once the collection does.
      if (hc === false) await Backend.Local.updateCollection({ id: created.id, name, color, hc });
      await refresh();
      return created.id;
    },
    [refresh],
  );

  const renameCollection = useCallback(
    async (id: string, name: string, color: string | null, hc: boolean | null) => {
      await Backend.Local.updateCollection({ id, name, color, hc });
      await refresh();
    },
    [refresh],
  );

  /**
   * Add or rename a folder. Folders live in the collection's encrypted header, which
   * the core rewrites — and a rename has to re-tag the machines under the old path
   * too, or they would keep pointing at a folder that no longer exists.
   */
  const saveFolder = useCallback(
    async ({
      collectionId,
      path,
      color,
      from,
    }: {
      collectionId: string;
      path: string;
      color: string | null;
      from?: string;
    }) => {
      const current = collectionList.find((c) => c.id === collectionId);
      if (!current) throw new Error('collection is not available');
      const folders = (current.folders ?? []).map((f) => ({
        name: f.name,
        color: f.color ?? null,
      }));
      const rewrite = (folder: string) =>
        folder === from ? path : `${path}${folder.slice(from!.length)}`;
      const next = from
        ? // Rename: move the folder and anything nested under it.
          folders.map((f) =>
            underPath(f.name, from) ? { name: rewrite(f.name), color: f.name === from ? color : f.color } : f,
          )
        : [...folders.filter((f) => f.name !== path), { name: path, color }];
      await Backend.Local.updateCollection({
        id: collectionId,
        name: current.name,
        color: current.color ?? null,
        folders: next,
      });
      if (from) {
        for (const c of connections) {
          if (c.collectionId === collectionId && underPath(c.folder, from)) {
            await Backend.Local.updateMachine(collectionId, c.id, { folder: rewrite(c.folder!) });
          }
        }
      }
      await refresh();
    },
    [collectionList, connections, refresh],
  );

  /**
   * Delete a folder. It leaves the header and everything that lived under it moves
   * up to its parent — the same rule as the accounts path, so a folder is never a
   * way to lose machines.
   */
  const deleteFolder = useCallback(
    async (collectionId: string, path: string) => {
      const current = collectionList.find((c) => c.id === collectionId);
      if (!current) throw new Error('collection is not available');
      const cut = path.lastIndexOf('/');
      const parent = cut === -1 ? null : path.slice(0, cut);
      const reparent = (folder: string) => {
        if (folder === path) return parent;
        const rest = folder.slice(path.length + 1);
        return parent ? `${parent}/${rest}` : rest;
      };
      await Backend.Local.updateCollection({
        id: collectionId,
        name: current.name,
        color: current.color ?? null,
        folders: (current.folders ?? [])
          .filter((f) => !underPath(f.name, path))
          .map((f) => ({ name: f.name, color: f.color ?? null })),
      });
      for (const c of connections) {
        if (c.collectionId === collectionId && underPath(c.folder, path)) {
          await Backend.Local.updateMachine(collectionId, c.id, { folder: reparent(c.folder!) });
        }
      }
      await refresh();
    },
    [collectionList, connections, refresh],
  );

  const deleteCollection = useCallback(
    async (id: string) => {
      await Backend.Local.deleteCollection(id);
      await refresh();
    },
    [refresh],
  );

  const readBoard = useCallback(async (collectionId: string): Promise<BoardCard[]> => {
    return parseBoard(await Backend.Local.board(collectionId));
  }, []);

  const saveBoard = useCallback(
    async (collectionId: string, cards: BoardCard[]) => {
      await Backend.Local.setBoard(collectionId, cards);
      await refresh();
    },
    [refresh],
  );

  return {
    connections,
    selectedConnectionId,
    refresh,
    select,
    remove,
    connect,
    create,
    update,
    // Every local collection is writable: there are no roles without members.
    writableCollections: collectionList.map((c) => ({ id: c.id, name: c.name })),
    collections: collectionList.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color ?? null,
      role: 'owner',
      folders: (c.folders ?? []).map((f) => ({ name: f.name, color: f.color ?? null })),
      memberCount: 1,
      // No Personal in a local vault (ADR 0018) — every collection is equal.
      isPersonal: false,
      hc: c.hc ?? null,
      hasBoard: c.hasBoard,
    })),
    createCollection,
    renameCollection,
    saveFolder,
    deleteFolder,
    deleteCollection,
    readBoard,
    saveBoard,
    execRemote: (c, command) => Backend.Terminal.machineExec(c.id, command),
    startForward: (c, f) =>
      Backend.Terminal.startForward({
        connectionId: c.id,
        bindHost: f.bindHost ?? undefined,
        localPort: f.localPort,
        remoteHost: f.remoteHost,
        remotePort: f.remotePort,
      }),
  };
}
