/**
 * The accounts/web connection source (ADR 0014 phase 2).
 *
 * Backs the shared `Workspace` when the active context is a shared server. Unlike
 * the local vault (the server decrypts), here the **browser** holds the keys and
 * does all crypto:
 *
 * - personal connections are sealed with the per-user `userKey` (ADR 0011),
 * - team-shared connections with each team key the user holds (ADR 0013),
 *
 * and the server only ever stores/returns opaque `v1.*` blobs. Opening a
 * connection decrypts the target in the browser and hands it to the server to
 * execute (`quick-ssh`) — the saved secret is never persisted server-side in the
 * clear. Editing is personal-only for now; team edits stay in the team panel.
 */

import { useCallback, useRef, useState } from 'react';
import { Backend } from '../utils/backend';
import { useServerSession } from './serverSessionStore';
import {
  type ConnectionInfo,
  type ConnectionsSource,
  type CreateConnectionInput,
  type UpdateConnectionInput,
} from './connectionsStore';
import { encryptString, decryptString } from '../utils/vaultCrypto';
import { getLastUsed, recordLastUsed } from '../utils/lastUsed';
import {
  unwrapCollectionKeys,
  decryptCollectionField,
  encryptCollectionField,
  generateCollectionKeys,
  sealCollectionKey,
} from '../utils/collectionCrypto';
import type { CollectionRole, QuickEndpoint } from '../utils/backend';
import type { CollectionHeader, CollectionFolder } from '../utils/collectionHeader';
import { type BoardCard, parseBoard } from '../utils/board';

/**
 * Synthetic id for the personal vault surfaced as a "Personal" collection (ADR 0016
 * "no loose machines": every machine lives in a collection; personal = your own).
 * It is NOT a real ADR 0016 collection — storage stays the per-user vault, so it
 * a 1-member collection". So there is no synthetic vault anymore: a real "Personal"
 * collection is auto-provisioned (marked in its encrypted header) and any legacy
 * per-user vault connections are migrated into it once, so Personal behaves exactly
 * like any other collection (folders, sharing, …).
 */
const PERSONAL_COLLECTION_NAME = 'Personal';
const PERSONAL_COLLECTION_COLOR = '#7c9cf5';

/** The connection fields sealed into a per-user, team or collection blob (browser-crypto). */
export interface StoredRecord {
  name: string;
  protocol: string;
  hostname: string;
  port: number;
  username: string;
  authMethod:
    | { type: 'password'; password: string }
    | { type: 'publicKey'; keyPath: string; passphrase?: string }
    | { type: 'agent'; identity?: string; forward?: boolean };
  color: string | null;
  icon: string | null;
  folder: string | null;
  notes: string | null;
  sshKeepAliveOverride: string | null;
  sshKeepAliveInterval: number | null;
  // Pre-connect hook: a local command run before SSH opens. Sealed inside the blob.
  preconnect?: string | null;
  // Jump host (ProxyJump): the id of another connection to reach this one through.
  jump?: string | null;
  // Saved port forwards. Sealed inside the blob (non-secret metadata).
  forwards?: import('./connectionsStore').PortForwardConfig[];
  // Health-check opt-out (ADR 0017): false ⇒ never actively probe this machine.
  // Sealed inside the blob, so the opt-out is zero-knowledge like everything else.
  hc?: boolean | null;
}

/** A decrypted connection kept in RAM: its record plus, if shared, its scope. */
interface Entry {
  record: StoredRecord;
  collectionId?: string; // present ⇒ collection-shared (collection key, ADR 0016)
}

/** The unwrapped key + my role for a collection I can read (kept in RAM). */
interface CollectionCtx {
  key: Uint8Array;
  role: CollectionRole;
  // The collection's Board blob (opaque, itemsKey-encrypted), or null. Kept alongside
  // the key so the Board can be decrypted on demand without another round-trip.
  boardEnc: string | null;
}

function canWrite(role: CollectionRole): boolean {
  return role === 'owner' || role === 'editor';
}

function encryptRecord(key: Uint8Array, record: StoredRecord): Promise<string> {
  return encryptString(key, new TextEncoder().encode(JSON.stringify(record)));
}

