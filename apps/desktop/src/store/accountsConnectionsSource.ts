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
import { unwrapTeamKey } from '../utils/teamCrypto';
import { unwrapCollectionKey, decryptCollectionField, encryptCollectionField } from '../utils/collectionCrypto';
import type { CollectionRole } from '../utils/backend';

/** The connection fields sealed into a per-user or team blob (browser-crypto). */
interface StoredRecord {
  name: string;
  protocol: string;
  hostname: string;
  port: number;
  username: string;
  authMethod:
    | { type: 'password'; password: string }
    | { type: 'publicKey'; keyPath: string; passphrase?: string };
  color: string | null;
  icon: string | null;
  folder: string | null;
  notes: string | null;
  sshKeepAliveOverride: string | null;
  sshKeepAliveInterval: number | null;
}

/** A decrypted connection kept in RAM: its record plus, if shared, its scope. */
interface Entry {
  record: StoredRecord;
  teamId?: string; // present ⇒ team-shared (team key)
  collectionId?: string; // present ⇒ collection-shared (collection key, ADR 0016)
}

/** The unwrapped key + my role for a collection I can read (kept in RAM). */
interface CollectionCtx {
  key: Uint8Array;
  role: CollectionRole;
}

/** The header a collection's `nameEnc` decrypts to (ADR 0016). */
interface CollectionHeader {
  name: string;
  color: string | null;
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
    createdAt,
    updatedAt,
    lastUsedAt: null,
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
  return merged;
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
  const entries = useRef<Map<string, Entry>>(new Map());
  const collections = useRef<Map<string, CollectionCtx>>(new Map());

  const refresh = useCallback(async () => {
    if (!userKey) return;
    const map = new Map<string, Entry>();
    const infos: ConnectionInfo[] = [];

    // Personal connections (per-user vault, userKey).
    try {
      for (const b of await Backend.Vault.connections()) {
        try {
          const record = await decryptRecord(userKey, b.blob);
          map.set(b.id, { record });
          infos.push(toInfo(b.id, record, b.createdAt, b.updatedAt, null));
        } catch {
          // A blob we cannot decrypt (key mismatch) — skip it rather than fail.
        }
      }
    } catch {
      // Vault endpoint unavailable — no personal connections in this context.
    }

    // Team-shared connections: only teams the user holds a key for are readable.
    if (publicKey && privateKey) {
      const teams = await Backend.Teams.mine()
        .then((all) => all.filter((t) => t.protectedTeamKey))
        .catch(() => []);
      for (const team of teams) {
        if (!team.protectedTeamKey) continue;
        try {
          const teamKey = await unwrapTeamKey(publicKey, privateKey, team.protectedTeamKey);
          for (const b of await Backend.Teams.connections(team.id)) {
            try {
              const record = await decryptRecord(teamKey, b.blob);
              map.set(b.id, { record, teamId: team.id });
              infos.push(toInfo(b.id, record, b.createdAt, b.updatedAt, team.name));
            } catch {
              // Undecryptable shared blob — skip.
            }
          }
        } catch {
          // Team key or connections unavailable — skip this team.
        }
      }
    }

    // Collection-shared connections (ADR 0016): only collections I hold a sealed
    // key for are readable. The collection's name/colour and its items are all
    // browser-decrypted; the server only ever saw opaque blobs.
    if (publicKey && privateKey) {
      const cols = await Backend.Collections.mine()
        .then((all) => all.filter((c) => c.protectedCollectionKey))
        .catch(() => []);
      const ctx = new Map<string, CollectionCtx>();
      for (const col of cols) {
        if (!col.protectedCollectionKey) continue;
        try {
          const key = await unwrapCollectionKey(publicKey, privateKey, col.protectedCollectionKey);
          const header = await decryptCollectionField<CollectionHeader>(key, col.nameEnc).catch(
            () => ({ name: 'Collection', color: null }) as CollectionHeader,
          );
          ctx.set(col.id, { key, role: col.role });
          for (const it of await Backend.Collections.items(col.id)) {
            try {
              const record = await decryptCollectionField<StoredRecord>(key, it.blob);
              map.set(it.id, { record, collectionId: col.id });
              infos.push(toInfo(it.id, record, it.createdAt, it.updatedAt, header.name));
            } catch {
              // Undecryptable item — skip.
            }
          }
        } catch {
          // Collection key or items unavailable — skip this collection.
        }
      }
      collections.current = ctx;
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
    // is never persisted server-side (ADR 0011 / 0012 client-execute).
    return Backend.Terminal.quickSshConnect(
      record.hostname,
      record.username,
      record.port,
      record.authMethod,
    );
  }, []);

  const remove = useCallback(
    async (id: string) => {
      const entry = entries.current.get(id);
      if (!entry) return;
      if (entry.collectionId) {
        const ctx = collections.current.get(entry.collectionId);
        if (!ctx || !canWrite(ctx.role)) throw new Error('you do not have write access to this collection');
        await Backend.Collections.deleteItem(entry.collectionId, id);
      } else if (entry.teamId) {
        await Backend.Teams.deleteConnection(entry.teamId, id);
      } else {
        await Backend.Vault.deleteConnection(id);
      }
      await refresh();
    },
    [refresh],
  );

  const create = useCallback(
    async (input: CreateConnectionInput) => {
      if (!userKey) throw new Error('vault is locked');
      const blob = await encryptRecord(userKey, recordFromCreate(input));
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
      if (entry.teamId) throw new Error('editing a team connection is not supported here yet');
      const blob = await encryptRecord(userKey, applyUpdate(entry.record, input));
      await Backend.Vault.updateConnection(input.id, blob);
      await refresh();
    },
    [userKey, refresh],
  );

  return { connections, selectedConnectionId, refresh, select, remove, connect, create, update };
}
