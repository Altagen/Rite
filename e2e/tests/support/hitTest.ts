/**
 * DOES THE CONTROL ON SCREEN RECEIVE ITS OWN CLICKS?
 *
 * Written after a defect that cost a whole session. A collection overlay sat at `z-10`,
 * the terminal's tab strip above it was `relative z-10` with `pb-3 overflow-y-visible`,
 * and the strip's invisible padding painted over the top band of the overlay. Every
 * button in the collection header — Board, Members, Check now — was unclickable at every
 * window width, and `wave1-dashboard` had been failing on it for days while I reported it
 * three times as pre-existing and unrelated. It was: pre-existing, and mine, and nothing
 * in the suite could see it, because no test had ever clicked that row.
 *
 * A click is the wrong instrument for this. `button.click()` auto-waits, scrolls, retries
 * and then times out with "element is not visible", which sends the reader looking for a
 * rendering bug; `{force: true}` dispatches at the coordinates and SILENTLY hits whatever
 * is on top, so the test passes while the user cannot click the thing. What broke was
 * hit-testing, and `elementFromPoint` reads hit-testing directly: it answers the question
 * the browser answers on a real click, in one call, with the name of the thief.
 *
 * SCOPE IT. A sweep of every control on the page reports the sidebar's nested buttons,
 * where a hit landing on a child is the normal arrangement and not a defect. Pass the
 * region whose controls a person is expected to be able to click.
 */

import { expect, type Page } from '@playwright/test';

/** What covered a control, and what covered it — `''` for the page's own chrome. */
export interface Covered {
  control: string;
  by: string;
}

/**
 * Every control inside `scope` whose own centre belongs to something else.
 *
 * Returns `[]` when the region is clickable, which is what a test asserts. A control
 * whose centre lies outside the viewport is skipped rather than reported: it is scrolled
 * away, not covered, and reporting it would make the result depend on window height.
 */
export async function coveredControls(page: Page, scope: string): Promise<Covered[]> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return [{ control: `no such region: ${sel}`, by: '' }];

    // `summary` and `[role=button]` are clickable without being buttons; `label` is not
    // listed because a label covered by its own input is the normal arrangement.
    const controls = root.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"]',
    );

    const name = (el: Element | null): string => {
      if (!el) return 'nothing';
      const h = el as HTMLElement;
      const id = h.dataset?.testid;
      if (id) return `[${id}]`;
      const text = (h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
      return text ? `${h.tagName.toLowerCase()} "${text}"` : h.tagName.toLowerCase();
    };

    const out: Covered[] = [];
    for (const el of Array.from(controls)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;

      // SCROLLED AWAY IS NOT COVERED. A control inside a list that scrolls can have its
      // centre outside what that list shows, and `elementFromPoint` then answers with
      // whatever is painted there — which reads as a defect and is not one. The same
      // reasoning as the viewport test above, one container in.
      let clipped = false;
      for (let a = el.parentElement; a && !clipped; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (!/auto|scroll/.test(s.overflowY) && !/auto|scroll/.test(s.overflowX)) continue;
        const ar = a.getBoundingClientRect();
        clipped = y < ar.top || y > ar.bottom || x < ar.left || x > ar.right;
        break;
      }
      if (clipped) continue;

      const hit = document.elementFromPoint(x, y);
      // Its own descendant answering is normal — a button draws an icon and a span.
      // So is an ancestor: a control inside a padded wrapper can legitimately report it.
      if (hit === el || el.contains(hit) || (hit && hit.contains(el))) continue;
      out.push({ control: name(el), by: name(hit) });
    }
    return out;
  }, scope);
}

/** Assert the region is clickable, naming both sides when it is not. */
export async function expectClickable(page: Page, scope: string): Promise<void> {
  expect(await coveredControls(page, scope), `controls covered inside ${scope}`).toEqual([]);
}
