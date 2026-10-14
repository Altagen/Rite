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

    // The plain terminal heads the chevron in both shells: the menu is a superset of
    // the button, not a different feature.
    await page.locator('.termpane .split-more').first().click();
    await expect(page.locator('.menu .row').first()).toContainText('Terminal');

    // Snippets are reachable from the same place, because "run my saved command in
    // the new pane" is the same intent as "open a preset". They are a personal
    // library, not a file on a machine, so they are in both shells.
    await page.locator('.menu .row', { hasText: 'Snippets' }).click();
    await expect(page.locator('.backdrop')).toContainText('Snippets');
    await page.locator('.backdrop [data-ok]').click();

    // Everything past that point comes out of the workspace file, which a browser
    // talking to a shared server does not have (ADR 0023). The divergence is checked
    // here rather than left to be discovered: the same chevron, two honest answers.
    if (shell === 'web') {
      await page.locator('.termpane .split-more').first().click();
      const rows = page.locator('.menu .row');
      await expect(rows).toHaveCount(2); // the plain terminal, and Snippets…
      await expect(rows.filter({ hasText: /Split presets/ })).toHaveCount(0);
      await expect(rows.filter({ hasText: /Deploy watch/ })).toHaveCount(0);
      expect(await page.evaluate(() => [SPLIT_PRESETS.length, PANE_LAYOUTS.length])).toEqual([0, 0]);
      // And no Layouts button beside the tabs, for the same reason.
      await expect(page.locator('button[title^="Layouts"]')).toHaveCount(0);
      await page.keyboard.press('Escape');
      expect(errs, 'the mock must not log errors').toEqual([]);
      return;
    }

    // A preset is a name and a command, and both are the user's — `[[preset]]` in the
    // workspace file, so the chevron offers what the file declares.
    await page.locator('.termpane .split-more').first().click();
    await page.locator('.menu .row', { hasText: 'Disk' }).click();
    await expect(page.locator('.termpane-hdr .name', { hasText: 'Disk' })).toHaveCount(1);

    // A layout opens several at once — the "five terminals arranged like this" case.
    const n = await page.locator('.pane-wrap').count();
    await page.locator('.termpane .split-more').first().click();
    await page.locator('.menu .row', { hasText: 'Deploy watch' }).click();
    await expect(page.locator('.pane-wrap')).toHaveCount(n + 3);

    // And all of it is editable, from the same dialog Settings points at. A
    // preferences dialog saves as you go, so it has no footer: the ✕ is the way out,
    // and there is no "Cancel" pretending the change has not happened yet.
    await page.evaluate(() => dlgSplitPrefs());
    await expect(page.locator('#sp-name')).toBeVisible();
    await expect(page.locator('.backdrop [data-ok]')).toHaveCount(0);
    await page.locator('#sp-name').fill('Journal');
    await page.locator('#sp-cmd').fill('journalctl -f');
    await page.locator('.backdrop [data-sp-add]').click();
    await expect(page.locator('.backdrop .snip-name', { hasText: 'Journal' })).toHaveCount(1);
    await page.locator('.backdrop .modal-x').click();
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

/**
 * A preset and a layout can be changed, and a layout has its own button.
 *
 * Two corrections from the same review. Editing: the first version could only add and
 * remove, so fixing a typo meant deleting the entry and retyping the other field.
 * Placement: a layout arranges a whole tab, so it belongs beside the tabs — the split
 * menu keeps offering them, because someone who learned the chevron should not have
 * to unlearn it.
 */
