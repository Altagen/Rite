import { test, expect } from '@playwright/test';

/**
 * Context roster (ADR 0012). The native hub manages saved servers; the endpoints
 * behind it (add + list) are exercised here at the API level, because the roster
 * UI is native-only — the browser has no desktop shell, so there is no hub to
 * drive through the page. Switching to a server (the proxy) is covered end to end
 * by proxy.spec.ts / tls-proxy.spec.ts.
 */
test('a remote server can be added to the context roster', async ({ request }) => {
  const added = await request.post('/api/context/servers', {
    data: { url: 'http://127.0.0.1:9443', label: 'Team' },
  });
  expect(added.ok()).toBeTruthy();
  const server = await added.json();
  expect(server.url).toBe('http://127.0.0.1:9443');
  expect(server.label).toBe('Team');

  const ctx = await (await request.get('/api/context')).json();
  expect(ctx.active).toBe('local');
  expect(ctx.roster.some((s: { label: string }) => s.label === 'Team')).toBe(true);
});
