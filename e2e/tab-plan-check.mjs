/**
 * Reading a live pane tree back into the plan that would rebuild it.
 *
 * Loads `apps/desktop/src/store/tabPlan.ts` directly: Node strips the types and that
 * module imports nothing at runtime, so this tests the shipped reader.
 *
 * WHY A CHECK AND NOT A BROWSER TEST. The thing that can go wrong is ORDER. `splitPane`
 * cuts an existing pane, so a step whose anchor is not on screen yet does nothing — and a
 * plan with its steps in the wrong order does not crash, it quietly opens fewer panes than
 * it named. In a browser that shows up as "three panes instead of four" with no indication
 * of which step was dropped; here the order is the assertion.
 *
 * The browser half — that a duplicated tab really opens, against the same machines — is
 * `e2e/tests/tab-menu.spec.ts`.
 */
import assert from 'node:assert/strict';
import { planFromTree } from '../apps/desktop/src/store/tabPlan.ts';

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`);
    failed++;
  }
};

let next = 0;
/** A terminal leaf holding a session on `machine`, or a local shell when absent. */
const leaf = (machine) => ({
  id: `p${++next}`,
  type: 'terminal',
  session: machine
    ? { id: `s${next}`, connectionId: `c${next}`, connectionName: machine }
    : { id: `s${next}`, connectionId: 'local', connectionName: 'Local Terminal (bash)' },
});
const split = (direction, ratio, a, b) => ({
  id: `x${++next}`,
  type: 'split',
  direction,
  ratio,
  children: [a, b],
});

console.log('\none pane:');

check('a single terminal is a plan with one pane and no cuts', () => {
  const plan = planFromTree(leaf('web-01'), 'work');
  assert.deepEqual(plan, {
    tab: 'work',
    panes: [{ machine: 'web-01', command: '' }],
    steps: [],
  });
});

check('a local shell names no machine', () => {
  // `machine` absent is what tells the opener "this computer". A local pane carrying its
  // display name as a machine would send the opener looking through the library for
  // "Local Terminal (bash)".
  const plan = planFromTree(leaf(), null);
  assert.deepEqual(plan.panes, [{ command: '' }]);
  assert.equal(plan.tab, null);
});

check('no command is carried over', () => {
  // A session's initial command already ran in the pane being duplicated. Replaying it
  // would re-run whatever it was — a deploy, an `rm`, a preset — and copying an
  // arrangement does not mean running it again.
  const node = leaf('web-01');
  node.session.initialCommand = 'sudo deploy --prod';
  assert.deepEqual(planFromTree(node, null).panes, [{ machine: 'web-01', command: '' }]);
});

console.log('\ntwo panes:');

check('one split is one cut, with its direction and ratio', () => {
  const plan = planFromTree(split('horizontal', 0.35, leaf('a'), leaf('b')), 'two');
  assert.deepEqual(plan.panes, [
    { machine: 'a', command: '' },
    { machine: 'b', command: '' },
  ]);
  // The ratio is the FIRST child's share, which is what `splitPane` takes — so it is
  // carried through unchanged rather than inverted.
  assert.deepEqual(plan.steps, [
    { pane: 1, anchor: 0, direction: 'horizontal', before: false, ratio: 0.35 },
  ]);
});

check('a vertical split says vertical', () => {
  const plan = planFromTree(split('vertical', 0.5, leaf('a'), leaf('b')), null);
  assert.equal(plan.steps[0].direction, 'vertical');
});

console.log('\nnesting, where the order matters:');

check('a nested split cuts the pane that holds its area', () => {
  // a | (b / c) — the right side is cut in two after it exists.
  const tree = split('horizontal', 0.5, leaf('a'), split('vertical', 0.6, leaf('b'), leaf('c')));
  const plan = planFromTree(tree, null);
  assert.deepEqual(plan.panes.map((p) => p.machine), ['a', 'b', 'c']);
  assert.deepEqual(plan.steps, [
    { pane: 1, anchor: 0, direction: 'horizontal', before: false, ratio: 0.5 },
    // c is cut out of b's area, NOT out of a's: b holds the right half by then.
    { pane: 2, anchor: 1, direction: 'vertical', before: false, ratio: 0.6 },
  ]);
});

check('a split on the LEFT anchors to pane 0, which kept its place', () => {
  // (a / b) | c — the left side is cut, and pane 0 is still the pane holding it.
  const tree = split('horizontal', 0.5, split('vertical', 0.4, leaf('a'), leaf('b')), leaf('c'));
  const plan = planFromTree(tree, null);
  assert.deepEqual(plan.panes.map((p) => p.machine), ['a', 'c', 'b']);
  assert.deepEqual(plan.steps, [
    { pane: 1, anchor: 0, direction: 'horizontal', before: false, ratio: 0.5 },
    { pane: 2, anchor: 0, direction: 'vertical', before: false, ratio: 0.4 },
  ]);
});

check('every step anchors to a pane an earlier step had already placed', () => {
  // THE invariant, and the reason this is a check and not a browser test: a step whose
  // anchor does not exist yet does nothing, and the tab silently opens fewer panes than
  // it named. Asserted on a four-level tree, both sides nested.
  const tree = split(
    'horizontal',
    0.5,
    split('vertical', 0.3, leaf('a'), split('horizontal', 0.7, leaf('b'), leaf('c'))),
    split('vertical', 0.5, leaf('d'), leaf('e')),
  );
  const plan = planFromTree(tree, null);
  assert.equal(plan.panes.length, 5);
  const placed = new Set([0]);
  for (const step of plan.steps) {
    assert.ok(placed.has(step.anchor), `step adding ${step.pane} anchors to unplaced ${step.anchor}`);
    assert.ok(!placed.has(step.pane), `pane ${step.pane} is placed twice`);
    placed.add(step.pane);
  }
  // And every pane the plan names gets placed, which is the other half of the invariant.
  assert.equal(placed.size, plan.panes.length);
});

check('the deepest tree keeps every ratio, in its own step', () => {
  const tree = split(
    'horizontal',
    0.25,
    leaf('a'),
    split('vertical', 0.75, leaf('b'), split('horizontal', 0.4, leaf('c'), leaf('d'))),
  );
  const plan = planFromTree(tree, null);
  assert.deepEqual(
    plan.steps.map((s) => s.ratio),
    [0.25, 0.75, 0.4],
  );
});

/**
 * ONE MUTATION SURVIVES THIS FILE, and it is not a weak test.
 *
 * Swapping the two recursive calls — right subtree before left — reorders the cuts BETWEEN
 * two independent subtrees. Each subtree's steps still anchor inside itself, every anchor
 * is still placed before it is used, and the plan still rebuilds the same tree. Both
 * orders are correct, so there is nothing for an assertion to catch.
 *
 * It could be killed by pinning the exact step sequence of a two-sided nest. That would
 * freeze an arbitrary choice into the contract and fail on a refactor that is equally
 * right, which is worse than a surviving mutation that changes no behaviour. The contract
 * is the invariant above: every anchor placed before use, every pane placed exactly once,
 * and every pane the plan names placed at all.
 */

console.log('\nmixed targets:');

check('local and remote panes sit side by side', () => {
  const plan = planFromTree(split('horizontal', 0.5, leaf(), leaf('web-01')), 'mixed');
  assert.deepEqual(plan.panes, [{ command: '' }, { machine: 'web-01', command: '' }]);
});

check('a machine name is trimmed, since it is matched by name', () => {
  // The opener looks the name up in the library, and a stray space would turn a known
  // machine into a missing one — which opens a plain shell carrying a note instead.
  const node = leaf('  web-01  ');
  assert.deepEqual(planFromTree(node, null).panes, [{ machine: 'web-01', command: '' }]);
});

console.log();
if (failed) {
  console.log(`❌ ${failed} failed`);
  process.exit(1);
}
console.log('✅ a live tree reads back into a plan that rebuilds it');
