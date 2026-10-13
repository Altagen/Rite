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

  // The split button splits — plainly, with no menu in the way. That is what most
  // people want from a divider, so it is what the button does.
  await page.locator('.agentpane button[title^="Split horizontal"]').click();
  await expect(page.locator('.menu')).toHaveCount(0);
  expect(await page.evaluate(() => STATE.agentTab.panes[1].cmd)).toBeUndefined();
  await page.evaluate(() => closePaneAt(1));

  // Everything else is behind the chevron beside it, and it is all configurable.
  await page.locator('.agentpane .split-more').click();
  await page.locator('.menu .row', { hasText: 'Disk' }).click();

  // Two panes in ONE tab, separated by the divider a terminal split already uses.
  await expect(page.locator('.pane-wrap')).toHaveCount(2);
  await expect(page.locator('.pdiv')).toHaveCount(1);
  await expect(page.locator('.agentpane')).toHaveCount(1);
  await expect(page.locator('.termpane:not(.agentpane)')).toHaveCount(1);

  // Same chrome on both, because both get it from `paneActs` — the agent only adds
  // the controls that are its own. Compared by what each button IS, not how many
  // there are: a count still passes when a pane draws its own near-copy, which is
  // the drift this is here to catch. The agent's own controls are named here, so
  // adding one is a deliberate edit to this list rather than a silent divergence.
  const OWN = [/^Conversation id/, /^What is in effect/];
  const titles = (sel: string) => page.locator(`${sel} .termpane-acts button`).evaluateAll(
    (bs) => bs.map((b) => b.getAttribute('title') || ''),
  );
  const agentActs = await titles('.agentpane');
  const termActs = await titles('.pane-wrap:not(:has(.agentpane)) .termpane');
  const isOwn = (t: string) => OWN.some((re) => re.test(t));
  expect(agentActs.filter((t) => !isOwn(t))).toEqual(
    termActs.map((t) => (t === 'Close terminal' ? 'Close agent pane' : t === 'Detach to new tab' ? 'Detach to a new window' : t)),
  );
  expect(agentActs.filter(isOwn)).toHaveLength(OWN.length);

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
  // The dialog focuses its first input on a timer; typing before it is attached
  // silently lands nowhere and the assertion below then fails for the wrong reason.
  await expect(page.locator('#at-name')).toBeVisible();
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
 * Skills, commands and hooks — read-only, with provenance.
 *
 * The product here is the answer to "what is ACTUALLY in effect?", which no tool
 * gives you: the account layer under the project layer, resolved on that host under
 * that account. Read-only is the defensive choice, not the timid one — a hook is a
 * command that runs unattended, and on a shared account one person's hook runs for
 * everyone. Making that visible is the opposite of making it easy.
 */
test('desktop mock: what is in effect is shown with its provenance, and never written', async ({ page }) => {
  const errs = watchErrors(page);
  await page.goto(mock('desktop'));
  await page.evaluate(() => { openAgents(); agentPickScope('@local'); });
  await page.evaluate(() => dlgAgentContext('@local', 'claude', '41b9c8d7-6e52-4a19-83f0-9c1d5b2e7a44'));

  // Every row names the layer it came from and the file it is in: the answer to
  // "why did that happen?" is a path, so a row without one answers nothing.
  const rows = page.locator('.backdrop .arow');
  expect(await rows.count()).toBeGreaterThan(0);
  expect(await page.locator('.backdrop .arow .alayer').count()).toBe(await rows.count());

  // A copy that loses to the project layer is shown losing, not hidden — "why is my
  // skill not applying" is answered by seeing the one that was shadowed.
  await expect(page.locator('.backdrop .arow.shadowed')).toHaveCount(1);

  // Nothing is editable here, so nothing can be cancelled either.
  await expect(page.locator('.backdrop [data-x]')).toBeHidden();
  await expect(page.locator('.backdrop input, .backdrop textarea')).toHaveCount(0);

  // Opening a file is a terminal pane running the editor on that machine — Rite
  // navigates, the editor edits, and no new right is needed to do it.
  await page.locator('.backdrop .arow.hook').first().getByRole('button').click();
  await expect(page.locator('.backdrop')).toHaveCount(0);
  await expect(page.locator('.term-body')).toContainText('$EDITOR');

  expect(errs, 'the mock must not log errors').toEqual([]);
});

/** A shared account is the case the panel exists for, so it says so out loud. */
test('desktop mock: a hook nobody here installed is visible, on a shared account', async ({ page }) => {
  const errs = watchErrors(page);
  await page.goto(mock('desktop'));
  await page.evaluate(() => { openAgents(); agentPickScope('web-01'); });
  await page.evaluate(() => dlgAgentContext('web-01', 'claude', '3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11'));

  await expect(page.locator('.backdrop')).toContainText(/shared account/);
  await expect(page.locator('.backdrop')).toContainText(/hooks you did not install/);
  // The one under the shared home is marked apart from the project's own.
  await expect(page.locator('.backdrop .arow.hook')).toHaveCount(2);
  await expect(page.locator('.backdrop .arow.hook.foreign')).toHaveCount(1);
  await expect(page.locator('.backdrop .arow.hook.foreign')).toContainText('/home/deploy/.claude/settings.json');

  expect(errs, 'the mock must not log errors').toEqual([]);
});

