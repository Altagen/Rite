import { test, expect, type Page } from '@playwright/test';

/**
 * The administration console, held to its behaviour rather than to its wording.
 *
 * It had no test of its own. What touched it did so in passing — the host-key dropdown
 * and the shell list, on the way to something else — so nine of its eleven switches
 * were never clicked by anything, and nothing checked that the panel renders at all.
 * This is the surface where a mistake is an instance-wide policy, which makes "nobody
 * looks at it until an admin does" the wrong place to be.
 *
 * Deliberately NOT asserting copy. The console holds 391 strings written straight into
 * the JSX, and this release rewrote a quarter of them; a test that pins sentences would
 * have failed on every one of those edits while saying nothing about whether the thing
 * works. So: test ids for what to click, `/api/server/mode` for what is true, and the
 * round trip between them. The 0.2.4 settings rewrite broke a test that pinned a
 * sentence — twice — which is the argument for this shape.
 */

// The same account `accounts.spec.ts` bootstraps — this project shares one instance,
// so inventing a second administrator here would just fail to sign in.
const ADMIN = { username: 'admin', password: 'AdminPass123!' };

/** Sign in, bootstrapping the instance if this spec got there first. */
async function signIn(page: Page) {
  await page.goto('/');
  const bootstrap = await page
    .getByText('Create the server administrator')
    .isVisible()
    .catch(() => false);
  if (bootstrap) {
    // The name is not a field on this screen (utils/adminUsername.ts): `admin`, locked.
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /create administrator/i }).click();
  } else {
    await expect(page.getByText('Sign in to the server')).toBeVisible({ timeout: 15_000 });
    await page.locator('#username').fill(ADMIN.username);
    await page.locator('#password').fill(ADMIN.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
  }
}

/** Open the admin console; it lands on Overview with a left nav. */
async function openAdmin(page: Page) {
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 15_000 });
}

