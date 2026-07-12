import { test, expect } from '@playwright/test';
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

test('parse then import an ssh config', async ({ request }) => {
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

  // Import
  const imported = await request.post('/api/ssh-config/import', { data: { entries } });
  expect(imported.ok()).toBeTruthy();
  const conns = await imported.json();
  expect(conns.length).toBe(2);

  // The imported connections are now listed.
  const listed = await (await request.get('/api/connections')).json();
  const listedNames: string[] = listed.map((c: { name: string }) => c.name);
  expect(listedNames).toEqual(expect.arrayContaining(['web-e2e', 'db-e2e']));
});

test('default ssh config path is exposed', async ({ request }) => {
  const res = await request.get('/api/ssh-config/default-path');
  expect(res.ok()).toBeTruthy();
  const path = await res.json();
  expect(typeof path).toBe('string');
  expect(path).toContain('.ssh');
});
