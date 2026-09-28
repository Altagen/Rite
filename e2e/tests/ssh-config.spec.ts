import { test, expect } from '@playwright/test';
import { createCollection, createMachine, listMachines } from './support/localVault';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * ssh-config import parity: parse an OpenSSH config and import selected hosts as
 * connections. Playwright and rite-server share the container filesystem, so the
 * server reads the temp config the test writes. (get_default_ssh_config_path is
 * covered too.)
 */

const CONFIG = `Host web-e2e
    HostName 10.0.0.5
    User deploy
    Port 2222

Host db-e2e
    HostName 10.0.0.6
    User admin
`;

test('parse an ssh config, then import its hosts into a collection', async ({ request }) => {
  const dir = mkdtempSync(join(tmpdir(), 'rite-e2e-ssh-'));
  const configPath = join(dir, 'config');
  writeFileSync(configPath, CONFIG);

  // Parse
  const parsed = await request.post('/api/ssh-config/parse', { data: { configPath } });
  expect(parsed.ok()).toBeTruthy();
  const entries = await parsed.json();
  const hosts = entries.map((e: { host: string }) => e.host);
  expect(hosts).toContain('web-e2e');
  expect(hosts).toContain('db-e2e');
  const web = entries.find((e: { host: string }) => e.host === 'web-e2e');
  expect(web.hostname).toBe('10.0.0.5');
  expect(web.user).toBe('deploy');
  expect(web.port).toBe(2222);

  // Import. Parsing is server-side because the file lives there, but creating goes
  // through the ordinary machine path now (ADR 0018) — an imported host is stored
  // exactly like a hand-made one, inside a collection the user picks.
  const collectionId = await createCollection(request, 'e2e-ssh-config');
  for (const e of entries as { host: string; hostname: string | null; user: string | null; port: number | null }[]) {
    await createMachine(request, collectionId, {
      name: e.host,
      hostname: e.hostname ?? e.host,
      port: e.port ?? 22,
      username: e.user ?? '',
    });
  }

  const listed = await listMachines(request, collectionId);
  const listedNames = listed.map((c) => c.name);
  expect(listedNames).toEqual(expect.arrayContaining(['web-e2e', 'db-e2e']));
  // Parsed detail survives into the stored machine.
  const stored = listed.find((c) => c.name === 'web-e2e')!;
  expect(stored.hostname).toBe('10.0.0.5');
  expect(stored.port).toBe(2222);
});

test('default ssh config path is exposed', async ({ request }) => {
  const res = await request.get('/api/ssh-config/default-path');
  expect(res.ok()).toBeTruthy();
  const path = await res.json();
  expect(typeof path).toBe('string');
  expect(path).toContain('.ssh');
});
