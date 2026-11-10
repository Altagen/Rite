import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createMachine, ensureCollection, listMachines, SSH } from './support/localVault';

/**
 * THE MANAGER'S OWN SURFACE — the cards, the bands, the two layouts and the mark dialog.
 *
 * These are the decisions `design/mock/` used to hold, asked of the shipped screen. The
 * mock was drawn first (ADR 0019) and then kept as documentation, which is where it went
 * wrong: it still showed a git branch on a card and a turn count after the code had
 * MEASURED both and refused them, and it listed six adapters while seven ship. A drawing
 * that disagrees with the product describes a product that does not exist.
 *
 * The seeded machine comes from `e2e/agent-stubs.sh`, so there are real transcripts to
 * read over a real SSH session.
 */

const WORK = '/home/riteuser/work';
const CLEAN = '0191e5a1-0001-7000-8000-000000000001';
const GONE = '0191e5a1-0002-7000-8000-000000000002';
const LONG = '0191e5a1-0003-7000-8000-000000000003';

/** The seeded machine's own id — what a mark is keyed on. */
async function machineId(request: APIRequestContext): Promise<string> {
  const collection = await ensureCollection(request, 'e2e-agent-cards');
  const machines = (await listMachines(request, collection)) as unknown as {
    id: string;
    name: string;
  }[];
  const found = machines.find((m) => m.name === 'e2e-cards-host');
  expect(found, 'the seeded machine is gone').toBeTruthy();
  return found!.id;
}