// Desktop only: both halves come out of the workspace file, which a browser talking
// to a shared server does not have. The web shell's side of that is checked above.
test(`desktop mock: a preset is editable, and a layout has its own button`, async ({ page }) => {
  const errs = watchErrors(page);
  await page.goto(mock('desktop'));

  // The button is there because a layout ships in the mock's library; with none
  // configured it hides itself rather than opening on nothing.
  const layoutsBtn = page.locator('button[title^="Layouts"]');
  await expect(layoutsBtn).toHaveCount(1);
  expect(await page.evaluate(() => PANE_LAYOUTS.length)).toBeGreaterThan(0);
  // Spliced out and pushed back: `length = 0` discards the entries, and setting
  // the length back only makes empty slots — which is a check that breaks the
  // thing it is inspecting.
  expect(
    await page.evaluate(() => {
      const saved = PANE_LAYOUTS.splice(0, PANE_LAYOUTS.length);
      const html = layoutsBtnHTML();
      PANE_LAYOUTS.push(...saved);
      return html;
    }),
  ).toBe('');
  expect(await page.evaluate(() => PANE_LAYOUTS.length)).toBeGreaterThan(0);

  // It opens the whole arrangement, in the tab, from the tab strip. The layout it
  // opens is the one it measured — reading one layout's pane count and clicking a
  // different layout's row passes or fails on a coincidence.
  const before = await page.locator('.pane-wrap').count();
  const first = await page.evaluate(() => ({
    name: PANE_LAYOUTS[0].name,
    panes: PANE_LAYOUTS[0].panes.length,
  }));
  expect(first.panes).toBe(3);
  await layoutsBtn.click();
  await page.locator('.menu .row', { hasText: new RegExp(first.name) }).click();
  await expect(page.locator('.pane-wrap')).toHaveCount(before + first.panes);

  // Editing a preset changes it in place rather than adding a second one.
  await page.evaluate(() => dlgSplitPrefs());
  const rows = page.locator('.backdrop .snip-row');
  const rowsBefore = await rows.count();
  // Regexes, not strings: `hasText` with a string matches case-insensitively, and
  // the layout row lists a pane called `disk` — so 'Disk' found two rows and the
  // rename looked like it had not taken.
  await rows.filter({ hasText: /Disk/ }).locator('[data-sp-edit]').click();
  await expect(page.locator('#sp-name')).toHaveValue('Disk');
  await expect(page.locator('#sp-cmd')).toHaveValue('df -h');
  await page.locator('#sp-name').fill('Espace');
  await page.locator('#sp-cmd').fill('df -h /');
  await page.locator('[data-sp-add]').click();
  await expect(rows.filter({ hasText: /Espace/ })).toHaveCount(1);
  await expect(rows.filter({ hasText: /Disk/ })).toHaveCount(0);
  await expect(rows).toHaveCount(rowsBefore);

  // The presets dialog is presets only. A layout is not a bigger preset, and
  // sharing one screen with it said that it was.
  await expect(page.locator('.backdrop [data-sl-edit]')).toHaveCount(0);
  await expect(page.locator('.backdrop #sl-panes')).toHaveCount(0);
  await page.locator('.backdrop .modal-x').click();

  expect(errs, 'the mock must not log errors').toEqual([]);
});

/**
 * A layout is a file.
 *
 * It is the start of a working day — what opens, where, and on which machine — so it
 * names machines, it has an order, and it is the kind of thing people keep in version
 * control and copy between computers. A form over that is a worse version of the file.
 *
 * The part worth pinning is not the parser. It is what happens when the file asks for
 * something this computer cannot give: a layout that names a machine you do not have
 * must still OPEN, as a plain shell, saying so in the pane. Anything else means a
 * renamed machine or a locked vault silently costs you your workspace.
 */
