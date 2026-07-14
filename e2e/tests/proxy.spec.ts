import { test, expect } from '@playwright/test';

/**
 * Context multiplexer proxy (ADR 0012 phase 2/3). The local server (:1424) adds
 * the remote accounts server (:1423) to its roster, switches to it, and logs in —
 * the whole /api flow is reverse-proxied to the remote (§2), the remote token
 * stays server-side, and remote terminals stream over the proxied WebSocket (§3).
 */

test.describe.configure({ mode: 'serial' });

test('connect to a remote server through the local proxy', async ({ page }) => {
  await page.goto('/');

  // The multiplexer's own local vault: first-run setup.
  const password = page.locator('#password');
  await expect(password).toBeVisible({ timeout: 15_000 });
  const strong = 'Local-Mux-Str0ng!pass';
  await password.fill(strong);
  await page.locator('#confirmPassword').fill(strong);
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText('Local Terminal')).toBeVisible({ timeout: 15_000 });

  // Add the remote server to the roster and switch to it.
  await page.getByRole('button', { name: /context/i }).click();
  await page.getByRole('button', { name: /add server/i }).click();
  await page.getByPlaceholder('https://rite.example.com').fill('http://127.0.0.1:1423');
  await page.getByPlaceholder('Label (optional)').fill('TeamServer');
  await page.getByRole('button', { name: /^add$/i }).click();
  await page.getByText('TeamServer').click(); // select → reboots proxied to the remote

  // Now proxied to :1423 → the remote's login (env-bootstrapped admin exists).
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 20_000 });
  await page.locator('#username').fill('envadmin');
  await page.locator('#password').fill('EnvPass123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // The proxied login lands on the remote's admin panel — served through the proxy.
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible({ timeout: 30_000 });
});

test('a remote terminal streams over the WebSocket proxy', async ({ page }) => {
  // The context is already remote (previous test switched it); sign in again.
  await page.goto('/');
  await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
  await page.locator('#username').fill('envadmin');
  await page.locator('#password').fill('EnvPass123!');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible({ timeout: 30_000 });

  // Drive a terminal ON THE REMOTE and listen on the proxied /ws — all same-origin
  // to :1424, which bridges to :1423's /ws.
  const result = await page.evaluate(async () => {
    const post = (path: string, body?: unknown) =>
      fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });

    const cr = await post('/api/terminal/local', { shell: '/usr/bin/bash' });
    if (!cr.ok) return `create-${cr.status}`;
    const { sessionId } = (await cr.json()) as { sessionId: string };

    const ws = new WebSocket(`ws://${location.host}/ws`);
    const got = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 15_000);
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data as string);
          if (m.event === 'terminal-data' && m.payload?.sessionId === sessionId) {
            clearTimeout(timer);
            resolve('got-terminal-data');
          }
        } catch {
          /* ignore */
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve('ws-error');
      };
    });

    await new Promise((r) => (ws.onopen = () => r(null)));
    // Give the proxy time to connect + subscribe to the remote's /ws.
    await new Promise((r) => setTimeout(r, 1000));
    await post(`/api/terminal/${sessionId}/claim`); // drain buffer → stream mode
    await post(`/api/terminal/${sessionId}/input`, {
      data: Array.from(new TextEncoder().encode('echo RITE_WS_PROXY\n')),
    });
    return got;
  });

  expect(result).toBe('got-terminal-data');
});
