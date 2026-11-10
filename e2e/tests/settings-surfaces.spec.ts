import { test, expect, type Page } from '@playwright/test';
import { openSettings } from './support/headerBar';

/**
 * WHAT SETTINGS OFFERS IN EACH SHELL, read off the shipped component.
 *
 * This is what `e2e/settings-rail-check.mjs` used to ask of the two mock pages (deleted).
 * They existed because the mock had no way to be
 * one shell or the other, and comparing them compared two hand-written copies — so the
 * check passed for two releases while host-key verification sat under Security in the app
 * and under SSH in the mock. A reader looking for an SSH setting under SSH did not find
 * it, and nothing failed.
 *
 * The real component branches on three flags (`native`, `local`, `vault`) and one
 * question — whether the server runs accounts. So the shells are reachable without a
 * second implementation:
 *
 *   native   `window.__RITE_TOKEN__`, which wry injects and an init script can too
 *   accounts the server's own mode, which the accounts project already provides
 *
 * Driving the real thing also removes the reason the old check compared LABELS rather
 * than ids: there is one rail now, so there is nothing to disagree about.
 */

/**
 * Rows that exist in both shells under DIFFERENT names, because they are about different
 * things even though they sit in the same section. Named here with the reason, so the
 * comparison stays blunt about everything else: a row missing from one shell is drift
 * until somebody writes down why it is not.
 */
const SAME_ROW_OTHER_WORDS: Record<string, string> = {
  // A browser locks a SESSION; a desktop locks a VAULT. Not the same object.
  'Auto-lock vault': 'Auto-lock session',
  'Auto-lock session': 'Auto-lock vault',
  // The desktop names the instance THIS WINDOW is connected to; the web page names what
  // the server it is served by speaks. Two different facts about two different hosts.
  Server: 'API',
  API: 'Server',
};

/**
 * Rows that exist in ONE shell on purpose, each with the decision that put it there. A
 * row missing from the other is drift until it is written down here — which is the
 * point: these entries are the record, and adding one is a deliberate act rather than a
 * way to quiet the test.
 */
const ONE_SHELL_ONLY: Record<string, 'desktop' | 'web'> = {
  // ADR 0031 and `shellControls()`: the default shell is the desktop client's own. A
  // browser has no machine of its own, so the instance chooses and offers its list.
  'Shell picker': 'desktop',
  Shell: 'desktop',
  'Another shell': 'desktop',
  'Local shell': 'web',
  'Server shell': 'web',
};

/** The rail's labels and, per section, the titles of the rows it shows. */
async function surface(page: Page) {
  await openSettings(page);
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  return page.getByTestId('settings-dialog').evaluate((dialog) => {
    const rail = Array.from(dialog.querySelectorAll('nav button, [role="tab"]'))
      .map((b) => (b.textContent || '').trim())
      .filter(Boolean);
    const rows: Record<string, string[]> = {};
    for (const label of rail) {
      const entry = Array.from(dialog.querySelectorAll('nav button, [role="tab"]')).find(
        (b) => (b.textContent || '').trim() === label,
      ) as HTMLElement | undefined;
      entry?.click();
      const open = dialog.querySelector('section:not([hidden])');
      // `data-settings-row` carries the title, put there by `SettingsRow` so a section's
      // offer can be read at all — the thing this test's predecessor could not do.
      rows[label] = Array.from(open?.querySelectorAll('[data-settings-row]') ?? [])
        .map((r) => r.getAttribute('data-settings-row') || '')
        .filter(Boolean)
        .sort();
    }
    return { rail, rows };
  });
}

test('the desktop shell offers the sections only a native window can', async ({ page }) => {
  // The token the native shell injects (ADR 0014 phase 4). Set before load, because
  // `isNativeShell()` is read as the tree renders.
  await page.addInitScript(() => {
    (window as unknown as { __RITE_TOKEN__?: string }).__RITE_TOKEN__ = 'e2e-native';
  });
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });

  const { rail } = await surface(page);
  // A local vault in a native window can show every section there is, which is the
  // property the mock was drawn to describe.
  expect(rail, 'the rail is empty, so this test is measuring nothing').not.toEqual([]);
  expect(rail).toContain('Labels');
});

test('a browser is offered no section it cannot honour', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  const { rail } = await surface(page);

  // No native window, so nothing that needs one. `focus mode` is the example the mock
  // carried; the assertion is on the flag's effect rather than on one entry's name.
  expect(rail.length, 'a browser still has settings').toBeGreaterThan(3);
});

test('the two shells agree on every row they both show', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __RITE_TOKEN__?: string }).__RITE_TOKEN__ = 'e2e-native';
  });
  await page.goto('/');
  await expect(page.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  const native = await surface(page);

  const plain = await page.context().newPage();
  await plain.goto('/');
  await expect(plain.getByTestId('vault-pastille')).toBeVisible({ timeout: 15_000 });
  const browser = await surface(plain);

  // A SECTION BOTH CAN SHOW OFFERS THE SAME ROWS. There is one component, so a
  // difference here is a `native`/`local`/`vault` branch somebody added without saying
  // so — which is exactly what the two mock pages used to hide by being written twice.
  const drifted: string[] = [];
  for (const label of native.rail) {
    const a = native.rows[label];
    const b = browser.rows[label];
    if (!a || !b) continue;
    const only = (x: string[], y: string[], side: 'desktop' | 'web') =>
      x.filter((t) => !y.includes(t) && !SAME_ROW_OTHER_WORDS[t] && ONE_SHELL_ONLY[t] !== side);
    const d = only(a, b, 'desktop');
    const w = only(b, a, 'web');
    if (d.length || w.length) drifted.push(`${label}: native only [${d}] · browser only [${w}]`);
  }
  expect(drifted, 'the two shells disagree about a shared section').toEqual([]);

  // AND IT HAS TO BE COMPARING SOMETHING. Rows collected from nothing make the loop above
  // vacuous, which is how this test passed on its first run: it was reading `.settings-row`,
  // a class that belongs to the mock's stylesheet and not to the shipped component.
  const counted = Object.values(native.rows).reduce((n, r) => n + r.length, 0);
  expect(counted, 'no rows were read, so the comparison compared nothing').toBeGreaterThan(8);
  await plain.close();
});
