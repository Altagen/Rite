import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Wave-1 feature parity, driven through the real app against the harness sshd.
 *
 * These are the features shipped for 0.2.0 on top of the SSH core — pre-connect
 * hook, jump host, port forwarding, snippets and the machine dashboard. Each one
 * has core-level tests; here they are exercised the way a user meets them, so a
 * break in the wiring between the UI, rite-server and rite-core is caught too.
 *
 * Requires the SSH harness: `sh e2e/harness-up.sh` (127.0.0.1:2222, riteuser/ritepass123).
 */

import {
  createCollection,
  createMachine,
  SSH,
  type MachineOpts,
} from './support/localVault';

/** A collection for wave-1 machines; created once, reused by every test here. */
async function machine(api: APIRequestContext, o: MachineOpts): Promise<string> {
  const collectionId = await ensureWave1Collection(api);
  return createMachine(api, collectionId, o);
}

let wave1Collection: string | null = null;
async function ensureWave1Collection(api: APIRequestContext): Promise<string> {
  wave1Collection ??= await createCollection(api, 'e2e-wave1');
  return wave1Collection;
}

/** Trust the harness host key up front so tests don't each fight the modal. */
test.beforeEach(async ({ request }) => {
  await request.put('/api/settings/host_key_verification_mode', { data: { value: 'accept' } });
});