test(`desktop mock: a layout opens from a file, and falls back pane by pane`, async ({ page }) => {
  const errs = watchErrors(page);
  await page.goto(mock('desktop'));

  // The file is the store: the menu lists what the file declares, in its order.
  expect(await page.evaluate(() => PANE_LAYOUTS.map((l) => l.name))).toEqual([
    'Morning',
    'Deploy watch',
  ]);
  expect(await page.evaluate(() => PANE_LAYOUTS[0].startup)).toBe(true);

  // Morning: a plain shell, then two machines named by the file.
  const before = await page.locator('.pane-wrap').count();
  await page.locator('button[title^="Layouts"]').click();
  await page.locator('.menu .row', { hasText: /Morning/ }).click();
  await expect(page.locator('.pane-wrap')).toHaveCount(before + 3);

  // What the two machine panes became depends on whether the library is reachable
  // — and either way the layout opened all three panes.
  const reachable = await page.evaluate(() => {
    const c = typeof STATE === 'undefined' ? null : (STATE as { ctx?: { type: string } }).ctx;
    return !c || c.type === 'server';
  });
  await expect(page.locator('.pane-warn')).toHaveCount(reachable ? 0 : 2);
  if (!reachable) {
    await expect(page.locator('.pane-warn').first()).toContainText('web-01');
    await expect(page.locator('.pane-warn').first()).toContainText('open vault');
  }

  // A machine the file names and the library does not have: one pane, a plain
  // shell, and the name it asked for printed in the pane.
  await page.evaluate(() => {
    LAYOUT_FILE = '[[layout]]\nname = "Ghost"\n\n  [[layout.pane]]\n  machine = "nope-01"\n  command = "top"\n';
    reloadLayouts();
  });
  const n = await page.locator('.pane-wrap').count();
  await page.locator('button[title^="Layouts"]').click();
  await page.locator('.menu .row', { hasText: /Ghost/ }).click();
  await expect(page.locator('.pane-wrap')).toHaveCount(n + 1);
  await expect(page.locator('.pane-warn').last()).toContainText('nope-01');

  // A file that does not parse loads NOTHING and names the line — and the layouts
  // already loaded keep working, because half a file is worse than no file.
  const err = await page.evaluate(() => {
    LAYOUT_FILE = '[[layout]]\nname = "Broken"\n\n  [[layout.pane]]\n  machine = web-01\n';
    const r = reloadLayouts();
    return { line: r.error && r.error.line, loaded: PANE_LAYOUTS.map((l) => l.name) };
  });
  expect(err.line).toBe(5);
  expect(err.loaded).toEqual(['Ghost']);

  // The dialog is the file, and saving it reloads.
  await page.evaluate(() => dlgLayouts());
  await expect(page.locator('.lay-err')).toContainText('Line 5');
  await page.locator('#lay-file').fill('[[layout]]\nname = "Fixed"\n\n  [[layout.pane]]\n  command = "top"\n');
  await page.locator('[data-lay-save]').click();
  await expect(page.locator('.lay-err')).toHaveCount(0);
  expect(await page.evaluate(() => PANE_LAYOUTS.map((l) => l.name))).toEqual(['Fixed']);
  await page.locator('.backdrop .modal-x').click();

  expect(errs, 'the mock must not log errors').toEqual([]);
});

/**
 * Settings ▸ Layouts leads with the cards, and the switch on a card writes the file.
 *
 * The section was a heading, three lines of prose and an "Open the layouts file…"
 * button — so the only answer to "what do I have" was behind a click and underneath a
 * textarea. The cards come first now and the button is for EDITING, which is a rarer
 * thing to want than looking.
 *
 * The switch is the second half: `startup = true` was a key you had to know about and
 * go and type. It writes by SPLICING, so the comments, the presets and the other
 * layouts have to come back unchanged — that is most of what is checked below, because
 * a switch that quietly reformats a hand-written file is worse than no switch.
 */
