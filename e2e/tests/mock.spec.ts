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

    // Every card token must resolve. `machine.css` spent its life referencing a
    // `--line` variable nobody ever defined, so `border: 1px solid var(--line)`
    // collapsed to `border-style: none` and the cards were drawn edgeless in both
    // shells — invisible to a spec that only ever read text.
    const border = await page.locator('.dcard').first().evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(border, 'the dashboard cards must actually have a border').not.toBe('0px');

    // The Board touches no host, so it is ungoverned and present in both shells.
    await page.evaluate(() => dlgBoard(find('c-prod')));
    await expect(page.locator('.btile, .brow').first()).toBeVisible();
    expect(await page.locator('.btile, .brow').count()).toBeGreaterThan(0);

    expect(errs, 'the mock must not log errors').toEqual([]);
  });
}

/**
 * The agent manager, in both shells.
 *
 * The selector is machine → tool → conversation, the manager is a view (so resuming
 * leaves it where it was), and an agent session is a pane that opens in a new tab.
 * Each case below is one that a silent UI gets wrong in a way that costs an hour:
 * a machine nobody asked about, a tool that is not there, a tool that is there and
 * cannot answer, and the one host Rite refuses to run an agent on at all.
 */
for (const shell of ['web', 'desktop'] as const) {
  test(`${shell} mock: the agent manager selects machine, then tool, then conversation`, async ({ page }) => {
    const errs = watchErrors(page);
    await page.goto(mock(shell));
    await page.evaluate(() => openAgents());

    // The manager opens on a machine that can answer — not on an empty one, and not
    // on the local entry in a browser, which can never answer.
    await page.evaluate(() => agentPickScope('web-01'));
    await expect(page.locator('.atool .dcard-t')).toHaveText(['Claude Code', 'Codex CLI', 'Gemini CLI']);
    await expect(page.locator('.arow')).toHaveCount(3);

    // A tool that is absent, and a tool that is present but cannot read its own
    // transcripts, both keep their block and say which they are. A session that
    // vanishes from a list is the failure this is here to prevent.
    await expect(page.locator('.atool.off')).toHaveCount(1);
    await expect(page.locator('.anote')).toContainText(/installed but its sessions could not be read/);

    // Discovery is one command per machine, so the view says when it was read.
    await expect(page.locator('.mdash-hd')).toContainText(/read /);

    // A machine nobody has probed is a state of its own, not an empty list.
    await page.evaluate(() => agentPickScope('Homelab'));
    await expect(page.locator('.aempty')).toHaveCount(1);
    await expect(page.locator('.arow')).toHaveCount(0);

    // The refusal is on screen, in both shells, with its reason.
    await page.evaluate(() => agentPickScope('@server'));
    await expect(page.locator('.dnote')).toContainText(/never runs an agent inside its own server container/);
    await expect(page.locator('.arow')).toHaveCount(0);

    expect(errs, 'the mock must not log errors').toEqual([]);
  });
}

/**
 * Resuming opens a PANE in a NEW TAB, and the manager survives it. This is the
 * question the mock exists to answer: an agent does not replace the list it was
 * chosen from, and does not split the pane the user was already working in.
 */
test('desktop mock: resuming an agent opens a pane beside the manager, not over it', async ({ page }) => {
  const errs = watchErrors(page);
  await page.goto(mock('desktop'));
  await page.evaluate(() => openAgents());
  await page.evaluate(() => agentPickScope('@local'));

  const before = await page.locator('.mtab').count();
  await page.locator('.arow', { hasText: 'Mock the agent manager' }).getByRole('button', { name: 'Resume' }).click();

  // One more tab, and the manager's own tab is still there to go back to.
  await expect(page.locator('.mtab')).toHaveCount(before + 1);
  await expect(page.locator('.mtab', { hasText: 'Agents' })).toHaveCount(1);

  // The pane shows the real CLI — the resume command the user never typed — and
  // identifies where it runs. Rebuilding a chat UI over a vendor's TUI would pin
  // the one thing that changes without notice (ADR 0003's lesson).
  await expect(page.locator('.termpane-hdr')).toContainText('Claude Code');
  await expect(page.locator('.term-body')).toContainText('claude --resume');

  // The id is never typed and always reachable: it is on the pane's own control.
  await expect(page.locator('.termpane-acts button[title^="Conversation id"]')).toHaveCount(1);

  expect(errs, 'the mock must not log errors').toEqual([]);
});

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