test('pre-connect hook runs before SSH and its output reaches the modal', async ({
  page,
  request,
}) => {
  await machine(request, { name: 'e2e-preconnect-ok', preconnect: 'echo PRECONNECT_RAN_OK' });

  await page.goto('/');
  await page.getByText('e2e-preconnect-ok').dblclick();

  // The hook runs in its own live terminal before any SSH traffic.
  const dialog = page.getByRole('dialog', { name: 'Running pre-connect' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  // The hook's output streams into the modal's own live terminal.
  await expect(dialog.locator('.xterm-rows')).toContainText('PRECONNECT_RAN_OK', {
    timeout: 20_000,
  });

  // Exit 0 ⇒ the modal closes itself and the SSH session opens.
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 20_000 });
  // Wait for the remote shell's prompt: typing before it is ready loses keystrokes.
  await expect(page.locator('.xterm-rows')).toContainText(`${SSH.username}@`, {
    timeout: 20_000,
  });
  await screen.click();
  await page.keyboard.type('echo RITE_AFTER_HOOK_OK', { delay: 25 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('RITE_AFTER_HOOK_OK', {
    timeout: 20_000,
  });
});

test('a failing pre-connect hook cancels the connection', async ({ page, request }) => {
  // Fail-fast: the second line must never run, and SSH must not open.
  await machine(request, {
    name: 'e2e-preconnect-fail',
    preconnect: 'echo HOOK_FIRST_LINE\nexit 3\necho HOOK_SHOULD_NOT_RUN',
  });

  await page.goto('/');
  await page.getByText('e2e-preconnect-fail').dblclick();

  const dialog = page.getByRole('dialog', { name: 'Running pre-connect' });
  await expect(dialog.locator('.xterm-rows')).toContainText('HOOK_FIRST_LINE', {
    timeout: 20_000,
  });
  await expect(dialog).toContainText('Pre-connect failed', { timeout: 20_000 });
  await expect(dialog.locator('.xterm-rows')).not.toContainText('HOOK_SHOULD_NOT_RUN');

  // The failure is a dead end until the user acts, and nothing was connected: the
  // workspace behind the modal still has no terminal. (Session ids alone can't say
  // this — the hook's own PTY is a session too.)
  await expect(dialog.getByRole('button', { name: /retry/i })).toBeVisible();
  await expect(page.getByText('No active terminal sessions')).toBeVisible();

  // Cancelling leaves the workspace as it was, with no session opened behind it.
  await dialog.getByRole('button', { name: /cancel/i }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('No active terminal sessions')).toBeVisible();
});

test('a connection reaches its target through a jump host', async ({ page, request }) => {
  // The harness sshd plays both roles: the bastion relays a direct-tcpip channel
  // back to itself, which is exactly the hop a real ProxyJump performs.
  const bastionId = await machine(request, { name: 'e2e-bastion' });
  await machine(request, { name: 'e2e-behind-jump', jump: bastionId });

  await page.goto('/');
  await page.getByText('e2e-behind-jump').dblclick();

  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.xterm-rows')).toContainText(`${SSH.username}@`, {
    timeout: 30_000,
  });
  await screen.click();
  await page.keyboard.type('echo RITE_VIA_JUMP_OK', { delay: 25 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('RITE_VIA_JUMP_OK', { timeout: 20_000 });
});

test('a saved port forward starts and is reported as listening', async ({ page, request }) => {
  // Forward to the sshd itself: a port we know answers from the target's side.
  await machine(request, {
    name: 'e2e-forward',
    forwards: [
      { forwardType: 'local', localPort: 15432, remoteHost: '127.0.0.1', remotePort: 2222 },
    ],
  });

  await page.goto('/');
  // Single click opens the machine dashboard (double click connects).
  await page.getByText('e2e-forward').click();
  await expect(page.getByText('Port forwarding')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: /manage/i }).click();
  const dialog = page.getByRole('dialog', { name: 'Port forwarding' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // The tunnel is really up: rite-core reports it among the running forwards.
  const running = await (await request.get('/api/forwards')).json();
  expect(running.length, 'the forward should be running server-side').toBe(1);
  expect(running[0].remotePort).toBe(2222);

  await dialog.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeVisible({
    timeout: 20_000,
  });
});

test('the dashboard card starts and stops a forward inline', async ({ page, request }) => {
  // The mock lets you act on a forward from the card itself — status, Start/Stop,
  // remove — rather than only from the manage modal. This pins that behaviour.
  await machine(request, {
    name: 'e2e-fwd-card',
    forwards: [
      { forwardType: 'local', localPort: 15987, remoteHost: '127.0.0.1', remotePort: 2222 },
    ],
  });

  await page.goto('/');
  await page.getByText('e2e-fwd-card').click();
  await expect(page.getByText('Port forwarding')).toBeVisible({ timeout: 20_000 });

  const card = page.locator('div').filter({ hasText: /^Port forwarding/ }).first();
  await expect(card.getByText('127.0.0.1:15987 → 127.0.0.1:2222')).toBeVisible();

  // Start it from the card, without opening Manage…
  await card.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  // The header counts what is live.
  await expect(page.getByText('1 live')).toBeVisible();

  // It really is listening, not just relabelled.
  const running = await (await request.get('/api/forwards')).json();
  expect(running.some((f: { remotePort: number }) => f.remotePort === 2222)).toBeTruthy();

  await card.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Start', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('1 live')).toBeHidden();
});

test('a snippet runs in the focused pane', async ({ page, request }) => {
  await machine(request, { name: 'e2e-snippets' });

  await page.goto('/');
  await page.getByText('e2e-snippets').dblclick();
  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.xterm-rows')).toContainText(`${SSH.username}@`, {
    timeout: 20_000,
  });

  await page.getByTitle('Snippets', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Snippets' });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Name').fill('e2e-hello');
  await dialog.getByLabel(/Command/).fill('echo RITE_SNIPPET_OK');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();

  // The library ships with a few defaults, so act on our own row, not the first.
  const row = dialog.locator('li').filter({ hasText: 'e2e-hello' });
  await expect(row).toHaveCount(1);
  // Running types the command into the pane and presses Enter for you.
  await row.getByTitle('Run on this pane').click();
  await expect(page.locator('.xterm-rows')).toContainText('RITE_SNIPPET_OK', { timeout: 20_000 });
});

test('the machine dashboard probes the host and degrades gracefully', async ({ page, request }) => {
  await machine(request, { name: 'e2e-dashboard' });

  await page.goto('/');
  await page.getByText('e2e-dashboard').click();

  // Identity + the always-present Overview card.
  await expect(page.getByText('Overview')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(`${SSH.username}@${SSH.hostname}`).first()).toBeVisible();

  // Containers and Services probe the host over SSH. What matters here is that both
  // resolve to a definite answer and neither hangs on "Detecting…" nor surfaces a
  // probe error — whether the host turns out to have a runtime is the harness's
  // business, and wave1-dashboard.spec.ts covers what a host that does looks like.
  await expect(page.getByText('Containers')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Detecting…')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(/Couldn't detect/)).toHaveCount(0);
});

