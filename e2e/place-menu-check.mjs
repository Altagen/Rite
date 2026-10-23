/**
 * The menu placement rule, held to the one thing it exists for: the box is on screen.
 *
 * This is a regression check before it is a unit test. Every popup in the app used
 * `rect.bottom + 4` and nothing consulted the viewport height, so the Layouts menu in
 * the empty state — the first button placed at mid-screen rather than in a header —
 * opened a 70vh list that ran off the bottom edge, with the unreachable entries
 * inside its own scroll region. The invariant below would have failed on that code.
 *
 * Run: node e2e/place-menu-check.mjs
 */
import assert from 'node:assert/strict';
import { placeMenu } from '../apps/desktop/src/utils/placeMenu.ts';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`❌ ${name}\n   ${e.message}`);
    process.exitCode = 1;
  }
};

const MARGIN = 8;
/** A button of height 28 whose top edge is at `y`, right edge at `right`. */
const anchor = (y, right = 600) => ({ top: y, bottom: y + 28, left: right - 120, right });
const vp = (width = 1280, height = 800) => ({ width, height });

check('a menu with room below opens below the button', () => {
  const p = placeMenu(anchor(100), { width: 280, height: 300 }, vp());
  assert.equal(p.top, 132, 'should sit just under the button');
  assert.equal(p.maxHeight, 300, 'should not be cut when it fits');
});

check('a menu with no room below opens above the button', () => {
  // Button near the bottom: 800 - 728 - 4 - 8 = 60px below, 716px above.
  const p = placeMenu(anchor(700), { width: 280, height: 300 }, vp());
  assert.equal(p.top, 396, 'should be lifted to end just above the button');
  assert.equal(p.maxHeight, 300, 'and still be its full height');
  assert.ok(p.top + p.maxHeight <= 700, 'it must not cover its own button');
});

check('the empty-state button at mid-screen: the defect this file exists for', () => {
  // What the app actually does: the button is vertically centred, and the menu asks
  // for 70vh = 560px. Neither side has that much — 360 below, 388 above — so it takes
  // the larger one and is cut to it. The old code returned top=432 with a 560px box
  // ending at 992, which is 192px below a 800px viewport.
  const p = placeMenu(anchor(400), { width: 280, height: 0.7 * 800 }, vp());
  assert.ok(p.top + p.maxHeight <= 800 - MARGIN, `box ends at ${p.top + p.maxHeight}, past the edge`);
  assert.equal(p.maxHeight, 388, 'the height must be cut to the room available');
  assert.ok(p.top < 400, 'and with more room above, it opens upwards');
});

check('a menu that fits below stays below even when there is more room above', () => {
  // 800 - 628 - 4 - 8 = 160 below, 616 above: more room above, but 120 fits below.
  const p = placeMenu(anchor(600), { width: 280, height: 120 }, vp());
  assert.equal(p.top, 632, 'it should not jump above for no reason');
});

check('with too little room on both sides it takes the larger one', () => {
  const p = placeMenu(anchor(120), { width: 280, height: 900 }, vp(1280, 300));
  // 300 - 148 - 4 - 8 = 140 below, 120 - 4 - 8 = 108 above.
  assert.equal(p.top, 152);
  assert.equal(p.maxHeight, 140);
});

check('a menu is right-aligned with its button', () => {
  const p = placeMenu(anchor(100, 600), { width: 280, height: 100 }, vp());
  assert.equal(p.left, 320, 'right edge of the menu meets the right edge of the button');
});

check('a menu near the left edge is pushed back inside', () => {
  const p = placeMenu(anchor(100, 90), { width: 280, height: 100 }, vp());
  assert.equal(p.left, MARGIN, 'never a negative left');
});

check('a menu wider than the viewport still starts on screen', () => {
  const p = placeMenu(anchor(100, 300), { width: 900, height: 100 }, vp(400, 800));
  assert.equal(p.left, MARGIN);
});

check('a menu never covers the right edge', () => {
  const p = placeMenu(anchor(100, 1278), { width: 280, height: 100 }, vp());
  assert.ok(p.left + 280 <= 1280 - MARGIN, `right edge at ${p.left + 280}`);
});

// The invariant, swept: whatever the button's position and whatever the menu asks
// for, the box that comes back is inside the viewport. One case of this is the bug.
check('the box is inside the viewport, for every anchor and every size', () => {
  let cases = 0;
  for (const height of [360, 600, 800, 1080]) {
    for (const y of [-200, -29, -1, 0, 1, 40, 200, height / 2, height - 60, height - 29, height]) {
      for (const want of [40, 120, 300, 0.7 * height, height * 2]) {
        const v = vp(1280, height);
        const a = anchor(y);
        const p = placeMenu(a, { width: 280, height: want }, v);
        assert.ok(p.top >= 0, `top ${p.top} above the viewport (y=${y}, h=${height})`);
        assert.ok(
          p.top + p.maxHeight <= v.height,
          `box ends at ${p.top + p.maxHeight} past ${v.height} (y=${y}, want=${want})`,
        );
        assert.ok(p.maxHeight >= 1, 'a menu of zero height is an invisible menu');
        assert.ok(p.left >= 0, `left ${p.left}`);
        cases++;
      }
    }
  }
  assert.equal(cases, 220, 'the sweep should cover 220 cases');
});

check('a button scrolled off the top cannot stretch the menu past the bottom', () => {
  // A real shape: the tab strip scrolls and clips, so an anchor can sit outside the
  // viewport. The room "below" such a button is larger than the screen, and without
  // the final clamp the box inherits that and hangs off the bottom edge.
  const p = placeMenu({ top: -128, bottom: -100, left: 480, right: 600 }, { width: 280, height: 1600 }, vp());
  assert.ok(p.top >= MARGIN, `top ${p.top}`);
  assert.ok(p.top + p.maxHeight <= 800 - MARGIN, `box ends at ${p.top + p.maxHeight}, past the edge`);
});

check('the gap is honoured, and configurable', () => {
  assert.equal(placeMenu(anchor(100), { width: 280, height: 100 }, vp(), 0).top, 128);
  assert.equal(placeMenu(anchor(100), { width: 280, height: 100 }, vp(), 12).top, 140);
});

console.log(`\n✅ place-menu-check: ${passed} checks passed`);
