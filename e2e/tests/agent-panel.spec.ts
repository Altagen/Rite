import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { ensureCollection, createMachine, listMachines, SSH } from './support/localVault';

/**
 * THE DETAIL PANEL, over a real SSH session, against a machine that has conversations.
 *
 * It had no end-to-end coverage at all, and that is where two real defects lived: the
 * live read's `let live = true` with no cleanup to flip it, and `MarksSupport::File`
 * carrying a path both handlers threw away and recomputed. Neither was visible from a
 * test of the piece concerned; both were found by a linter noticing something odd.
 *
 * WHY THIS COULD NOT BE WRITTEN BEFORE, and what changed. Discovery is gated on
 * `command -v claude` (agentProbe.ts), so a machine with transcripts and no CLI reports
 * the tool absent and reads nothing. `e2e/agent-stubs.sh` now puts a stub on the
 * container's PATH and seeds three conversations under `riteuser`'s home — the same
 * arrangement `dashboard-stubs.sh` has always had for `docker` and `systemctl`, and for
 * the same reason: what is under test is Rite's reading of a machine, not the vendor's
 * binary.
 *
 * The three conversations are each for one answer the panel has to be able to give: a
 * directory that is a clean git repository, a directory that is GONE, and a first prompt
 * long enough to be folded.
 */

const WORK = '/home/riteuser/work';

/**
 * Run something on the harness machine, as the account Rite signs in as.
 *
 * The point of several tests here is that a fact about the MACHINE changed and the UI
 * cannot have known — so the change has to come from outside Rite entirely. `podman exec`
 * is the only way to be sure of that; going through Rite's own exec route would prove the
 * read sees what Rite just did, which is a different and much weaker statement.
 */
const onMachine = (cmd: string) =>
  execFileSync('podman', ['exec', '-u', 'riteuser', 'rite-sshd', 'sh', '-lc', cmd], {
    encoding: 'utf8',
  });
const CLEAN = '0191e5a1-0001-7000-8000-000000000001';
const GONE = '0191e5a1-0002-7000-8000-000000000002';
const LONG = '0191e5a1-0003-7000-8000-000000000003';
/** Seeded by the test that removes it, so the spec can be run twice. */
const DOOMED = '0191e5a1-0009-7000-8000-000000000009';