test('desktop mock: Settings leads with the layout cards, and the startup switch writes the file', async ({
  page,
}) => {
  const errs = watchErrors(page);
  await page.goto(mock('desktop'));

  await page.evaluate(() => openSettings('layouts'));
  const cards = page.locator('[data-lay-cards] .snip-row');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Morning');
  await expect(cards.nth(1)).toContainText('Deploy watch');
  // Grouped as it will open: the file gives "Deploy watch" a tab of its own, and a
  // pane listed under the wrong tab is the opposite of what the list is for.
  await expect(cards.nth(1)).toContainText('Tab “disks”');
  // Resolved against the library this computer has, not just echoed from the file.
  await expect(cards.nth(0)).toContainText('this computer');

  // The cards are ABOVE the editor button — that is the whole change, so it is the
  // geometry that is checked and not merely that both exist.
  const cardsBox = await page.locator('[data-lay-cards]').boundingBox();
  const btnBox = await page.locator('.prefs-pane button', { hasText: /Open the layouts file/ }).boundingBox();
  expect(cardsBox!.y + cardsBox!.height).toBeLessThanOrEqual(btnBox!.y);

  // "Deploy watch" does not open at startup, and the file is where that is stored.
  const toggle = cards.nth(1).locator('input[type=checkbox]');
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(page.locator('[data-lay-cards] .snip-row').nth(1).locator('input[type=checkbox]')).toBeChecked();

  // What the file says now. The key goes under `name`, where the documentation shows
  // it, and every other line is untouched: counted, because a comparison that only
  // looks for what was ADDED would pass against a splicer that rewrote the rest.
  const after = await page.evaluate(() => ({
    file: LAYOUT_FILE,
    startups: PANE_LAYOUTS.map((l) => l.startup),
    panes: (LAYOUT_FILE.match(/\[\[layout\.pane\]\]/g) || []).length,
    presets: (LAYOUT_FILE.match(/\[\[preset\]\]/g) || []).length,
  }));
  expect(after.file).toContain('name = "Deploy watch"\nstartup = true');
  expect(after.startups).toEqual([true, true]);
  expect(after.panes).toBe(6);
  expect(after.presets).toBe(2);
  // Morning's own key, and the comment written beside it, are still there.
  expect(after.file).toContain('startup = true            # open this layout when Rite starts');
  expect(after.file).toContain('  machine = "web-01"      # a machine from your library, by name');
  expect(after.file.startsWith('# Your workspace:')).toBe(true);

  // Off REMOVES the line rather than writing `startup = false`: the file stays free of
  // a key that states the default.
  await page.locator('[data-lay-cards] .snip-row').nth(1).locator('input[type=checkbox]').click();
  await expect(page.locator('[data-lay-cards] .snip-row').nth(1).locator('input[type=checkbox]')).not.toBeChecked();
  const off = await page.evaluate(() => ({
    file: LAYOUT_FILE,
    startups: PANE_LAYOUTS.map((l) => l.startup),
  }));
  expect(off.file).not.toContain('startup = false');
  expect((off.file.match(/startup = true/g) || []).length).toBe(1);
  expect(off.startups).toEqual([true, false]);

  // A file that does not parse is reported HERE, where you look first. "No layouts"
  // and "line 5 is wrong" are very different facts and used to look identical.
  await page.evaluate(() => {
    document.querySelectorAll('.backdrop').forEach((b) => b.remove());
    LAYOUT_FILE = '[[layout]]\nname = "Broken"\n\n  [[layout.pane]]\n  machine = web-01\n';
    reloadLayouts();
    openSettings('layouts');
  });
  await expect(page.locator('.prefs-pane .lay-err')).toContainText('Line 5');
  await expect(page.locator('.prefs-pane .lay-err')).toContainText('Not loaded');

  // An empty file is not an error, and says what to do about it rather than nothing.
  await page.evaluate(() => {
    document.querySelectorAll('.backdrop').forEach((b) => b.remove());
    LAYOUT_FILE = '# nothing here yet\n';
    reloadLayouts();
    openSettings('layouts');
  });
  await expect(page.locator('.prefs-pane .lay-err')).toHaveCount(0);
  await expect(page.locator('.prefs-pane [data-lay-empty]')).toContainText('No layouts yet');

  expect(errs, 'the mock must not log errors').toEqual([]);
});

/**
 * The presets and the layouts are one file, so the preset dialog may not own it.
 *
 * A list of two fields is the easiest thing in the world to save by regenerating the
 * document from the parse — and that silently throws away the comments, the blank lines
 * and the order someone chose, along with every layout in the same file. So the dialog
 * SPLICES: its library becomes the file's preset blocks and nothing else moves.
 */
