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

  // The name came from the file, so the field and its Save both go inert…
  const nameField = page.locator('#instance-name');
  await expect(nameField).toHaveValue('Configured by file');
  await expect(nameField).toBeDisabled();

  // …and the row says where it came from, by path, not just that it is locked.
  const notes = page.getByText(/Set by this instance's configuration/);
  expect(await notes.count()).toBeGreaterThan(0);
  await expect(notes.first()).toContainText('rite.toml');

  // A switch the file declares cannot be thrown, and its row says so too.
  await expect(page.getByRole('switch', { name: 'Open registration' })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Allow Quick SSH' })).toBeDisabled();
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