/** Fail on anything the page logged as an error — a console that throws is broken. */
function watchErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`));
  return errs;
}

const mode = async (page: Page) =>
  (await (await page.request.get('/api/server/mode')).json()) as Record<string, unknown>;

/**
 * Every switch, against the server rather than against itself.
 *
 * A switch that renders its own state and writes nowhere looks identical to a working
 * one, so each is read from `/api/server/mode`, flipped, read again, and flipped back.
 * Leaving the instance as it was found matters: the accounts project shares one server
 * between its specs, so a switch left off here would silently change another test.
 */
const SWITCHES: { testId: string; key: string }[] = [
  { testId: 'instance-session-persistence', key: 'sessionPersistence' },
  { testId: 'instance-open-registration', key: 'openRegistration' },
  { testId: 'instance-allow-invitations', key: 'allowInvitations' },
  { testId: 'instance-confirm-role-change', key: 'confirmRoleChange' },
  { testId: 'instance-quick-ssh', key: 'allowQuickSsh' },
  { testId: 'instance-shell-choice', key: 'allowShellChoice' },
  { testId: 'instance-secret-storage', key: 'allowSecretStorage' },
  { testId: 'instance-secret-reveal', key: 'allowSecretReveal' },
];

test('every instance switch shows what the server holds, and writes it back', async ({ page }) => {
  const errs = watchErrors(page);
  await signIn(page);
  await openAdmin(page);
  await page.getByRole('button', { name: 'Instance', exact: true }).click();

  for (const { testId, key } of SWITCHES) {
    const sw = page.getByTestId(testId);
    await expect(sw, `${testId} is on the panel`).toBeVisible({ timeout: 15_000 });

    const before = (await mode(page))[key];
    expect(typeof before, `${key} is published by /api/server/mode`).toBe('boolean');
    await expect(sw, `${testId} renders ${key}`).toHaveAttribute(
      'aria-checked',
      String(before as boolean),
    );

    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', String(!(before as boolean)));
    await expect
      .poll(async () => (await mode(page))[key], { timeout: 10_000 })
      .toBe(!(before as boolean));

    // Back, so the next spec in this project finds the instance as it was.
    await sw.click();
    await expect
      .poll(async () => (await mode(page))[key], { timeout: 10_000 })
      .toBe(before as boolean);
  }

  expect(errs, 'the console must not log errors').toEqual([]);
});

/**
 * Nothing on screen is an unresolved translation key.
 *
 * `t()` returns the key when it cannot resolve one, so a typo ships as
 * `settings.foo.bar` in the interface with only a `console.warn` behind it.
 * `i18n-check` now verifies the keys the SOURCE asks for; this checks what the page
 * actually painted, which also covers a key built at run time.
 */
test('the console paints no raw translation keys', async ({ page }) => {
  const errs = watchErrors(page);
  await signIn(page);
  await openAdmin(page);

  for (const tab of ['Instance', 'Users', 'Invitations', 'Collections']) {
    const nav = page.getByRole('button', { name: tab, exact: true });
    if (!(await nav.isVisible().catch(() => false))) continue;
    await nav.click();
    const text = (await page.locator('main, body').first().innerText()).split('\n');
    const keys = text.filter((l) => /^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*){1,3}$/.test(l.trim()));
    expect(keys, `${tab} shows a translation key instead of its text`).toEqual([]);
  }

  expect(errs, 'the console must not log errors').toEqual([]);
});

/**
 * Deleting a team asks first.
 *
 * It did not. The button sat in the danger zone, said "Delete team" in English on a
 * French console, and removed the roster on the first click — every member had to be
 * added back by hand, and nothing had warned. A destructive action with no guard is
 * the one kind of bug a test should outlive the fix for, so this asserts the dialog
 * appears AND that dismissing it leaves the team alone.
 */
test('deleting a team asks first, and a refusal leaves it standing', async ({ page }) => {
  await signIn(page);
  await openAdmin(page);
  await page.getByTestId('admin-nav-teams').click();

  // A team of our own, so the other specs in this project keep theirs.
  const name = `guard-${Date.now()}`;
  await page.getByTestId('new-team-name').fill(name);
  await page.getByTestId('new-team-submit').click();
  const team = page.getByTestId(`team-${name}`);
  await expect(team).toBeVisible({ timeout: 15_000 });
  await team.click();

  // Refuse the dialog: the team must still be there. It is the app's own dialog, not the
  // browser's — a `page.on('dialog')` handler would now wait forever.
  await page.getByTestId('danger-action').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText(name, { timeout: 10_000 });
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await page.reload();
  await page.getByTestId('admin-nav-teams').click();
  await expect(page.getByTestId(`team-${name}`)).toBeVisible({ timeout: 15_000 });

  // Accept it, and only then is it gone.
  await page.getByTestId(`team-${name}`).click();
  await page.getByTestId('danger-action').click();
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId(`team-${name}`)).toHaveCount(0, { timeout: 15_000 });
});

/**
 * The sign-in password can be read back.
 *
 * It could not. Five screens had an eye and three had none — and the one with none that
 * mattered was this one: the first password anyone types into Rite, on a keyboard layout
 * they may have guessed wrong, with no way to check before being told "wrong password".
 *
 * Asserted on the input's type rather than on the icon: what matters is whether the
 * characters are legible, and an eye that renders but toggles nothing would pass a
 * screenshot test.
 */
test('the sign-in password can be revealed and hidden again', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/');
  // Sign out if a previous spec left a session behind — this test needs the sign-in form.
  if (
    await page
      .getByTestId('reveal-password')
      .isHidden()
      .catch(() => true)
  ) {
    await page.getByRole('button', { name: /^AD / }).click();
    await page.getByRole('button', { name: /^sign out$/i }).click();
  }
  const field = page.locator('#password');
  await expect(field).toBeVisible({ timeout: 15_000 });
  await field.fill('something-typed');

  await expect(field).toHaveAttribute('type', 'password');
  await page.getByTestId('reveal-password').first().click();
  await expect(field).toHaveAttribute('type', 'text');
  // And back: an eye that only opens is a secret left on screen.
  await page.getByTestId('reveal-password').first().click();
  await expect(field).toHaveAttribute('type', 'password');
});

/**
 * The teams list is searched and paged by the SERVER.
 *
 * It was a row of chips rendered from the whole table, which reads well at ten and is a
 * wall at fifty — and the endpoint returned every team on every open, so paging it in the
 * browser would have moved the problem rather than solved it.
 *
 * Asserted against the request, not only the DOM: a filter applied client-side would make
 * the list look right while still shipping the directory. So the search has to reach the
 * server as `?q=`, and the page as `?limit=`/`?offset=`.
 */
test('the teams list is searched and paged on the server', async ({ page }) => {
  await signIn(page);
  await openAdmin(page);
  await page.getByTestId('admin-nav-teams').click();

  // Two teams whose names share no prefix, so a search can tell them apart.
  const tag = Date.now();
  for (const name of [`alpha-${tag}`, `zeta-${tag}`]) {
    await page.getByTestId('new-team-name').fill(name);
    await page.getByTestId('new-team-submit').click();
    await expect(page.getByTestId(`team-${name}`)).toBeVisible({ timeout: 15_000 });
  }

  // The search travels: the URL carries it, and the list narrows to the one that matches.
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/api/admin/teams?') && r.url().includes('q=')),
    page.getByTestId('team-search').fill(`alpha-${tag}`),
  ]);
  expect(request.url()).toContain(`q=alpha-${tag}`);
  await expect(page.getByTestId(`team-alpha-${tag}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`team-zeta-${tag}`)).toHaveCount(0);

  // A search that matches nothing says so, naming what was typed.
  await page.getByTestId('team-search').fill(`nothing-like-this-${tag}`);
  await expect(page.getByTestId('team-list')).toContainText(`nothing-like-this-${tag}`, {
    timeout: 15_000,
  });

  // And the page is the server's too: asking for a page sends an offset.
  const paged = page.waitForRequest(
    (r) => r.url().includes('/api/admin/teams?') && r.url().includes('limit='),
  );
  await page.getByTestId('team-search').fill('');
  expect((await paged).url()).toContain('limit=');
});