/** Probe the seeded machine and leave the manager open on its cards. */
async function probed(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
) {
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
  const collection = await ensureCollection(request, 'e2e-agent-panel');
  // ONCE, not once per test. `ensureCollection` reuses the collection, so creating the
  // machine unconditionally added another of the same name on every test and the picker
  // ended up offering eight — which Playwright reports as a strict-mode violation rather
  // than as the setup bug it is.
  const machines = (await listMachines(request, collection)) as unknown as { name: string }[];
  if (!machines.some((m) => m.name === 'e2e-panel-host')) {
    await createMachine(request, collection, {
      name: 'e2e-panel-host',
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
  await page.getByRole('option', { name: 'e2e-panel-host' }).click();
  await page.getByTestId('agent-probe').click();
  // One SSH round trip, then a card per transcript.
  await expect(page.getByTestId(`agent-card-${CLEAN}`)).toBeVisible({ timeout: 30_000 });
}

test('the probe finds what is on the machine, and the panel reads the rest live', async ({
  page,
  request,
}) => {
  await probed(page, request);
  await expect(page.getByTestId(`agent-card-${GONE}`)).toBeVisible();
  await expect(page.getByTestId(`agent-card-${LONG}`)).toBeVisible();

  await page.getByTestId(`agent-card-${CLEAN}`).click();
  await expect(page.getByTestId('agent-detail')).toBeVisible();

  // THE WHOLE LIVE READ, which no card carries and nothing keeps: the directory, the
  // branch it stands on NOW, and whether that tree is clean. A branch on a card would be
  // read as current and go stale at the next `git switch`.
  const live = page.getByTestId('agent-detail-live');
  await expect(live).toContainText(WORK, { timeout: 30_000 });
  await expect(live).toContainText('main');
  await expect(live).toContainText('clean');
});

test('a directory that is gone is named, not replaced by a stale branch', async ({
  page,
  request,
}) => {
  await probed(page, request);
  await page.getByTestId(`agent-card-${GONE}`).click();
  await expect(page.getByTestId('agent-detail')).toBeVisible();

  // The conversation records a directory that no longer exists. The panel has to SAY that
  // — the alternative is the shape of mistake this read exists to avoid, a branch nobody
  // is on shown as if it were current.
  const live = page.getByTestId('agent-detail-live');
  await expect(live).toContainText('/home/riteuser/nowhere-at-all', { timeout: 30_000 });
  await expect(live).not.toContainText('main');
});

test('the facts and the actions are above the prompt, which is folded', async ({
  page,
  request,
}) => {
  await probed(page, request);
  await page.getByTestId(`agent-card-${LONG}`).click();
  await expect(page.getByTestId('agent-detail')).toBeVisible();

  // THE ORDER IS THE DECISION. The panel used to lead with the first prompt, and a pasted
  // diff pushed every action off the bottom — so a conversation nobody could act on. The
  // prompt is below, folded, and the fold is only offered when there is something to
  // unfold: this one is forty clauses long.
  const resume = page.getByTestId('agent-detail-resume');
  const ask = page.getByTestId('agent-detail-ask');
  await expect(resume).toBeVisible();
  await expect(ask).toBeVisible();
  const [resumeBox, askBox] = [await resume.boundingBox(), await ask.boundingBox()];
  expect(resumeBox!.y, 'Resume must sit above the prompt').toBeLessThan(askBox!.y);

  const more = page.getByTestId('agent-detail-ask-more');
  await expect(more).toBeVisible();
  const folded = (await ask.boundingBox())!.height;
  await more.click();
  expect((await ask.boundingBox())!.height, 'unfolding must show more').toBeGreaterThan(folded);
});

test('the branch moves on the machine, and asking again says so', async ({ page, request }) => {
  await probed(page, request);
  await page.getByTestId(`agent-card-${CLEAN}`).click();
  await expect(page.getByTestId('agent-detail-live')).toContainText('main', { timeout: 30_000 });

  // THE BRANCH MOVES UNDER RITE'S FEET, which is the entire argument for reading it when
  // the panel opens instead of carrying it on a card. Switched in the container, so
  // nothing in the UI can know — and this is what the test is for: a cached answer would
  // still say `main` and send somebody to resume against the wrong tree.
  onMachine(`git -C ${WORK} switch -q -c a-new-branch`);
  try {
    await page.getByTestId('agent-detail-live-again').click();
    await expect(page.getByTestId('agent-detail-live')).toContainText('a-new-branch', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('agent-detail-live')).not.toContainText('main');
  } finally {
    onMachine(`git -C ${WORK} switch -q main && git -C ${WORK} branch -q -D a-new-branch`);
  }
});

test('a dirty tree is reported as dirty, and cleaning it is reported too', async ({
  page,
  request,
}) => {
  await probed(page, request);
  onMachine(`touch ${WORK}/a-stray-file`);
  try {
    await page.getByTestId(`agent-card-${CLEAN}`).click();
    await expect(page.getByTestId('agent-detail-live')).toContainText('uncommitted changes', {
      timeout: 30_000,
    });
  } finally {
    onMachine(`rm -f ${WORK}/a-stray-file`);
  }

  // And the panel is keyed by the conversation, so reopening it asks again rather than
  // showing what the last open found.
  await page.getByTestId('agent-detail-close').click();
  await page.getByTestId(`agent-card-${CLEAN}`).click();
  await expect(page.getByTestId('agent-detail-live')).toContainText('clean', { timeout: 30_000 });
});

test('a conversation is removed behind a confirmation, and the card goes with it', async ({
  page,
  request,
}) => {
  // ITS OWN TRANSCRIPT, because this test destroys what it acts on. Consuming one of the
  // three the harness seeds made the spec pass once and fail on every run after, which is
  // a test that reports on the order it was run in rather than on the code.
  const slug = '/home/riteuser/.claude/projects/-home-riteuser-work';
  onMachine(
    `printf '{"type":"mode","cwd":"${WORK}"}\n{"type":"user","message":{"role":"user","content":[{"type":"text","text":"delete me"}]}}\n' > ${slug}/${DOOMED}.jsonl`,
  );

  await probed(page, request);
  await page.getByTestId(`agent-card-${DOOMED}`).click();
  await expect(page.getByTestId('agent-detail')).toBeVisible();

  // Claude Code's listing names a file, so this tool CAN remove — three of the seven name
  // none and show no button at all, which is why the affordance is per adapter.
  await page.getByTestId('agent-detail-delete').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  // The confirmation names the file, because "are you sure" about an unnamed thing is not
  // a question anybody can answer.
  await expect(page.getByTestId('confirm-dialog')).toContainText(DOOMED);

  // Refusing leaves it alone — the half of a confirmation nothing usually tests.
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId(`agent-card-${DOOMED}`)).toBeVisible();

  await page.getByTestId('agent-detail-delete').click();
  await page.getByTestId('confirm-accept').click();

  // THE CARD GOES BECAUSE THE FILE DID, and this is the assertion that found a defect in
  // the SSH exec path: `rm -f` prints nothing, the reader broke out of its loop on `Eof`
  // before the exit status arrived, and a removal that had happened was reported as
  // "Removal failed, exit null" with the card still on screen. Held here and in
  // `a_silent_command_still_reports_that_it_succeeded`, which pins the message order.
  await expect(page.getByTestId(`agent-card-${DOOMED}`)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('agent-remove-failed')).toHaveCount(0);
  // And the ones nobody asked about are still there.
  await expect(page.getByTestId(`agent-card-${CLEAN}`)).toBeVisible();
  await expect(page.getByTestId(`agent-card-${GONE}`)).toBeVisible();
  // Gone on the MACHINE, not only from the screen.
  expect(onMachine(`ls ${slug} || true`)).not.toContain(DOOMED);
});

/**
 * WHAT IS IN EFFECT (ADR 0022 §6), read on a gesture and shown read-only.
 *
 * The harness seeds both layers with one deliberate collision: `commit-conventions`
 * exists in the project AND in the account, so the project's wins and the account's has
 * to be shown LOSING. That is the assertion that matters — a list of what loaded is easy,
 * a list that explains why somebody's own skill did nothing is the feature.
 */
test('both layers are read, and the copy that lost is shown losing', async ({ page, request }) => {
  await probed(page, request);
  await page.getByTestId(`agent-card-${CLEAN}`).click();
  // It resolves against the DIRECTORY, so it waits for the live read to name one.
  await expect(page.getByTestId('agent-detail-live')).toContainText(WORK, { timeout: 30_000 });

  // BEHIND A BUTTON. A second SSH round trip, and most opens of this panel are to resume
  // something — so it is asked for, like discovery itself.
  await expect(page.getByTestId('agent-context')).toHaveCount(0);
  await page.getByTestId('agent-context-open').click();
  await expect(page.getByTestId('agent-context')).toBeVisible({ timeout: 30_000 });

  // The account it was resolved under, which is a fact about the read. Whether that
  // account is SHARED is not something a machine can be asked, so nothing claims it.
  await expect(page.getByTestId('agent-context-account')).toContainText('riteuser');

  // The project layer's skills, and the account's.
  await expect(page.getByTestId('agent-context-skill-project-deploy-runbook')).toBeVisible();
  await expect(page.getByTestId('agent-context-skill-user-rust-review')).toBeVisible();

  // THE COLLISION. Both copies are on screen; the account's is struck through and says
  // why, because a reader whose own skill did nothing needs to see it rather than wonder.
  const mine = page.getByTestId('agent-context-skill-user-commit-conventions');
  await expect(page.getByTestId('agent-context-skill-project-commit-conventions')).toBeVisible();
  await expect(mine).toBeVisible();
  await expect(mine).toContainText('shadowed');

  // Every row carries the path it came from, because that is the answer to "why".
  await expect(mine).toContainText('/home/riteuser/.claude/skills/commit-conventions/SKILL.md');

  await expect(page.getByTestId('agent-context-command-project-gate')).toContainText('/gate');
  await expect(page.getByTestId('agent-context-command-user-adr')).toContainText('/adr');
});

test('a hook shows the command it will run, and an unreadable file is said', async ({
  page,
  request,
}) => {
  await probed(page, request);
  await page.getByTestId(`agent-card-${CLEAN}`).click();
  await expect(page.getByTestId('agent-detail-live')).toContainText(WORK, { timeout: 30_000 });
  await page.getByTestId('agent-context-open').click();
  await expect(page.getByTestId('agent-context')).toBeVisible({ timeout: 30_000 });

  // A HOOK IS A COMMAND THAT RUNS LATER, UNATTENDED, so the command itself is on the row
  // rather than hidden behind the event's name.
  await expect(page.getByTestId('agent-context-hook-posttooluse')).toContainText('ruff format');
  const unasked = page.getByTestId('agent-context-hook-pretooluse');
  await expect(unasked).toContainText('audit-everything');
  // The account layer's one, which nobody working in this directory installed — the exact
  // case ADR 0022 §6 uses to argue for read-only.
  await expect(unasked).toContainText('/home/riteuser/.claude/settings.json');

  // AND A FILE RITE COULD NOT PARSE IS NAMED. A panel showing fewer hooks than will fire
  // is worse than one admitting it could not read something.
  await expect(page.getByTestId('agent-context-unreadable')).toContainText('settings.local.json');

  // Said on the panel, not only in a doc: whoever is deciding whether to trust this needs
  // to know Rite wrote none of it.
  await expect(page.getByTestId('agent-context')).toContainText('never written');
});