/**
 * Splitting a pane: plain by default, configurable beyond that.
 *
 * The split button must keep splitting plainly — that is what most people want from
 * a divider, and a menu in the way is a tax on all of them for the benefit of the
 * few who want `top` on the right. Everything configurable lives behind the chevron
 * beside it, and a preset that only exists in the author's head is not configurable.
 */
test('a split opens a plain terminal, and a preset opens a named one', async ({ page, request }) => {
  await machine(request, { name: 'e2e-splits' });

  await page.goto('/');
  await page.getByText('e2e-splits').dblclick();
  await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.xterm-rows').first()).toContainText(`${SSH.username}@`, {
    timeout: 20_000,
  });
  await expect(page.locator('.xterm-screen')).toHaveCount(1);

  // The plain button splits, with no menu in the way.
  await page.getByTitle(/^Split horizontal/).first().click();
  await expect(page.locator('.xterm-screen')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByRole('menu')).toHaveCount(0);

  // A preset the user wrote: a name, and a command typed into the new pane for them.
  await page.getByTestId('split-more').first().click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByText('Configure splits…').click();

  const dialog = page.getByRole('dialog', { name: 'Splits' });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('preset-name').fill('e2e-preset');
  await dialog.getByTestId('preset-command').fill('echo RITE_PRESET_OK');
  await dialog.getByTestId('add-preset').click();
  await expect(dialog.getByText('e2e-preset')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();

  await page.getByTestId('split-more').first().click();
  await page.getByRole('menu').getByText('e2e-preset').click();
  await expect(page.locator('.xterm-screen')).toHaveCount(3, { timeout: 20_000 });
  // The command is typed into the new pane, the way a snippet is — a preset adds a
  // name and a first command to an ordinary terminal and nothing else.
  // Found by content, not by position: a split puts the new pane beside the one it
  // divided, so the newest pane is not the last one in the DOM.
  await expect(page.locator('.xterm-rows').filter({ hasText: 'RITE_PRESET_OK' })).toHaveCount(1, {
    timeout: 20_000,
  });
  // And it is named after the preset rather than after the shell.
  await expect(page.getByText('e2e-preset', { exact: true })).toBeVisible();
});

/**
 * The keyboard engine, through its table.
 *
 * Four shortcuts used to be written inline in two components as `if (e.ctrlKey && …)`,
 * which is how one of them accepted Cmd and the others did not. The table is the fix
 * and the screen is the proof: a command is listed, remapped, and fires on the new
 * chord rather than the old one.
 */