test('desktop mock: the preset dialog rewrites the preset blocks and nothing else', async ({ page }) => {
  const errs = watchErrors(page);
  await page.goto(mock('desktop'));

  await page.evaluate(() => dlgSplitPrefs());
  await page.locator('#sp-name').fill('Journal');
  await page.locator('#sp-cmd').fill('journalctl -f');
  await page.locator('.backdrop [data-sp-add]').click();

  const after = await page.evaluate(() => ({
    file: LAYOUT_FILE,
    presets: SPLIT_PRESETS.map((p) => p.name),
    layouts: PANE_LAYOUTS.map((l) => l.name),
    panes: (LAYOUT_FILE.match(/\[\[layout\.pane\]\]/g) || []).length,
  }));
  expect(after.presets).toEqual(['Load', 'Disk', 'Journal']);
  expect(after.file).toContain('[[preset]]\nname = "Journal"\ncommand = "journalctl -f"');
  // Everything that is not a preset block came back exactly as it was typed.
  expect(after.layouts).toEqual(['Morning', 'Deploy watch']);
  expect(after.panes).toBe(6);
  expect(after.file.startsWith('# Your workspace:')).toBe(true);
  expect(after.file).toContain('  of = "logs"             # cut out of that pane, not the previous one');

  // A pane citing a preset gets the preset's command at parse — one place to change it.
  expect(await page.evaluate(() => PANE_LAYOUTS[0].panes[2].command)).toBe('top');

  // Removing one leaves the rest of the file alone too.
  await page.locator('.backdrop .snip-row', { hasText: /Journal/ }).locator('[data-sp-del]').click();
  const removed = await page.evaluate(() => ({
    presets: SPLIT_PRESETS.map((p) => p.name),
    layouts: PANE_LAYOUTS.map((l) => l.name),
    cites: LAYOUT_FILE.includes('Journal'),
  }));
  expect(removed.presets).toEqual(['Load', 'Disk']);
  expect(removed.layouts).toEqual(['Morning', 'Deploy watch']);
  expect(removed.cites).toBe(false);
  await page.locator('.backdrop .modal-x').click();

  expect(errs, 'the mock must not log errors').toEqual([]);
});

/**
 * Settings is a rail, and the rail is built from the context.
 *
 * Scrolling could no longer find anything: the only way to know whether a setting
 * existed was to read all of them. And two sections — the master password, the danger
 * zone — only mean something once there is a vault to hold one, so they are absent
 * rather than greyed out, because a disabled row still implies you are missing out.
 */
for (const shell of ['web', 'desktop'] as const) {
  test(`${shell} mock: settings is a rail, and only the chosen section renders`, async ({ page }) => {
    const errs = watchErrors(page);
    await page.goto(mock(shell));

    await page.evaluate(() => openSettings());
    const nav = page.locator('.prefs-nav button');
    expect(await nav.count()).toBeGreaterThan(5);
    await expect(page.locator('.prefs-pane')).toHaveCount(1);

    // Splits and Layouts are two entries, because they are two features — and both
    // are entries only where there is a workspace file to hold them. On a shared
    // server there is none and nothing stands in for one, so they are ABSENT from the
    // rail rather than present and empty (ADR 0023).
    const file = shell === 'desktop' ? 1 : 0;
    await expect(nav.filter({ hasText: /Split presets/ })).toHaveCount(file);
    await expect(nav.filter({ hasText: /Layouts/ })).toHaveCount(file);

    // A preferences dialog has no footer at all: the ✕ is the only way out.
    await expect(page.locator('.backdrop [data-ok]')).toHaveCount(0);
    await expect(page.locator('.backdrop .modal-x')).toHaveCount(1);

    // One section at a time, and the rail says which.
    await nav.filter({ hasText: /Toolbar/ }).click();
    await expect(page.locator('.prefs-pane')).toContainText('Toolbar');
    await expect(page.locator('.prefs-nav button.on')).toHaveText(/Toolbar/);

    // The toolbar is the person's: hiding a button hides it, and nothing else.
    const actsBefore = await page.locator('#acts button').count();
    await page.locator('.prefs-pane .settings-row', { hasText: /Agents/ }).locator('.toggle').click();
    expect(await page.locator('#acts button').count()).toBe(actsBefore - 1);

    expect(errs, 'the mock must not log errors').toEqual([]);
  });
}

