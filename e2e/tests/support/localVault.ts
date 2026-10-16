/**
 * Helpers for a local vault (ADR 0018).
 *
 * Machines live in collections now, so a test that needs one creates the
 * collection first — there is no Personal to fall back on and no loose machines.
 * Everything goes through /api/local/*, where rite-core decrypts with the master
 * key and answers in plaintext over loopback; the zero-knowledge endpoints are the
 * server ones, which these deliberately are not.
 */

import { expect, type APIRequestContext } from '@playwright/test';
import { resolve } from 'node:path';

export const SSH = {
  hostname: '127.0.0.1',
  port: 2222,
  username: 'riteuser',
  password: 'ritepass123',
  /**
   * The key pairs `e2e/sshd-setup.sh` generates and puts in the harness user's
   * `authorized_keys` — one with a passphrase and one without, because "ask at connect
   * time" and "never prompt for a key that has none" are two different behaviours.
   *
   * Generated rather than committed: a private key in a public repository is a finding
   * whatever it opens. Absent until `sh e2e/harness-up.sh` has run.
   */
  keyPlain: resolve(__dirname, '../../.keys/e2e_plain'),
  keyLocked: resolve(__dirname, '../../.keys/e2e_locked'),
  keyPassphrase: 'rite-e2e-passphrase',
};

/** Create a collection and return its id. */
export async function createCollection(api: APIRequestContext, name: string): Promise<string> {
  const res = await api.post('/api/local/collections', { data: { name } });
  expect(res.ok(), `creating collection ${name}: ${res.status()}`).toBeTruthy();
  return (await res.json()).id as string;
}

/** Reuse a collection with this name if the vault already has one. */
export async function ensureCollection(api: APIRequestContext, name: string): Promise<string> {
  const res = await api.get('/api/local/collections');
  expect(res.ok()).toBeTruthy();
  const found = ((await res.json()) as { id: string; name: string }[]).find((c) => c.name === name);
  return found ? found.id : createCollection(api, name);
}

export interface MachineOpts {
  name: string;
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
  /** Authenticate with a key file at this path instead of a password (ADR 0024). */
  keyPath?: string;
  /** The key's passphrase, when it is stored. */
  passphrase?: string;
  preconnect?: string | null;
  jump?: string | null;
  folder?: string | null;
  forwards?: { forwardType: string; localPort: number; remoteHost: string; remotePort: number }[];
}

/** Add a machine to a collection; returns its item id (what the UI addresses it by). */
export async function createMachine(
  api: APIRequestContext,
  collectionId: string,
  o: MachineOpts,
): Promise<string> {
  const res = await api.post(`/api/local/collections/${collectionId}/machines`, {
    data: {
      name: o.name,
      protocol: 'ssh',
      hostname: o.hostname ?? SSH.hostname,
      port: o.port ?? SSH.port,
      username: o.username ?? SSH.username,
      authMethod: o.keyPath
        ? { type: 'publicKey', keyPath: o.keyPath, ...(o.passphrase ? { passphrase: o.passphrase } : {}) }
        : { type: 'password', password: o.password ?? SSH.password },
      color: null,
      icon: null,
      folder: o.folder ?? null,
      notes: null,
      sshKeepAliveOverride: null,
      sshKeepAliveInterval: null,
      preconnect: o.preconnect ?? null,
      jump: o.jump ?? null,
      forwards: o.forwards ?? [],
      hc: null,
    },
  });
  expect(res.ok(), `creating machine ${o.name}: ${res.status()}`).toBeTruthy();
  return (await res.json()).id as string;
}

/** A collection's machines, as the UI receives them (credential-free). */
export async function listMachines(
  api: APIRequestContext,
  collectionId: string,
): Promise<Record<string, unknown>[]> {
  const res = await api.get(`/api/local/collections/${collectionId}/machines`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** Create a collection and one machine in it — the common setup. */
export async function collectionWithMachine(
  api: APIRequestContext,
  collectionName: string,
  machine: MachineOpts,
): Promise<{ collectionId: string; machineId: string }> {
  const collectionId = await ensureCollection(api, collectionName);
  const machineId = await createMachine(api, collectionId, machine);
  return { collectionId, machineId };
}