test('a shortcut can be remapped, and it is the new chord that fires', async ({ page, request }) => {
  await machine(request, { name: 'e2e-keys' });

  await page.goto('/');
  await page.getByText('e2e-keys').dblclick();
  await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.xterm-screen')).toHaveCount(1);

  // The shipped default splits horizontally.
  await page.locator('.xterm-screen').first().click();
  await page.keyboard.press('Control+Shift+H');
  await expect(page.locator('.xterm-screen')).toHaveCount(2, { timeout: 20_000 });

  // Every command is in one table, with what fires it.
  await page.getByTitle('Settings').click();
  await page.getByTestId('settings-nav-keyboard').click();
  const row = page.getByTestId('shortcut-row-pane.splitHorizontal');
  await expect(row).toBeVisible();
  await expect(page.getByTestId('shortcut-binding-pane.splitHorizontal')).toHaveText('Ctrl+Shift+H');

  // Remapped by pressing the keys, not by typing their name.
  await page.getByTestId('shortcut-binding-pane.splitHorizontal').click();
  await expect(page.getByTestId('shortcut-binding-pane.splitHorizontal')).toHaveText('press keys…');
  await page.keyboard.press('Control+Alt+J');
  await expect(page.getByTestId('shortcut-binding-pane.splitHorizontal')).toHaveText('Ctrl+Alt+J');

  // Paste belongs to the terminal and cannot be taken, whatever the user asks.
  await page.getByTestId('shortcut-binding-pane.close').click();
  await page.keyboard.press('Control+Shift+V');
  await expect(page.getByText(/belongs to the terminal/)).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /^(Cancel|Close)$/ }).first().click();

  // The new chord splits; the old one no longer does.
  await page.locator('.xterm-screen').first().click();
  await page.keyboard.press('Control+Shift+H');
  await expect(page.locator('.xterm-screen')).toHaveCount(2);
  await page.keyboard.press('Control+Alt+J');
  await expect(page.locator('.xterm-screen')).toHaveCount(3, { timeout: 20_000 });

  // And the button says so. A tooltip that spells its own chord is a second opinion
  // about the keyboard, which is how `Split vertical (Ctrl+Shift+V)` outlived the
  // default that moved off that chord — the button named a key that did nothing.
  await expect(page.getByTitle('Split horizontal (Ctrl+Alt+J)').first()).toBeVisible();
  await expect(page.getByTitle(/Split horizontal \(Ctrl\+Shift\+H\)/)).toHaveCount(0);
  await expect(page.getByTitle('Split vertical (Ctrl+Shift+D)').first()).toBeVisible();
});

/**
 * A stored override may not hold a chord the terminal needs.
 *
 * The table refuses copy and paste when they are typed, which covers the user who
 * tries it today. It does not cover the override that was already stored before the
 * reserved list grew — and that list will grow. Whoever had taken the chord would
 * keep it, and would be the one user who cannot paste and cannot explain why. So the
 * list is enforced where the bindings are resolved, not only where they are typed.
 */
test('a reserved chord stored as an override is dropped, not honoured', async ({ page }) => {
  await page.goto('/');

  // Written the way a build that predates the reserved list would have written it.
  await page.evaluate(() =>
    localStorage.setItem('rite-shortcuts', JSON.stringify({ 'pane.splitVertical': 'Mod+Shift+V' })),
  );
  await page.reload();

  await page.getByTitle('Settings').click();
  await page.getByTestId('settings-nav-keyboard').click();
  // Back to its default, and listed as a default: no reset arrow, because there is
  // no override left to undo.
  await expect(page.getByTestId('shortcut-binding-pane.splitVertical')).toHaveText('Ctrl+Shift+D');
  await expect(page.getByTestId('shortcut-reset-pane.splitVertical')).toHaveCount(0);
  // A chord that only one command holds is not a conflict, so the absence of the
  // badge here also says the reserved chord did not land on top of something.
  await expect(page.getByTestId('shortcut-conflict-pane.splitVertical')).toHaveCount(0);

  // And it is gone from storage, not merely ignored in memory: left there it would
  // come back the moment someone shortened the reserved list, long after anyone
  // remembers putting it there.
  const stored = await page.evaluate(() => localStorage.getItem('rite-shortcuts'));
  expect(JSON.parse(stored ?? '{}')).toEqual({});
});

/**
 * Settings is a rail of sections, not one long scroll.
 *
 * Eleven sections in one column meant finding the clipboard timeout was a matter of
 * knowing roughly how far down it lived. What this holds is the part that is easy to
 * regress: that only the chosen section is in view, and that the rail never offers an
 * entry leading to a section this context does not have.
 */
