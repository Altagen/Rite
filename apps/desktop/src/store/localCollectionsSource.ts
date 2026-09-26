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
