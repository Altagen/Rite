import { test, expect, type Page } from '@playwright/test';

/**
 * What the admin console does when the instance is configured as code (ADR 0020 §4).
 *
 * The server already refuses the change — `instance-config-check.mjs` proves the 409. This
 * is the other half of the promise, and the one an administrator actually meets: a control
 * they can see must not invite a change the server will reject. It goes inert, and it says
 * which file or variable owns the value, because "greyed out" with no reason sends its
 * reader hunting through a deployment for a variable nobody named.
 *
 * It runs against :1427, which boots from a TOML file (`e2e/serve-accounts-config.sh`).
 * That file declares instance_name, open_registration, allow_quick_ssh and two policies,
 * and deliberately leaves session_persistence and the health-check alone — the lock has to
 * be visible *and* bounded.
 */

const ADMIN = { username: 'cfgadmin', password: 'ConfigAdmin1!' };

// The instance is shared by both tests, so the first creates the administrator and the
// second signs in as them. Serial, for the same reason.
test.describe.configure({ mode: 'serial' });

/**
 * Reach the Instance panel, whichever screen the server is showing: the first-run
 * administrator form on an empty instance, the sign-in form once one exists.
 */
async function openInstancePanel(page: Page) {
  await page.goto('/');
  const bootstrap = page.getByText(/Create the server administrator/i);
  const signIn = page.getByText(/Sign in to the server/i);
  await expect(bootstrap.or(signIn)).toBeVisible({ timeout: 30_000 });

  await page.locator('#username').fill(ADMIN.username);
  await page.locator('#password').fill(ADMIN.password);
  const confirm = page.locator('#confirmPassword');
  if (await confirm.count()) await confirm.fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await page.getByRole('button', { name: 'Instance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Instance' })).toBeVisible({ timeout: 15_000 });
}

test('the console locks what the configuration owns, and names where it is set', async ({ page }) => {
  await openInstancePanel(page);

  // The name is set through a mounted secret, which outranks the `instance_name` the
  // file also declares — so the field and its Save go inert on the variable's authority.
  const nameField = page.locator('#instance-name');
  await expect(nameField).toHaveValue('Set from a secret');
  await expect(nameField).toBeDisabled();

  // And the row names the variable that actually won, not the file it overrode. Getting
  // this wrong would send an operator editing a file that has no effect on this value.
  const nameRow = page.getByText(/Set by this instance's configuration/).first();
  await expect(nameRow).toContainText('RITE__instance_name__FILE');

  // A key the file alone declares is attributed to the file, by path.
  await expect(page.getByText(/Set by this instance's configuration/).filter({ hasText: 'rite.toml' }).first())
    .toBeVisible();

  // A switch the file declares cannot be thrown, and its row says so too.
  await expect(page.getByRole('switch', { name: 'Open registration' })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Allow Quick SSH' })).toBeDisabled();
  // A secrets policy declares the same way (ADR 0024 §4) — and declaring it at all was
  // the gap: the three new policies had their console rows and their routes, and were
  // missing from `config::SETTINGS`, so a file naming one was refused as a typo.
  const reveal = page.getByRole('switch', { name: 'Members may read a stored secret back' });
  await expect(reveal).toBeDisabled();
  await expect(reveal).toHaveAttribute('aria-checked', 'false');
  // And the host-key policy, which had no console row and no validated route at all while
  // the web UI reported it read-only: declared here at `warn`, so the row shows the
  // declared value rather than the default and cannot be changed from the console.
  const hostKey = page.getByTestId('instance-host-key-mode');
  await expect(hostKey).toBeDisabled();
  await expect(hostKey).toHaveValue('warn');
  // …while one the file leaves alone is untouched by the lock.
  await expect(page.getByRole('switch', { name: 'Allow invitations' })).toBeEnabled();
});

test('a setting the configuration leaves alone is still the console\'s', async ({ page }) => {
  await openInstancePanel(page);

  // session_persistence appears in neither the file nor the environment. It must still
  // work, immediately — that is what makes a lock with no exceptions livable: the operator
  // draws the line by choosing what to declare.
  const toggle = page.getByRole('switch', { name: 'Keep users signed in across reloads' });
  await expect(toggle).toBeEnabled();

  const before = await toggle.getAttribute('aria-checked');
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/admin/session-persistence') && r.request().method() === 'PATCH',
  );
  await toggle.click();
  expect((await saved).status(), 'an undeclared key saves normally').toBe(204);
  await expect(toggle).not.toHaveAttribute('aria-checked', before ?? '');
});

/**
 * The other half of the Quick SSH pair (`accounts.spec.ts`): a switch for a button that
 * does exist. A server governs the capability and forbids it unless told otherwise, and
 * this instance tells it otherwise — so here the toolbar button renders and the preference
 * that hides it has something to hide. Both sides read the same gate (`quickSshAllowed`),
 * which is the only reason the preference and the button cannot drift apart.
 */
test('the Quick SSH switch is offered on an instance that allows Quick SSH', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/Sign in to the server/i)).toBeVisible({ timeout: 30_000 });
  await page.locator('#username').fill(ADMIN.username);
  await page.locator('#password').fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({ timeout: 30_000 });

  // The premise, from the server rather than from the file this suite already read.
  const mode = await (await page.request.get('/api/server/mode')).json();
  expect(mode.allowQuickSsh).toBe(true);

  await page.getByRole('button', { name: /^CF / }).click();
  await page.getByRole('button', { name: /^settings$/i }).click();
  await page.getByTestId('settings-nav-toolbar').click();
  const quick = page.getByTestId('toolbar-quickSsh');
  await expect(quick).toBeVisible();
  // …and here it carries its ordinary explanation, not the server's refusal.
  await expect(quick).not.toContainText('Your server turns this off');
});