test('settings shows one section at a time, chosen from the rail', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Settings').click();

  // It opens on the first section, and that one only.
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Clipboard', exact: true })).toBeHidden();

  // The rail switches which one is in view.
  await page.getByTestId('settings-nav-clipboard').click();
  await expect(page.getByRole('heading', { name: 'Clipboard', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeHidden();

  // Keyboard and Splits are reachable from it rather than scrolled to.
  await page.getByTestId('settings-nav-keyboard').click();
  await expect(page.getByTestId('shortcut-row-pane.close')).toBeVisible();
  await page.getByTestId('settings-nav-splits').click();
  await expect(page.getByTestId('open-splits-settings')).toBeVisible();
  await expect(page.getByTestId('open-layouts-settings')).toBeVisible();

  // Focus mode belongs to the native shell; the browser must not be offered it.
  await expect(page.getByTestId('settings-nav-focus')).toHaveCount(0);
});

/**
 * A preset and a layout can be changed, not just made and unmade.
 *
 * The first version could only add and remove, so correcting a typo in a command was
 * "delete it, retype the other field, add it again" — and for a five-pane layout that
 * is five lines retyped to fix one. An entry you cannot edit is a list you stop
 * trusting, and the layout round-trip is what proves the editor is not rewriting the
 * panes it was only meant to show.
 */
test('a preset is editable, and a layout opens from the tab strip', async ({ page, request }) => {
  await machine(request, { name: 'e2e-editable' });

  await page.goto('/');
  await page.getByText('e2e-editable').dblclick();
  await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.xterm-screen')).toHaveCount(1);

  // Nothing is configured, so the tab strip offers no Layouts button yet: an empty
  // dropdown beside the tabs is a permanent invitation to find out it is empty.
  await expect(page.getByTestId('layouts-button')).toHaveCount(0);

  await page.getByTestId('split-more').first().click();
  await page.getByRole('menu').getByText('Configure splits…').click();
  const dialog = page.getByRole('dialog', { name: 'Splits' });
  await expect(dialog).toBeVisible();

  // Make one, then change both of its fields in place.
  await dialog.getByTestId('preset-name').fill('typo-name');
  await dialog.getByTestId('preset-command').fill('echo WRONG');
  await dialog.getByTestId('add-preset').click();
  await expect(dialog.getByText('typo-name')).toBeVisible();

  // Scoped to its own row: the shipped defaults have edit buttons too, and a
  // selector that matches three of them would click whichever came first.
  const rows = dialog.locator('li');
  const before = await rows.count();
  await rows.filter({ hasText: 'typo-name' }).getByTestId(/^edit-preset-/).click();
  await expect(dialog.getByTestId('preset-name')).toHaveValue('typo-name');
  await expect(dialog.getByTestId('preset-command')).toHaveValue('echo WRONG');
  await dialog.getByTestId('preset-name').fill('fixed-name');
  await dialog.getByTestId('preset-command').fill('echo RITE_EDITED_OK');
  await dialog.getByTestId('add-preset').click();

  // Edited, not duplicated: the id is kept, so the list is the same length.
  await expect(rows.filter({ hasText: 'fixed-name' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'typo-name' })).toHaveCount(0);
  await expect(rows).toHaveCount(before);
  await expect(dialog.getByText('echo RITE_EDITED_OK')).toBeVisible();

  // A layout, in its own section of the same dialog.
  await dialog.getByTestId('splits-tab-layouts').click();
  await dialog.getByTestId('layout-name').fill('e2e-layout');
  await dialog.getByTestId('layout-panes').fill('one = echo RITE_PANE_ONE\ntwo = echo RITE_PANE_TWO');
  await dialog.getByTestId('add-layout').click();
  await expect(dialog.getByText('e2e-layout')).toBeVisible();

  // Re-opening it shows the panes as written — the editor must not rewrite what it
  // was only asked to display.
  await dialog.getByTestId(/^edit-layout-/).click();
  await expect(dialog.getByTestId('layout-panes')).toHaveValue(
    'one = echo RITE_PANE_ONE\ntwo = echo RITE_PANE_TWO',
  );
  await dialog.getByTestId('cancel-edit').click();
  await dialog.getByRole('button', { name: 'Close' }).click();

  // Now the tab strip has the button, and it opens the whole arrangement.
  await page.getByTestId('layouts-button').click();
  await page.getByRole('menu', { name: /Layouts/ }).getByText('e2e-layout').click();
  await expect(page.locator('.xterm-screen')).toHaveCount(3, { timeout: 20_000 });
  await expect(page.locator('.xterm-rows').filter({ hasText: 'RITE_PANE_ONE' })).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(page.locator('.xterm-rows').filter({ hasText: 'RITE_PANE_TWO' })).toHaveCount(1, {
    timeout: 20_000,
  });
});
