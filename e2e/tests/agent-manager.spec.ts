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

test('the CLIs panel names the six adapters and the commands they will run', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('toolbar-agents').click();
  await page.getByTestId('agent-tools-toggle').click();

  const tools = page.getByTestId('agent-tools');
  await expect(tools).toBeVisible();
  // The six, by name. This panel is the only place a person can read what Rite is about
  // to run on their machines before it runs it.
  for (const name of ['Claude Code', 'Codex CLI', 'Gemini CLI', 'Grok', 'Hermes', 'opencode']) {
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
