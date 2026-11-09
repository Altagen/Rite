import { test, expect } from '@playwright/test';
import { ensureCollection, createMachine } from './support/localVault';

/**
 * The agent manager, in a local vault (ADR 0022 §4).
 *
 * WHAT A BROWSER TEST CAN HONESTLY HOLD HERE. Discovery runs one command over SSH, and
 * the harness has no machine with an agent CLI on it, so what is asserted is everything
 * up to and after that round trip: that the manager is a VIEW reached from the toolbar,
 * that it says which machine it is looking at and that it has not looked yet, that
 * picking a machine is what unlocks the ask, and that the CLIs panel names the six
 * adapters with the commands they will run.
 *
 * The parse side is held as a table instead, in `e2e/agent-adapters-check.mjs`, against
 * the real listings measured on an installed binary — a browser test per vendor layout
 * would be minutes of SSH for decisions that are a pure function of a path.
 */

test.beforeEach(async ({ request }) => {
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
});

test('the manager is a view, names the machine, and says it has not looked yet', async ({
  page,
  request,
}) => {
  const collection = await ensureCollection(request, 'e2e-agents');
  await createMachine(request, collection, { name: 'e2e-agent-host' });

  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });

  // A view, not a pane: the toolbar OPENS it, a closable chip then appears in the tab
  // strip, and the view covers the workspace. The chip is not permanent — this is
  // somewhere people go, and the mock keeps it that way for the same reason.
  await expect(page.getByTestId('nav-agents')).toHaveCount(0);
  await page.getByTestId('toolbar-agents').click();
  await expect(page.getByTestId('agent-manager')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('nav-agents')).toBeVisible();

  // Nothing is asked of any machine until one is chosen. A manager that probed on open
  // would spend an SSH round trip for arriving at a screen.
  await expect(page.getByTestId('agent-no-machine')).toBeVisible();
  await expect(page.getByTestId('agent-probe')).toHaveCount(0);

  await page.getByTestId('agent-machine').click();
  await page.getByRole('option', { name: 'e2e-agent-host' }).click();

  // Chosen, and still not read — and the screen says so with the machine's name in it,
  // because "not probed" without a subject is a sentence about nothing.
  await expect(page.getByTestId('agent-not-probed')).toContainText('e2e-agent-host');
  await expect(page.getByTestId('agent-subtitle')).toContainText('e2e-agent-host');
  await expect(page.getByTestId('agent-probe')).toBeEnabled();

  // Closing it puts the workspace back and takes the chip with it.
  await page.getByTestId('nav-agents-close').click();
  await expect(page.getByTestId('agent-manager')).toHaveCount(0);
  await expect(page.getByTestId('nav-agents')).toHaveCount(0);
});

