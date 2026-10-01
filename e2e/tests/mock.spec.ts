import { test, expect, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * The UX mock, checked the way the app is.
 *
 * `design/mock` is the source of truth for UI/UX, and it is plain HTML opened from
 * disk — so nothing has ever told anyone when it broke. That is not theoretical: the
 * web UI shipped a dashboard nobody had decided on precisely because `web.html` was
 * silent about it and no one noticed (ADR 0019).
 *
 * So the two entry pages now share machine.js / machine.css, and this spec holds them
 * to it: the same cards in both shells, a Board that opens, not one console error, and
 * the precedence table from the ADR walked row by row rather than trusted.
 */

const mock = (name: string) => pathToFileURL(resolve(__dirname, `../../design/mock/${name}.html`)).href;

/** Fail on anything the page logged as an error — a mock that throws is a broken mock. */
function watchErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`));
  return errs;
}

const CARDS = ['Overview', 'Port forwarding', 'Containers', 'Services'];

for (const shell of ['web', 'desktop'] as const) {
  test(`${shell} mock: the machine dashboard and the Board render, with no console errors`, async ({ page }) => {
    const errs = watchErrors(page);
    await page.goto(mock(shell));

    // The dashboard is shell-agnostic: same cards, same order, from the shared file.
    await page.evaluate(() => openMachine('web-01'));
    await expect(page.locator('.dcard .dcard-t')).toHaveText(CARDS);

    // The Board touches no host, so it is ungoverned and present in both shells.
    await page.evaluate(() => dlgBoard(find('c-prod')));
    await expect(page.locator('.btile, .brow').first()).toBeVisible();
    expect(await page.locator('.btile, .brow').count()).toBeGreaterThan(0);

    expect(errs, 'the mock must not log errors').toEqual([]);
  });
}

/**
 * ADR 0019 §5, walked. Each row is the whole statement: who is asked, what each one
 * answered, and what the dashboard does — so a change to the rule has to change this
 * table too, instead of quietly changing what renders.
 */
const ROWS: { shell: 'web' | 'desktop'; ctx?: string; policy: { webui: boolean; clients: boolean }; user: boolean; verdict: string }[] = [
  { shell: 'desktop', ctx: 'vault',  policy: { webui: false, clients: false }, user: true,  verdict: 'run' },
  { shell: 'desktop', ctx: 'vault',  policy: { webui: true,  clients: true },  user: false, verdict: 'off by you' },
  { shell: 'desktop', ctx: 'server', policy: { webui: true,  clients: true },  user: true,  verdict: 'run' },
  { shell: 'desktop', ctx: 'server', policy: { webui: true,  clients: false }, user: true,  verdict: 'off by server' },
  { shell: 'desktop', ctx: 'server', policy: { webui: true,  clients: false }, user: false, verdict: 'off by server' },
  { shell: 'desktop', ctx: 'server', policy: { webui: true,  clients: true },  user: false, verdict: 'off by you' },
  { shell: 'web',                    policy: { webui: true,  clients: true },  user: true,  verdict: 'run' },
  { shell: 'web',                    policy: { webui: false, clients: true },  user: true,  verdict: 'off by server' },
  { shell: 'web',                    policy: { webui: false, clients: true },  user: false, verdict: 'off by server' },
  { shell: 'web',                    policy: { webui: true,  clients: false }, user: false, verdict: 'off by you' },
];

test('both mocks resolve ADR 0019 §5 the same way, row for row', async ({ page }) => {
  const errs = watchErrors(page);
  let loaded: string | null = null;
  for (const row of ROWS) {
    if (loaded !== row.shell) {
      await page.goto(mock(row.shell));
      loaded = row.shell;
    }
    const got = await page.evaluate(
      ({ ctx, policy, user }) => {
        if (ctx) STATE.ctx = { type: ctx, name: 'Harness' };
        STATE.dashPolicy = { ...policy, minInterval: 30 };
        STATE.machineProbes = user;
        const v = probeVerdict();
        return v.allowed ? 'run' : `off by ${v.by}`;
      },
      { ctx: row.ctx ?? null, policy: row.policy, user: row.user },
    );
    const where = `${row.shell} · ${row.ctx ?? 'browser'} · policy ${JSON.stringify(row.policy)} · user ${row.user ? 'on' : 'off'}`;
    expect(got, where).toBe(row.verdict);

    // A refusal must also be visible on the dashboard, naming the side that refused —
    // the rule is only worth as much as what the reader is told.
    await page.evaluate(() => openMachine('web-01'));
    const probing = page.locator('.dcard .dcard-t', { hasText: /Containers|Services/ });
    if (row.verdict === 'run') {
      await expect(probing, where).toHaveCount(2);
      await expect(page.locator('.dnote'), where).toHaveCount(0);
    } else {
      await expect(probing, where).toHaveCount(0);
      await expect(page.locator('.dnote'), where).toContainText(
        row.verdict === 'off by server' ? /server turns/ : /off in your settings/,
      );
    }
  }
  expect(errs, 'the mock must not log errors').toEqual([]);
});