/**
 * An overlay page carries the nav, so you travel without closing first.
 *
 * Teams, Collections and Notifications are pages you move between, and their bar used
 * to hold Close and your avatar and nothing else: Collections → Teams meant closing,
 * then finding the button you had just left. The bar is the emptiest in the app, so
 * the nav costs nothing to carry, and Close stays where it was for the trip back to
 * the terminals.
 *
 * The admin console is the deliberate exception: its own left rail already says Teams
 * and Collections — the organisation's, not yours — and the same two words twice on one
 * screen, meaning two different things, is worse than a Close.
 */
for (const page_ of ['collections', 'teams', 'notifications'] as const) {
  test(`mock: the ${page_} page carries the nav, with its own entry marked`, async ({ page }) => {
    const errs = watchErrors(page);
    await page.goto(mock(page_));

    const nav = page.locator('#onav button');
    // Terminals, Teams, Collections, Administration (this account is an admin), and the
    // bell — except on the inbox page itself, where a bell would open what you are reading.
    await expect(nav).toHaveCount(page_ === 'notifications' ? 4 : 5);
    await expect(nav.filter({ hasText: 'Terminals' })).toHaveCount(1);
    await expect(nav.filter({ hasText: 'Teams' })).toHaveCount(1);
    await expect(nav.filter({ hasText: 'Collections' })).toHaveCount(1);
    await expect(nav.filter({ hasText: 'Administration' })).toHaveCount(1);

    // The entry for this page is marked and goes nowhere: it is where you are. Dropping
    // it instead would shift the other two under the cursor on every hop.
    //
    // The inbox is the exception and has nothing marked, because it is not one of the
    // three: you reach it from the bell, and the bell is not a nav entry.
    const here = page.locator('#onav [aria-current="page"]');
    if (page_ === 'notifications') {
      await expect(here).toHaveCount(0);
    } else {
      await expect(here).toHaveCount(1);
      await expect(here).toHaveText(new RegExp(page_, 'i'));
      await expect(here).toHaveClass(/nav-on/);
      await expect(here).not.toHaveAttribute('onclick', /./);
    }

    // And no ✕: "Terminals" IS the way back, so a Close beside it would be a second
    // answer to a question already answered — the duplicate the nav was added to remove.
    await expect(page.locator('.appbar button', { hasText: 'Close' })).toHaveCount(0);
    expect(errs, 'the mock must not log errors').toEqual([]);
  });
}

test('mock: the nav travels between the overlay pages, and the console does not carry it', async ({
  page,
}) => {
  const errs = watchErrors(page);
  await page.goto(mock('collections'));

  // One hop, no Close in between — the whole point.
  await page.locator('#onav button', { hasText: 'Teams' }).click();
  await expect(page).toHaveURL(/teams\.html$/);
  await expect(page.locator('#onav [aria-current="page"]')).toHaveText(/Teams/);

  // Administration is a role gate, not decoration: a plain user is not offered it.
  const asUser = await page.evaluate(() => {
    const me = ORG.users.find((u: { u: string }) => u.u === ME)!;
    const was = me.role;
    me.role = 'user';
    const html = overlayNavHTML('teams');
    me.role = was;
    return html;
  });
  expect(asUser).not.toContain('Administration');
  expect(asUser).toContain('Collections');

  // The way back is named, and it is the nav's own first entry.
  await page.locator('#onav button', { hasText: 'Terminals' }).click();
  await expect(page).toHaveURL(/web\.html$/);

  // The console is the exception on both counts: no nav, so it keeps its ✕.
  await page.goto(mock('admin'));
  await expect(page.locator('#onav')).toHaveCount(0);
  await expect(page.locator('.appbar button', { hasText: 'Collections' })).toHaveCount(0);
  await expect(page.locator('.appbar button', { hasText: 'Close' })).toHaveCount(1);

  expect(errs, 'the mock must not log errors').toEqual([]);
});