async function decryptRecord(key: Uint8Array, blob: string): Promise<StoredRecord> {
  return JSON.parse(new TextDecoder().decode(await decryptString(key, blob))) as StoredRecord;
}

/**
 * Ensure the user's real "Personal" collection exists (ADR 0016: personal = a
 * 1-member collection) and drain any legacy per-user vault connections into it.
 * Returns the Personal collection id. Idempotent: once migrated the vault is empty,
 * and Personal is found by its header marker on later runs.
 */
async function ensurePersonalCollection(
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  userKey: Uint8Array,
): Promise<string | null> {
  let personalId: string | null = null;
  let personalItemsKey: Uint8Array | null = null;
  const mine = await Backend.Collections.mine().catch(() => []);
  for (const col of mine) {
    try {
      const { metaKey, itemsKey } = await unwrapCollectionKeys(publicKey, privateKey, col);
      const header = await decryptCollectionField<CollectionHeader>(metaKey, col.nameEnc);
      if (header.personal) {
        personalId = col.id;
        personalItemsKey = itemsKey;
        break;
      }
    } catch {
      // undecryptable header — skip
    }
  }
  if (!personalId || !personalItemsKey) {
    const { metaKey, itemsKey } = generateCollectionKeys();
    const nameEnc = await encryptCollectionField(metaKey, {
      name: PERSONAL_COLLECTION_NAME,
      color: PERSONAL_COLLECTION_COLOR,
      personal: true,
      folders: [],
    });
    // Personal is a single-user private space — never escrow it to the Admin group.
    // Admins have no roster to govern there, and the name is the user's business.
    const created = await Backend.Collections.create(
      nameEnc,
      await sealCollectionKey(publicKey, metaKey),
      await sealCollectionKey(publicKey, itemsKey),
    );
    personalId = created.id;
    personalItemsKey = itemsKey;
  }
  // Migrate any legacy vault connections into Personal (re-encrypt with its key,
  // then delete from the vault). Delete only after a successful create → no loss.
  try {
    for (const b of await Backend.Vault.connections()) {
      try {
        const record = await decryptRecord(userKey, b.blob);
        await Backend.Collections.createItem(personalId, await encryptCollectionField(personalItemsKey, record));
        await Backend.Vault.deleteConnection(b.id);
      } catch {
        // leave undecryptable/failed items in the vault rather than lose them
      }
    }
  } catch {
    // vault endpoint unavailable — nothing to migrate
  }
  return personalId;
}

function toInfo(
  id: string,
  r: StoredRecord,
  createdAt: number,
  updatedAt: number,
  folder: string | null,
): ConnectionInfo {
  return {
    id,
    name: r.name,
    protocol: r.protocol,
    hostname: r.hostname,
    port: r.port,
    username: r.username,
    authType: r.authMethod.type,
    color: r.color,
    icon: r.icon,
    folder: folder ?? r.folder ?? null,
    notes: r.notes,
    sshKeepAliveOverride: r.sshKeepAliveOverride,
    sshKeepAliveInterval: r.sshKeepAliveInterval,
    preconnect: r.preconnect ?? null,
    jump: r.jump ?? null,
    forwards: r.forwards ?? [],
    hc: r.hc ?? null,
    createdAt,
    updatedAt,
    // Passive "last seen" is this user's own local record (ADR 0017) — never server-side.
    lastUsedAt: getLastUsed(id),
  };
}