/**
 * Every control the agent surface added, actually clicked.
 *
 * The spec above checks the states that carry an argument; this one checks that
 * nothing throws. A mock that breaks on a click nobody exercised is the exact
 * silence this file exists to end — it is how the web UI shipped a dashboard
 * nobody had decided on.
 */
test('desktop mock: every agent control can be used without the page throwing', async ({ page }) => {
  const errs = watchErrors(page);
  await page.goto(mock('desktop'));

  // Reached from a machine's dashboard, already pointed at it.
  await page.evaluate(() => openMachine('web-01'));
  // The dashboard's own button, not the toolbar's — that is the one that arrives
  // already pointed at this machine.
  await page.locator('.mdash-hd').getByRole('button', { name: 'Agents' }).click();
  expect(await page.evaluate(() => STATE.agentScope)).toBe('web-01');

  // Probe, scope menu, a machine that answers nothing, and back.
  await page.evaluate(() => agentProbeNow());
  await expect(page.locator('.mdash-hd')).toContainText('read just now');
  await page.evaluate(() => agentPickScope('lb-01'));
  await expect(page.locator('.atool.off')).toHaveCount(3);
  await page.evaluate(() => agentPickScope('@local'));

  // Start a new agent: the dialog asks for the one thing it cannot guess.
  await page.locator('.atool', { hasText: 'Claude Code' }).getByRole('button', { name: 'New' }).click();
  await expect(page.locator('#na-cwd')).toBeVisible();
  await page.locator('.backdrop [data-ok]').click();
  await expect(page.locator('.backdrop')).toHaveCount(0);

  // Each entry of the row menu, one at a time.
  for (const label of [/Copy conversation id/, /Copy the resume command/, /Resume in a new window/]) {
    await page.locator('.arow').first().getByRole('button', { name: 'More' }).click();
    await page.locator('.menu .row', { hasText: label }).click();
  }

  // Splitting from the agent, focusing a pane, closing one, then the tab.
  await page.locator('.agentpane button[title^="Split vertical"]').click();
  await expect(page.locator('.pane-wrap')).toHaveCount(2);
  await page.evaluate(() => focusPaneAt(1));
  await page.evaluate(() => closePaneAt(1));
  await expect(page.locator('.pane-wrap')).toHaveCount(1);
  await page.evaluate(() => closeAgentPane());
  await expect(page.locator('.mtab', { hasText: 'rite' })).toHaveCount(0);

  // Closing the manager leaves nothing of it behind.
  await page.evaluate(() => closeAgents());
  await expect(page.locator('.mtab.view', { hasText: 'Agents' })).toHaveCount(0);

  expect(errs, 'the mock must not log errors').toEqual([]);
});

/**
 * Splits are a TERMINAL feature, configurable, and the plain one is the default.
 *
 * Most people want a plain divider; a minority want `top` on the right; some want
 * five panes arranged a particular way. The first must not pay for the other two,
 * and none of the three should be something only the author can change.
 */
for (const shell of ['web', 'desktop'] as const) {
  test(`${shell} mock: a divider opens a plain terminal, and what else it opens is configurable`, async ({ page }) => {
    const errs = watchErrors(page);
    await page.goto(mock(shell));

    // The plain terminal tab is a pane list like any other — same renderer, so a
    // split is one feature in both shells rather than an agent-only trick.
    const before = await page.locator('.pane-wrap').count();
    await page.locator('.termpane button[title^="Split horizontal"]').first().click();
    await expect(page.locator('.pane-wrap')).toHaveCount(before + 1);
    await expect(page.locator('.menu')).toHaveCount(0);

    // A preset is a name and a command, and both are the user's.
    await page.locator('.termpane .split-more').first().click();
    await expect(page.locator('.menu .row').first()).toContainText('Terminal');
    await page.locator('.menu .row', { hasText: 'Disk' }).click();
    await expect(page.locator('.termpane-hdr .name', { hasText: 'Disk' })).toHaveCount(1);

    // A layout opens several at once — the "five terminals arranged like this" case.
    const n = await page.locator('.pane-wrap').count();
    await page.locator('.termpane .split-more').first().click();
    await page.locator('.menu .row', { hasText: 'Deploy watch' }).click();
    await expect(page.locator('.pane-wrap')).toHaveCount(n + 3);

    // Snippets are reachable from the same place, because "run my saved command in
    // the new pane" is the same intent as "open a preset".
    await page.locator('.termpane .split-more').first().click();
    await page.locator('.menu .row', { hasText: 'Snippets' }).click();
    await expect(page.locator('.backdrop')).toContainText('Snippets');
    await page.locator('.backdrop [data-ok]').click();

    // And all of it is editable, from the same dialog Settings points at.
    await page.evaluate(() => dlgSplitPrefs());
    await expect(page.locator('#sp-name')).toBeVisible();
    await page.locator('#sp-name').fill('Journal');
    await page.locator('#sp-cmd').fill('journalctl -f');
    await page.locator('.backdrop [data-sp-add]').click();
    await expect(page.locator('.backdrop .snip-name', { hasText: 'Journal' })).toHaveCount(1);
    await page.locator('.backdrop [data-ok]').click();
    await page.locator('.termpane .split-more').first().click();
    await expect(page.locator('.menu .row', { hasText: 'Journal' })).toHaveCount(1);

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