/** Probe the seeded machine and leave the manager showing its cards. */
async function probed(page: Page, request: APIRequestContext) {
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
  const collection = await ensureCollection(request, 'e2e-agent-cards');
  const machines = (await listMachines(request, collection)) as unknown as { name: string }[];
  if (!machines.some((m) => m.name === 'e2e-cards-host')) {
    await createMachine(request, collection, {
      name: 'e2e-cards-host',
      hostname: SSH.hostname,
      port: SSH.port,
      username: SSH.username,
      password: SSH.password,
    });
  }
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('toolbar-agents').click();
  await expect(page.getByTestId('agent-manager')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('agent-machine').click();
  await page.getByRole('option', { name: 'e2e-cards-host' }).click();
  await page.getByTestId('agent-probe').click();
  await expect(page.getByTestId(`agent-card-${CLEAN}`)).toBeVisible({ timeout: 30_000 });
}

test('a card says which conversation it is, and refuses two things it could say', async ({
  page,
  request,
}) => {
  await probed(page, request);
  const card = page.getByTestId(`agent-card-${CLEAN}`);

  // What identifies it: what was typed, and where it runs.
  await expect(card).toContainText('Read the worker queue');

  // NOT A BRANCH. A branch is true at the moment it is read, so on a card it is read as
  // current and goes stale at the next `git switch` — which is how somebody resumes
  // against the wrong tree. It is read live when the panel opens and kept nowhere, and
  // the panel is where `agent-panel.spec.ts` holds it.
  await expect(card).not.toContainText('main');

  // NOT A TURN COUNT, which is a refusal rather than a gap: it needs the whole
  // transcript, and `"type":"user"` is not a turn — on a real 1.1 GB transcript it
  // appears 14 091 times, because a tool result carries the same type.
  await expect(card).not.toContainText(/\bturns?\b/i);

  // AND NOTHING CLAIMS IT IS RUNNING. A transcript written twenty seconds ago by a
  // session that has since exited is byte-for-byte one written by a session mid-answer,
  // so the manager says when it was last WRITTEN and never that it is alive.
  await expect(page.getByTestId('agent-manager')).not.toContainText(/\brunning\b/i);
});

test('a band folds, and the fold is per CLI', async ({ page, request }) => {
  await probed(page, request);
  const band = page.getByTestId('agent-band-claude');
  await expect(band).toBeVisible();
  await expect(page.getByTestId(`agent-card-${CLEAN}`)).toBeVisible();

  await page.getByTestId('agent-fold-claude').click();
  await expect(
    page.getByTestId(`agent-card-${CLEAN}`),
    'folding a band hides its cards and keeps its heading',
  ).toHaveCount(0);
  await expect(band).toBeVisible();

  await page.getByTestId('agent-fold-claude').click();
  await expect(page.getByTestId(`agent-card-${CLEAN}`)).toBeVisible();
});

/**
 * WHICH TOOLS THE SURFACE TALKS ABOUT, which is three states and not two.
 *
 * A tool that answered gets a band. A tool that is INSTALLED and could not answer keeps
 * a note of its own, with the status and what it printed: that is the one state with
 * something a reader can do about it, and "no conversations" for a tool that never got
 * to look is the silence that costs an hour. A tool that is simply not there is not
 * mentioned at all — six empty blocks per machine is how a surface stops being read.
 *
 * Both halves come off `e2e/agent-stubs.sh`: `claude` answers, `opencode` is on PATH and
 * exits 3, and the other five adapters are not installed on the harness host.
 */
test('only a tool that answered gets a band, and one that could not says so', async ({
  page,
  request,
}) => {
  await probed(page, request);

  // One band, for the one CLI that answered with conversations.
  await expect(page.getByTestId('agent-band-claude')).toBeVisible();
  await expect(page.locator('[data-testid^="agent-band-"]')).toHaveCount(1);

  // The installed tool that could not answer, with the facts and not a guess at why.
  const broken = page.getByTestId('agent-broken-opencode');
  await expect(broken).toContainText('opencode');
  await expect(broken).toContainText('Exit 3');
  await expect(broken).toContainText('no session server');

  // And nothing anywhere about the five that are not installed. Asserted by NAME on the
  // whole surface rather than by a selector, because the failure this guards against is
  // a block, a card or a foot line being added for them — any of which a count of bands
  // would miss. The Tools panel is folded away, and it is the one place the seven are
  // listed on purpose (`agent-manager.spec.ts`).
  const manager = page.getByTestId('agent-manager');
  for (const absent of ['Codex CLI', 'Gemini CLI', 'Grok', 'Antigravity', 'Hermes']) {
    await expect(manager, `${absent} is not on this machine`).not.toContainText(absent);
  }
});

test('the two layouts arrange the same conversations', async ({ page, request }) => {
  await probed(page, request);
  const ids = async () =>
    (
      await page
        .locator('[data-testid^="agent-card-"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
    ).sort();

  const stacked = await ids();
  expect(stacked.length, 'the probe found nothing, so this compares nothing').toBeGreaterThan(1);

  await page.getByTestId('agent-layout-rail').click();
  await expect(page.getByTestId('agent-rail')).toBeVisible();
  // ONE SET OF ROWS, TWO ARRANGEMENTS. The question the two layouts exist to answer is
  // which survives a fleet, and that is only a fair question if they show the same thing.
  expect(await ids(), 'the rail shows different conversations from the bands').toEqual(stacked);

  await page.getByTestId('agent-layout-stacked').click();
  await expect(page.getByTestId('agent-band-claude')).toBeVisible();
});

/**
 * SEARCH IS ONE FIELD OVER EVERYTHING A PERSON TYPED OR A HOST SAID.
 *
 * Which is the half of the filters that composes with the grouping instead of fighting
 * it: the ask, the project, the id, the CLI and a mark's own name and labels all answer
 * the same box, because the thing somebody remembers about a conversation is not
 * reliably the field a designer chose for it. A branch is NOT in that list — it is read
 * live and kept nowhere, so a search on it would answer about a tree as it was.
 *
 * And a query that matches nothing says so WITH THE QUERY IN IT and how many there are
 * in all: an empty grid reads as a broken view, and three filters can each empty it.
 */
test('one field searches the ask, the project, the id and the CLI', async ({ page, request }) => {
  await probed(page, request);
  const cards = page.locator('[data-testid^="agent-card-"]');
  const all = await cards.count();
  expect(all, 'the probe found nothing, so this narrows nothing').toBe(3);

  const search = page.getByTestId('agent-search');
  for (const [q, only] of [
    // the ask, which is what the person typed
    ['worker queue', CLEAN],
    // the directory the listing reported — `project` and the row's own label are the
    // same string for this adapter, which is why the mutation that proves this line
    // has to take both away
    ['riteuser-gone', GONE],
    // the id, for somebody holding a transcript name
    ['0003-7000', LONG],
  ] as const) {
    await search.fill(q);
    await expect(cards, `${q} narrows to one`).toHaveCount(1);
    await expect(page.getByTestId(`agent-card-${only}`)).toBeVisible();
  }

  // The CLI's own name, which narrows to nothing here on purpose: every conversation on
  // this machine is Claude Code's, so the assertion is that the field reaches the
  // adapter at all rather than that it filters.
  await search.fill('claude code');
  await expect(cards).toHaveCount(all);

  // Nothing matches: the query is on screen, and so is what it was asked of.
  await search.fill('zzzz-no-such-thing');
  await expect(cards).toHaveCount(0);
  const note = page.getByTestId('agent-no-match');
  await expect(note).toContainText('zzzz-no-such-thing');
  await expect(note).toContainText(String(all));

  await search.fill('');
  await expect(cards).toHaveCount(all);
});

test('every machine at once aggregates what was read, and asks nothing', async ({
  page,
  request,
}) => {
  await probed(page, request);
  const before = await page.locator('[data-testid^="agent-card-"]').count();

  await page.getByTestId('agent-machine').click();
  await page.getByRole('option', { name: /all machines/i }).click();

  // NEVER A PROBE. `@all` is every answer already held, so there is nothing to ask and
  // no button that would ask it — a view that probed on open would spend an SSH round
  // trip for arriving at a screen.
  await expect(page.getByTestId('agent-probe')).toHaveCount(0);
  expect(await page.locator('[data-testid^="agent-card-"]').count()).toBe(before);
});

test('a conversation is given a name, a colour and labels, without losing the ask', async ({
  page,
  request,
}) => {
  await probed(page, request);
  await page.getByTestId(`agent-rename-${LONG}`).click();
  await expect(page.getByTestId('agent-rename-dialog')).toBeVisible();

  await page.getByTestId('agent-rename-input').fill('The queue work');
  await page.getByTestId('agent-color-f7768e').click();
  await page.getByTestId('agent-labels-input').click();
  await page.getByTestId('agent-labels-input').fill('cardspec');
  await page.getByTestId('agent-labels-create').click();
  await page.getByTestId('agent-rename-save').click();

  const card = page.getByTestId(`agent-card-${LONG}`);
  // THE NAME IS THE HEADLINE AND THE ASK SURVIVES IT. The ask is the one thing nobody
  // can reconstruct, so naming a conversation must not replace it.
  await expect(card).toContainText('The queue work');
  await expect(card).toContainText('Here is the whole diff');
  await expect(card).toContainText('cardspec');

  // THE DOCUMENT KEYS ON THE MACHINE'S REFERENCE, NEVER ON ITS NAME. An id is
  // meaningless without the store that resolves it, so a row read out of context says
  // nothing about which host it is about — which is most of what sealing it is worth.
  // A name would also move the mark when the machine is renamed.
  const doc = JSON.parse((await (await request.get('/api/marks')).json()).text ?? '{}') as {
    marks?: { machine: string; tool: string; id: string; name?: string }[];
  };
  const row = (doc.marks ?? []).find((m) => m.id === LONG);
  expect(row, 'the name was not written to the marks document').toBeTruthy();
  expect(row!.name).toBe('The queue work');
  expect(row!.machine, 'the mark was keyed on the name a reader typed').not.toBe('e2e-cards-host');
  expect(row!.machine).toBe(await machineId(request));

  // And clearing all three removes the record rather than storing an empty one.
  await page.getByTestId(`agent-rename-${LONG}`).click();
  await page.getByTestId('agent-rename-clear').click();
  await expect(card).not.toContainText('The queue work');
  await expect(card).toContainText('Here is the whole diff');
});

test('resuming opens a pane and leaves the manager standing', async ({ page, request }) => {
  await probed(page, request);
  await page.getByTestId(`agent-resume-${GONE}`).click();

  // A PANE IN ITS OWN TAB, not a replacement for the list it was chosen from: an agent
  // does not take over the manager, and does not split the pane somebody was working in.
  await expect(page.getByTestId('nav-agents')).toBeVisible({ timeout: 30_000 });

  // AND IT IS A LEAF OF THE ORDINARY SPLIT TREE, which is the whole argument for
  // registering a pane kind instead of building a second view: `top` or a
  // `watch docker ps` sits beside the agent that is causing them, on the same machine
  // and in the same tab. The one action that is the agent's own is the conversation's
  // id — the reader never typed it and could not reach it with Rite closed.
  await expect(page.getByTestId('agent-copy-id')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.xterm-screen')).toHaveCount(1, { timeout: 30_000 });
  await page
    .getByTitle(/^Split horizontal/)
    .first()
    .click();
  await expect(page.locator('.xterm-screen')).toHaveCount(2, { timeout: 30_000 });
  // The agent is still the one that was resumed, beside a plain terminal that is not
  // an agent: one copy-id button, not two.
  await expect(page.getByTestId('agent-copy-id')).toHaveCount(1);

  await page.getByTestId('nav-agents').click();
  await expect(page.getByTestId('agent-manager')).toBeVisible();
  await expect(page.getByTestId(`agent-card-${GONE}`)).toBeVisible();
});

/**
 * THE DRAWER BELONGS TO NEITHER LAYOUT, which is why it is tested across both.
 *
 * It opens beside the bands and beside the rail, so the seam that later integrations
 * arrive through does not belong to one arrangement — and switching layouts with a
 * conversation open must not drop it. What is IN the drawer is held by
 * `agent-panel.spec.ts`; this is about where it lives.
 */
test('the detail panel opens beside either layout, and survives the switch', async ({
  page,
  request,
}) => {
  await probed(page, request);
  await expect(page.getByTestId('agent-detail')).toHaveCount(0);

  await page.getByTestId(`agent-card-${CLEAN}`).click();
  await expect(page.getByTestId('agent-detail')).toBeVisible();
  await expect(page.getByTestId('agent-band-claude'), 'the bands are still there').toBeVisible();

  await page.getByTestId('agent-layout-rail').click();
  await expect(page.getByTestId('agent-rail')).toBeVisible();
  await expect(
    page.getByTestId('agent-detail'),
    'switching the arrangement must not close what was open',
  ).toBeVisible();
  await expect(page.getByTestId('agent-detail-live')).toContainText(WORK, { timeout: 30_000 });

  // And its own control closes it, in either arrangement.
  await page.getByTestId('agent-detail-close').click();
  await expect(page.getByTestId('agent-detail')).toHaveCount(0);
  await page.getByTestId('agent-layout-stacked').click();
});
