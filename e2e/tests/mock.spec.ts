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
 * An agent pane is a leaf of the ORDINARY split tree, so `watch docker ps` or `top`
 * can sit beside the agent that is causing them. Calling it a terminal and then
 * giving it a tab it cannot share would be the same mistake as rebuilding a chat
 * UI over a TUI: the word would be right and the thing would not.
 */
test('desktop mock: an agent pane splits with plain terminals, with the same chrome', async ({ page }) => {
  const errs = watchErrors(page);
  await page.goto(mock('desktop'));
  await page.evaluate(() => { openAgents(); agentPickScope('@local'); });
  await page.locator('.arow').first().getByRole('button', { name: 'Resume' }).click();

  // One pane, no divider yet.
  await expect(page.locator('.pane-wrap')).toHaveCount(1);
  await expect(page.locator('.pdiv')).toHaveCount(0);

  // Splitting from the agent's own header offers ordinary terminals on that machine.
  await page.locator('.agentpane button[title^="Split horizontal"]').click();
  await page.locator('.menu .row', { hasText: 'watch docker ps' }).click();

  // Two panes in ONE tab, separated by the divider a terminal split already uses.
  await expect(page.locator('.pane-wrap')).toHaveCount(2);
  await expect(page.locator('.pdiv')).toHaveCount(1);
  await expect(page.locator('.agentpane')).toHaveCount(1);
  await expect(page.locator('.termpane:not(.agentpane)')).toHaveCount(1);

  // Same chrome on both, because both get it from `paneActs` — the agent only adds
  // the one control that is its own, the id it never made you type. Compared by
  // what each button IS, not how many there are: a count still passes when a pane
  // draws its own near-copy, which is the drift this is here to catch.
  const titles = (sel: string) => page.locator(`${sel} .termpane-acts button`).evaluateAll(
    (bs) => bs.map((b) => b.getAttribute('title') || ''),
  );
  const agentActs = await titles('.agentpane');
  const termActs = await titles('.pane-wrap:not(:has(.agentpane)) .termpane');
  expect(agentActs.filter((t) => !t.startsWith('Conversation id'))).toEqual(
    termActs.map((t) => (t === 'Close terminal' ? 'Close agent pane' : t === 'Detach to new tab' ? 'Detach to a new window' : t)),
  );
  expect(agentActs.filter((t) => t.startsWith('Conversation id'))).toHaveLength(1);

  expect(errs, 'the mock must not log errors').toEqual([]);
});

/**
 * A tab holding a view must not look like a tab holding panes. Before this, the
 * manager and a resumed agent both wore the robot and nothing said which one you
 * could type into.
 */
for (const shell of ['web', 'desktop'] as const) {
  test(`${shell} mock: view tabs and pane tabs are told apart, and no native dropdown`, async ({ page }) => {
    const errs = watchErrors(page);
    await page.goto(mock(shell));
    await page.evaluate(() => { openMachine('web-01'); openAgents(); });

    // The machine dashboard and the agent manager are views; the terminal is not.
    await expect(page.locator('.mtab.view')).toHaveCount(2);
    await expect(page.locator('.mtab', { hasText: 'Agents' })).toHaveClass(/view/);
    await expect(page.locator('.mtab', { hasText: 'Terminal' })).not.toHaveClass(/view/);

    // A resumed agent holds panes, so its tab is not a view tab.
    await page.evaluate(() => agentPickScope('web-01'));
    await page.locator('.arow').first().getByRole('button', { name: 'Resume' }).click();
    await expect(page.locator('.mtab.view')).toHaveCount(2);
    await expect(page.locator('.mtab', { hasText: 'acme/api' })).not.toHaveClass(/view/);

    // The scope picker is ours: a native <select> paints its own list in the OS's
    // colours and drops a white panel into a dark app.
    await expect(page.locator('.mdash select')).toHaveCount(0);

    expect(errs, 'the mock must not log errors').toEqual([]);
  });
}

/**
 * Another CLI is two commands: how to list its conversations and how to resume one.
 * That is the entire adapter boundary, and it has to be configurable or the three
 * built-in tools are magic.
 */
test('desktop mock: another agent CLI can be registered, and is looked for', async ({ page }) => {
  const errs = watchErrors(page);
  await page.goto(mock('desktop'));
  await page.evaluate(() => { openAgents(); agentPickScope('web-01'); });
  const before = await page.locator('.atool').count();

  await page.evaluate(() => dlgAgentTools());
  await page.locator('#at-name').fill('Aider');
  await page.locator('#at-bin').fill('aider');
  await page.locator('#at-list').fill('ls ~/.aider/sessions');
  await page.locator('#at-resume').fill('aider --restore {id}');
  await page.locator('.backdrop [data-ok]').click();

  // It appears, and says honestly that the last probe predates it rather than
  // claiming the machine does not have it.
  await expect(page.locator('.atool')).toHaveCount(before + 1);
  await expect(page.locator('.atool', { hasText: 'Aider' })).toContainText(/added since the last probe/);

  // Switching an adapter off stops Rite looking for it at all.
  await page.evaluate(() => { agentTool('gemini').on = false; renderMain(); });
  await expect(page.locator('.atool', { hasText: 'Gemini' })).toHaveCount(0);

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