function recordFromCreate(input: CreateConnectionInput): StoredRecord {
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

/** Merge a partial update onto an existing record (undefined fields untouched). */
function applyUpdate(base: StoredRecord, input: UpdateConnectionInput): StoredRecord {
  const merged = { ...base };
  if (input.name !== undefined) merged.name = input.name;
  if (input.protocol !== undefined) merged.protocol = input.protocol;
  if (input.hostname !== undefined) merged.hostname = input.hostname;
  if (input.port !== undefined) merged.port = input.port;
  if (input.username !== undefined) merged.username = input.username;
  if (input.authMethod !== undefined) merged.authMethod = input.authMethod;
  if (input.color !== undefined) merged.color = input.color;
  if (input.icon !== undefined) merged.icon = input.icon;
  if (input.folder !== undefined) merged.folder = input.folder;
  if (input.notes !== undefined) merged.notes = input.notes;
  if (input.sshKeepAliveOverride !== undefined) merged.sshKeepAliveOverride = input.sshKeepAliveOverride;
  if (input.sshKeepAliveInterval !== undefined) merged.sshKeepAliveInterval = input.sshKeepAliveInterval;
  if (input.preconnect !== undefined) merged.preconnect = input.preconnect;
  if (input.jump !== undefined) merged.jump = input.jump;
  if (input.forwards !== undefined) merged.forwards = input.forwards;
  if (input.hc !== undefined) merged.hc = input.hc;
  return merged;
}

/** The endpoint shape the server takes for an ad-hoc target or hop. */
function endpointOf(record: StoredRecord): QuickEndpoint {
  return {
    host: record.hostname,
    port: record.port,
    username: record.username,
    authMethod: record.authMethod,
  };
}

/**
 * Walk a connection's ProxyJump chain and return the hops as decrypted endpoints,
 * outermost-first — the order the transport establishes them in.
 *
 * The vault path resolves this in rite-core, which can decrypt its own rows. Here
 * the server only holds opaque blobs, so the browser — the only side with the keys
 * — has to resolve the chain and hand over the hops. Cycle-guarded and depth-capped
 * like the core resolver; a hop that points at a connection this user can't read is
 * an error rather than a silent direct connection.
 */
function resolveJumpChain(entries: Map<string, Entry>, record: StoredRecord): QuickEndpoint[] {
  const MAX_HOPS = 10;
  const hops: QuickEndpoint[] = [];
  const seen = new Set<string>();
  let next = record.jump?.trim() || null;

  while (next) {
    if (seen.has(next)) throw new Error(`jump-host chain has a cycle at ${next}`);
    seen.add(next);
    if (hops.length >= MAX_HOPS) throw new Error(`jump-host chain too deep (> ${MAX_HOPS} hops)`);
    const hop = entries.get(next);
    if (!hop) throw new Error('a jump host on this connection is not available to you');
    hops.push(endpointOf(hop.record));
    next = hop.record.jump?.trim() || null;
  }

  // Nearest-jump-first → outermost first.
  return hops.reverse();
}

/**
 * The browser-crypto connection source for an accounts session. Merges the
 * per-user vault with every team the user holds a key for; keeps the decrypted
 * records in a ref so `connect` can hand the plaintext target to the server.
 */
export function useAccountsConnectionsSource(): ConnectionsSource {
  const { userKey, publicKey, privateKey } = useServerSession();
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [writableCollections, setWritableCollections] = useState<{ id: string; name: string }[]>([]);
  const [collectionList, setCollectionList] = useState<
    { id: string; name: string; color: string | null; role: string; folders: CollectionFolder[]; memberCount: number; isPersonal: boolean; hc: boolean | null; hasBoard: boolean }[]
  >([]);
  const entries = useRef<Map<string, Entry>>(new Map());
  const collections = useRef<Map<string, CollectionCtx>>(new Map());

  const refresh = useCallback(async () => {
    if (!userKey || !publicKey || !privateKey) return;
    const map = new Map<string, Entry>();
    const infos: ConnectionInfo[] = [];

    // Personal = a real 1-member collection (ADR 0016): ensure it exists and drain
    // any legacy vault connections into it. It's then loaded like any collection.
    const personalId = await ensurePersonalCollection(publicKey, privateKey, userKey);

    // Collection-shared connections (ADR 0016): only collections I hold a sealed
    // key for are readable. The collection's name/colour and its items are all
    // browser-decrypted; the server only ever saw opaque blobs.
    if (publicKey && privateKey) {
      const cols = await Backend.Collections.mine()
        .then((all) => all.filter((c) => c.protectedMetaKey))
        .catch(() => []);
      const ctx = new Map<string, CollectionCtx>();
      const writable: { id: string; name: string; isPersonal: boolean }[] = [];
      // Every readable collection (including empty ones), so the tree can show a
      // node before it has any machine. Personal is one of them (marked).
      const list: { id: string; name: string; color: string | null; role: string; folders: CollectionFolder[]; memberCount: number; isPersonal: boolean; hc: boolean | null; hasBoard: boolean }[] = [];
      for (const col of cols) {
        if (!col.protectedMetaKey) continue;
        try {
          const { metaKey, itemsKey } = await unwrapCollectionKeys(publicKey, privateKey, col);
          const header = await decryptCollectionField<CollectionHeader>(metaKey, col.nameEnc).catch(
            () => ({ name: 'Collection', color: null }) as CollectionHeader,
          );
          const isPersonal = col.id === personalId;
          // The context holds the itemsKey for item reads/writes (ADR 0016 split). A
          // roster-only member (admin meta-add) has no itemsKey → the collection shows
          // its name in the tree but carries no machines until a member seals access.
          if (itemsKey) ctx.set(col.id, { key: itemsKey, role: col.role, boardEnc: col.boardEnc ?? null });
          const memberCount = (await Backend.Collections.members(col.id).catch(() => [])).length;
          list.push({
            id: col.id,
            name: isPersonal ? PERSONAL_COLLECTION_NAME : header.name,
            color: header.color,
            role: col.role,
            folders: header.folders ?? [],
            memberCount,
            isPersonal,
            hc: header.hc ?? null,
            hasBoard: !!col.boardEnc,
          });
          if (canWrite(col.role)) writable.push({ id: col.id, name: isPersonal ? PERSONAL_COLLECTION_NAME : header.name, isPersonal });
          if (itemsKey)
            for (const it of await Backend.Collections.items(col.id)) {
              try {
                const record = await decryptCollectionField<StoredRecord>(itemsKey, it.blob);
                map.set(it.id, { record, collectionId: col.id });
                // folder stays the record's own (a shared folder inside the collection);
                // the collection itself is carried as first-class metadata for the tree.
                infos.push({
                  ...toInfo(it.id, record, it.createdAt, it.updatedAt, record.folder),
                  collectionId: col.id,
                  collectionName: header.name,
                  collectionColor: header.color,
                  collectionRole: col.role,
                });
              } catch {
                // Undecryptable item — skip.
              }
            }
        } catch {
          // Collection key or items unavailable — skip this collection.
        }
      }
      collections.current = ctx;
      // Personal sorts first, then by name.
      const byPersonalThenName = <T extends { isPersonal: boolean; name: string }>(a: T, b: T) =>
        a.isPersonal ? -1 : b.isPersonal ? 1 : a.name.localeCompare(b.name);
      setCollectionList([...list].sort(byPersonalThenName));
      setWritableCollections([...writable].sort(byPersonalThenName).map(({ id, name }) => ({ id, name })));
    }

    entries.current = map;
    setConnections(infos);
  }, [userKey, publicKey, privateKey]);

  const select = useCallback((id: string | null) => setSelectedConnectionId(id), []);

  const connect = useCallback(async (conn: ConnectionInfo): Promise<string> => {
    const entry = entries.current.get(conn.id);
    if (!entry) throw new Error('connection is not available');
    const { record } = entry;
    // Server-execute: the decrypted target is handed to the server to run SSH; it
    // is never persisted server-side (ADR 0011 / 0012 client-execute). The jump
    // chain travels with it — the server can't resolve hops it can't decrypt.
    const sessionId = await Backend.Terminal.quickSshConnect(
      record.hostname,
      record.username,
      record.port,
      record.authMethod,
      resolveJumpChain(entries.current, record),
    );
    // Record this user's own "last connected" locally (passive status, ADR 0017).
    recordLastUsed(conn.id);
    return sessionId;
  }, []);

  const remove = useCallback(
    async (id: string) => {
      const entry = entries.current.get(id);
      if (!entry) return;
      if (entry.collectionId) {
        const ctx = collections.current.get(entry.collectionId);
        if (!ctx || !canWrite(ctx.role)) throw new Error('you do not have write access to this collection');
        await Backend.Collections.deleteItem(entry.collectionId, id);
      } else {
        await Backend.Vault.deleteConnection(id);
      }
      await refresh();
    },
    [refresh],
  );

  const create = useCallback(
    async (input: CreateConnectionInput) => {
      const record = recordFromCreate(input);
      // Every machine lives in a collection (ADR 0016 — Personal is a real one).
      // Collection writes are gated on owner/editor.
      if (input.collectionId) {
        const ctx = collections.current.get(input.collectionId);
        if (!ctx || !canWrite(ctx.role)) throw new Error('you do not have write access to this collection');
        const blob = await encryptCollectionField(ctx.key, record);
        await Backend.Collections.createItem(input.collectionId, blob);
        await refresh();
        return;
      }
      // No target (shouldn't happen in the accounts UI) → legacy per-user vault.
      if (!userKey) throw new Error('vault is locked');
      const blob = await encryptRecord(userKey, record);
      await Backend.Vault.createConnection(blob);
      await refresh();
    },
    [userKey, refresh],
  );

  const update = useCallback(
    async (input: UpdateConnectionInput) => {
      if (!userKey) throw new Error('vault is locked');
      const entry = entries.current.get(input.id);
      if (!entry) throw new Error('connection is not available');
      if (entry.collectionId) {
        const ctx = collections.current.get(entry.collectionId);
        if (!ctx || !canWrite(ctx.role)) throw new Error('you do not have write access to this collection');
        const blob = await encryptCollectionField(ctx.key, applyUpdate(entry.record, input));
        await Backend.Collections.updateItem(entry.collectionId, input.id, blob);
        await refresh();
        return;
      }
      const blob = await encryptRecord(userKey, applyUpdate(entry.record, input));
      await Backend.Vault.updateConnection(input.id, blob);
      await refresh();
    },
    [userKey, refresh],
  );

  // Read a collection's Board: decrypt its stored blob with the itemsKey I hold. No
  // blob (or no key) → an empty board. Malformed content is dropped defensively.
  const readBoard = useCallback(async (collectionId: string): Promise<BoardCard[]> => {
    const ctx = collections.current.get(collectionId);
    if (!ctx || !ctx.boardEnc) return [];
    try {
      return parseBoard(await decryptCollectionField<unknown>(ctx.key, ctx.boardEnc));
    } catch {
      return [];
    }
  }, []);

  // Save a collection's Board: re-encrypt the whole board with the itemsKey and
  // persist it (editor+). An empty board clears the stored blob. Refreshes after.
  const saveBoard = useCallback(
    async (collectionId: string, cards: BoardCard[]) => {
      const ctx = collections.current.get(collectionId);
      if (!ctx) throw new Error('collection is not available');
      if (!canWrite(ctx.role)) throw new Error('you do not have write access to this collection');
      const blob = cards.length ? await encryptCollectionField(ctx.key, cards) : null;
      await Backend.Collections.setBoard(collectionId, blob);
      // Keep the in-RAM copy in sync so an immediate re-open shows the change even
      // before the async refresh completes.
      ctx.boardEnc = blob;
      await refresh();
    },
    [refresh],
  );

  // Accounts path: the browser holds the decrypted target, so it hands it to the
  // server to exec (client-execute, like connect). Jump chain isn't carried yet.
  const execRemote = useCallback(async (conn: ConnectionInfo, command: string) => {
    const entry = entries.current.get(conn.id);
    if (!entry) throw new Error('connection is not available');
    const { record } = entry;
    return Backend.Terminal.machineExecQuick(
      { ...endpointOf(record), jumps: resolveJumpChain(entries.current, record) },
      command,
    );
  }, []);

  // Port forwards on an accounts connection: same client-execute shape as connect —
  // the target and its hops are only readable here, so they travel on the request.
  const startForward = useCallback<NonNullable<ConnectionsSource['startForward']>>(
    async (conn, forward) => {
      const entry = entries.current.get(conn.id);
      if (!entry) throw new Error('connection is not available');
      const { record } = entry;
      return Backend.Terminal.startQuickForward({
        connectionId: conn.id,
        target: { ...endpointOf(record), jumps: resolveJumpChain(entries.current, record) },
        bindHost: forward.bindHost ?? undefined,
        localPort: forward.localPort,
        remoteHost: forward.remoteHost,
        remotePort: forward.remotePort,
      });
    },
    [],
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
    writableCollections,
    collections: collectionList,
    readBoard,
    saveBoard,
    execRemote,
    startForward,
  };
}