test('a browser is offered no local machine, and the route refuses it nothing', async ({
  page,
  request,
}) => {
  // THE DESKTOP ALWAYS HAS A LOCAL MACHINE — a local vault, no vault at all, or a window
  // signed into an instance — because the CLIs are on the computer in front of the
  // person and reaching them asks for no credential. A BROWSER HAS NONE, and this suite
  // drives one, so what it can hold is that half: the option is not offered and the
  // screen says why, instead of listing a machine a browser cannot reach.
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('toolbar-agents').click();
  await expect(page.getByTestId('agent-no-machine')).toContainText('A browser reaches no');

  await page.getByTestId('agent-machine').click();
  await expect(page.getByRole('option', { name: 'This machine' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('the local probe answers on a local vault, framed for the parser', async ({ request }) => {
  // The other half, through the route rather than the screen. This server is the same
  // in-process shape a desktop window runs — a local vault, no accounts — so the answer
  // here is the answer there. A deployed instance refuses this outright, which
  // `e2e/server-authz-check.mjs` holds against a real accounts server.
  //
  // What is asserted is the FRAMING, because that is what the parser depends on: one
  // section per adapter, announced by index, and a count before every body. The harness
  // has no agent CLI installed, so each section says the tool is missing — which is an
  // answer, and the shape of one.
  const res = await request.post('/api/agents/probe-local', {
    data: { command: "sh -c \"echo '__tool__ 0'; echo '__missing__'\"" },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.exitStatus).toBe(0);
  expect(body.stdout).toContain('__tool__ 0');
  expect(body.stdout).toContain('__missing__');
});

test('the manage route is served and gated open on a local vault', async ({ request }) => {
  // The other half of the manager, through the route. A removal is the SAME transport and
  // the SAME gate as a listing — a gate decides whether Rite generates the traffic, never
  // what a person may do on a host — and it carries a name of its own so that a route
  // running `rm` is not called `probe` in a log.
  //
  // What is run here is harmless on purpose: the command is the client's (`agentRemoveCmd`
  // builds it, and refuses any path not named by the conversation's own id), so what this
  // holds is that the route exists, answers, and reports the status the view reads.
  const ok = await request.post('/api/agents/manage-local', {
    data: { command: "sh -c 'exit 0'" },
  });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).exitStatus).toBe(0);

  // And a failure comes back AS a failure: the view drops a card only on a zero status,
  // so a non-zero one that arrived as a 200 with no status would delete a row whose file
  // is still there.
  const bad = await request.post('/api/agents/manage-local', {
    data: { command: "sh -c 'exit 3'" },
  });
  expect(bad.status()).toBe(200);
  expect((await bad.json()).exitStatus).toBe(3);
});

test('the filters are offered without a second grouping to fight the first', async ({ page }) => {
  // ONE GROUPING, THREE FILTERS. The band per CLI is the structure of the page; Claude
  // Code Desktop offers "group by date" beside "group by project" and its open tickets
  // are what that costs — grouped by date a session no longer says which project it is
  // from, and the activity filter stops being offered when the grouping changes.
  //
  // With no machine read yet there is nothing to filter, so what holds here is that the
  // controls appear with the conversations and not before: a row of dead filters over an
  // empty panel is how a screen teaches people to ignore it.
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('toolbar-agents').click();
  await expect(page.getByTestId('agent-manager')).toBeVisible({ timeout: 15_000 });

  await expect(page.getByTestId('agent-since')).toHaveCount(0);
  await expect(page.getByTestId('agent-search')).toHaveCount(0);
  // The name filter has a second condition on top of that: it is not drawn until a
  // conversation has been given a name, because a filter for something nobody has done
  // is how a row of controls teaches people to stop reading it.
  await expect(page.getByTestId('agent-named')).toHaveCount(0);
  await expect(page.getByTestId('agent-only-asked')).toHaveCount(0);
  // And no grouping control at all, in either layout — the two layouts arrange one
  // grouping, they do not offer a second.
  await expect(page.getByTestId('agent-layout-stacked')).toHaveCount(0);
});

test('the CLIs panel names the seven adapters and the commands they will run', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('toolbar-agents').click();
  await page.getByTestId('agent-tools-toggle').click();

  const tools = page.getByTestId('agent-tools');
  await expect(tools).toBeVisible();
  // ALL SEVEN, by name. This panel is the only place a person can read what Rite is about
  // to run on their machines before it runs it, so the list here is the whole shipped set
  // — it was six for a while after Antigravity joined them, which meant the panel could
  // have dropped that one and nothing would have said so.
  for (const name of [
    'Claude Code',
    'Codex CLI',
    'Gemini CLI',
    'Grok',
    'Antigravity',
    'Hermes',
    'opencode',
  ]) {
    await expect(tools).toContainText(name);
  }
  // And the commands themselves, including the two corrections that are invisible unless
  // the text is read: Codex's three directory levels and Grok's history file.
  await expect(tools).toContainText('~/.codex/sessions/*/*/*/*.jsonl');
  await expect(tools).toContainText('~/.grok/sessions/*/*/chat_history.jsonl');
  // A provenance, so "measured" is never assumed of all six.
  await expect(tools).toContainText('vendor docs');
  await expect(tools).toContainText('community');
  // Gemini resumes by position, and the panel marks it rather than letting a number that
  // moves look like an id.
  await expect(tools).toContainText('by index');
});
