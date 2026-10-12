// Unit gate for the pane tree (apps/desktop/src/utils/paneTree.ts).
//
// The split-pane layout had no tests. Playwright exercises terminals *inside*
// panes — "a container action opens a terminal pane", "a snippet runs in the
// focused pane" — but never the tree operations themselves: splitting, closing,
// collapsing, focusing, detaching, reorganising. That is the logic a refactor
// breaks silently, and pane kinds (SFTP, agents) are a refactor of exactly this
// file, so it got locked down first.
//
// The last group goes further than regression: it feeds the tree a leaf of a kind
// paneTree has never heard of, which is what an SFTP or agent pane will be to it.
// Those checks are what `isLeaf()` is for, and every one of them fails if a single
// traversal goes back to asking `type === 'terminal'`.
//
// No test framework is involved, and none is needed. Node strips TypeScript types
// natively, and paneTree.ts imports *only* types — so those imports are erased and
// the real module loads as-is. This tests the shipped code, not a reimplementation
// of it, which is what separates this from the parity checks next to it.
//
// Run from the repo root: `node e2e/pane-tree-check.mjs`
import assert from 'node:assert/strict';
import {
  isLeaf,
  createTerminalPane,
  createSplitPane,
  findPaneById,
  findParent,
  splitPane,
  closePane,
  setFocusedPane,
  getFocusedPane,
  getFirstLeafPane,
  getAllSessions,
  getSessionsInPane,
  getAllPanes,
  updateSplitRatio,
  updateSession,
  extractPane,
  reorganizePane,
} from '../apps/desktop/src/utils/paneTree.ts';

const session = (name) => ({ id: `s-${name}`, connectionId: `c-${name}`, connectionName: name });
const leafIds = (tree) => getAllPanes(tree).map((p) => p.id);
const names = (tree) => getAllSessions(tree).map((s) => s.connectionName);

let failures = 0;
const check = (what, fn) => {
  try {
    fn();
    console.log(`  PASS  ${what}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${what}`);
    console.log(`        ${e.message.split('\n')[0]}`);
  }
};

console.log('pane tree (the real module, types stripped):');

check('a fresh pane is a focused terminal leaf carrying its session', () => {
  const p = createTerminalPane(session('one'), true);
  assert.equal(p.type, 'terminal');
  assert.equal(p.isFocused, true);
  assert.equal(p.session.connectionName, 'one');
  assert.match(p.id, /^[0-9a-f-]{36}$/);
});

check('splitting a lone pane produces a split holding both, the new one focused', () => {
  const a = createTerminalPane(session('a'), true);
  const tree = splitPane(a, a.id, 'horizontal', session('b'));
  assert.equal(tree.type, 'split');
  assert.equal(tree.direction, 'horizontal');
  assert.equal(tree.ratio, 0.5);
  assert.deepEqual(names(tree), ['a', 'b']);
  // The pane that was split keeps its place and loses focus; the arrival takes it.
  assert.equal(getFocusedPane(tree).session.connectionName, 'b');
});

check('splitting a nested pane leaves its siblings untouched', () => {
  const a = createTerminalPane(session('a'), true);
  let tree = splitPane(a, a.id, 'horizontal', session('b'));
  const b = getAllPanes(tree).find((p) => p.session.connectionName === 'b');
  tree = splitPane(tree, b.id, 'vertical', session('c'));
  assert.deepEqual(names(tree), ['a', 'b', 'c']);
  // 'a' is still the left child of the root; only b's slot became a split.
  assert.equal(tree.children[0].type, 'terminal');
  assert.equal(tree.children[1].type, 'split');
  assert.equal(tree.children[1].direction, 'vertical');
});

check('closing the only pane empties the tree', () => {
  const a = createTerminalPane(session('a'), true);
  assert.equal(closePane(a, a.id), null);
});

check('closing one side of a split collapses it to the survivor', () => {
  const a = createTerminalPane(session('a'), true);
  const tree = splitPane(a, a.id, 'horizontal', session('b'));
  const [left, right] = tree.children;
  const afterLeft = closePane(tree, left.id);
  assert.equal(afterLeft.type, 'terminal');
  assert.equal(afterLeft.id, right.id, 'closing the left child must promote the right one');
  const afterRight = closePane(tree, right.id);
  assert.equal(afterRight.id, left.id, 'and vice versa');
});

check('closing a nested pane collapses only its own split', () => {
  const a = createTerminalPane(session('a'), true);
  let tree = splitPane(a, a.id, 'horizontal', session('b'));
  const b = getAllPanes(tree).find((p) => p.session.connectionName === 'b');
  tree = splitPane(tree, b.id, 'vertical', session('c'));
  const c = getAllPanes(tree).find((p) => p.session.connectionName === 'c');
  const after = closePane(tree, c.id);
  assert.equal(after.type, 'split', 'the outer split survives');
  assert.deepEqual(names(after), ['a', 'b']);
  assert.equal(after.children[1].type, 'terminal', "b's slot is a leaf again");
});

check('closing an id that is not in the tree changes nothing', () => {
  const a = createTerminalPane(session('a'), true);
  const tree = splitPane(a, a.id, 'horizontal', session('b'));
  assert.deepEqual(leafIds(closePane(tree, 'no-such-pane')), leafIds(tree));
});

check('focus is exclusive — setting it anywhere clears it everywhere else', () => {
  const a = createTerminalPane(session('a'), true);
  let tree = splitPane(a, a.id, 'horizontal', session('b'));
  const [left, right] = tree.children;
  tree = setFocusedPane(tree, left.id);
  assert.equal(getFocusedPane(tree).id, left.id);
  assert.equal(getAllPanes(tree).filter((p) => p.isFocused).length, 1);
  tree = setFocusedPane(tree, right.id);
  assert.equal(getFocusedPane(tree).id, right.id);
  assert.equal(getAllPanes(tree).filter((p) => p.isFocused).length, 1);
});

check('focusing nothing leaves no pane focused', () => {
  const a = createTerminalPane(session('a'), true);
  const tree = setFocusedPane(splitPane(a, a.id, 'horizontal', session('b')), 'absent');
  assert.equal(getFocusedPane(tree), null);
});

check('lookups: by id, by parent, first leaf', () => {
  const a = createTerminalPane(session('a'), true);
  const tree = splitPane(a, a.id, 'horizontal', session('b'));
  const [left] = tree.children;
  assert.equal(findPaneById(tree, left.id).id, left.id);
  assert.equal(findPaneById(tree, tree.id).type, 'split', 'the split itself is findable');
  assert.equal(findPaneById(tree, 'absent'), null);
  assert.equal(findParent(tree, left.id).id, tree.id);
  assert.equal(findParent(tree, tree.id), null, 'the root has no parent');
  // Structural, despite the name: it returns the first leaf in traversal order.
  assert.equal(getFirstLeafPane(tree).id, left.id);
});

check('sessions can be collected for the whole tree or one pane', () => {
  const a = createTerminalPane(session('a'), true);
  const tree = splitPane(a, a.id, 'horizontal', session('b'));
  const [left] = tree.children;
  assert.deepEqual(names(tree), ['a', 'b']);
  assert.deepEqual(
    getSessionsInPane(tree, left.id).map((s) => s.connectionName),
    ['a'],
  );
  assert.deepEqual(
    getSessionsInPane(tree, tree.id).map((s) => s.connectionName),
    ['a', 'b'],
    'asking a split returns every session beneath it — this drives close-tab cleanup',
  );
});

check('a split ratio is updated in place, and only the named split', () => {
  const a = createTerminalPane(session('a'), true);
  let tree = splitPane(a, a.id, 'horizontal', session('b'));
  const outerId = tree.id;
  const b = getAllPanes(tree).find((p) => p.session.connectionName === 'b');
  tree = splitPane(tree, b.id, 'vertical', session('c'));
  const innerId = tree.children[1].id;
  tree = updateSplitRatio(tree, innerId, 0.8);
  assert.equal(tree.id, outerId);
  assert.equal(tree.ratio, 0.5, 'the outer split is untouched');
  assert.equal(tree.children[1].ratio, 0.8);
});

check('a session is updated by id, leaving the others alone', () => {
  const a = createTerminalPane(session('a'), true);
  const tree = splitPane(a, a.id, 'horizontal', session('b'));
  const next = updateSession(tree, 's-a', (s) => ({ ...s, connectionName: 'renamed' }));
  assert.deepEqual(names(next), ['renamed', 'b']);
});

check('extracting a pane yields it and the tree without it', () => {
  const a = createTerminalPane(session('a'), true);
  const tree = splitPane(a, a.id, 'horizontal', session('b'));
  const [left, right] = tree.children;
  const { extractedPane, remainingTree } = extractPane(tree, right.id);
  assert.equal(extractedPane.id, right.id);
  assert.equal(remainingTree.type, 'terminal');
  assert.equal(remainingTree.id, left.id);
});

check('extracting the only pane leaves nothing behind', () => {
  const a = createTerminalPane(session('a'), true);
  const { extractedPane, remainingTree } = extractPane(a, a.id);
  assert.equal(extractedPane.id, a.id);
  assert.equal(remainingTree, null);
});

check('extracting an absent pane reports nothing and keeps the tree', () => {
  const a = createTerminalPane(session('a'), true);
  const tree = splitPane(a, a.id, 'horizontal', session('b'));
  const { extractedPane, remainingTree } = extractPane(tree, 'absent');
  assert.equal(extractedPane, null);
  assert.deepEqual(leafIds(remainingTree), leafIds(tree));
});

check('reorganising decides direction and order from the drop position', () => {
  const build = () => {
    const a = createTerminalPane(session('a'), true);
    let t = splitPane(a, a.id, 'horizontal', session('b'));
    const b = getAllPanes(t).find((p) => p.session.connectionName === 'b');
    return { tree: splitPane(t, b.id, 'vertical', session('c')), bId: b.id };
  };

  // Dropping 'c' to the left of 'a': horizontal split, source first.
  let { tree } = build();
  let aPane = getAllPanes(tree).find((p) => p.session.connectionName === 'a');
  let cPane = getAllPanes(tree).find((p) => p.session.connectionName === 'c');
  let out = reorganizePane(tree, cPane.id, aPane.id, 'left');
  let placed = findPaneById(out, out.children[0].id);
  assert.equal(out.children[0].type, 'split');
  assert.equal(out.children[0].direction, 'horizontal');
  assert.deepEqual(getAllSessions(out.children[0]).map((s) => s.connectionName), ['c', 'a']);

  // Dropping it below instead: vertical split, source second.
  ({ tree } = build());
  aPane = getAllPanes(tree).find((p) => p.session.connectionName === 'a');
  cPane = getAllPanes(tree).find((p) => p.session.connectionName === 'c');
  out = reorganizePane(tree, cPane.id, aPane.id, 'bottom');
  assert.equal(out.children[0].direction, 'vertical');
  assert.deepEqual(getAllSessions(out.children[0]).map((s) => s.connectionName), ['a', 'c']);

  // Every pane survives a move — a reorganise must never drop one.
  assert.equal(getAllPanes(out).length, 3);
  void placed;
});

check('reorganising onto itself is a no-op', () => {
  const a = createTerminalPane(session('a'), true);
  const tree = splitPane(a, a.id, 'horizontal', session('b'));
  const [left] = tree.children;
  assert.equal(reorganizePane(tree, left.id, left.id, 'left'), tree);
});

check('an empty tree is handled by every reader without throwing', () => {
  assert.equal(findPaneById(null, 'x'), null);
  assert.equal(findParent(null, 'x'), null);
  assert.equal(closePane(null, 'x'), null);
  assert.equal(setFocusedPane(null, 'x'), null);
  assert.equal(getFocusedPane(null), null);
  assert.equal(getFirstLeafPane(null), null);
  assert.deepEqual(getAllSessions(null), []);
  assert.deepEqual(getAllPanes(null), []);
  assert.deepEqual(getSessionsInPane(null, 'x'), []);
  assert.equal(updateSplitRatio(null, 'x', 0.5), null);
  assert.equal(splitPane(null, 'x', 'horizontal', session('a')), null);
});

check('createSplitPane keeps the direction, ratio and child order it is given', () => {
  const a = createTerminalPane(session('a'));
  const b = createTerminalPane(session('b'));
  const s = createSplitPane('vertical', a, b, 0.25);
  assert.equal(s.type, 'split');
  assert.equal(s.direction, 'vertical');
  assert.equal(s.ratio, 0.25);
  assert.deepEqual(names(s), ['a', 'b']);
});

// Pane kinds: the tree has to carry a leaf it knows nothing about.
//
// `mockLeaf` is a leaf of a kind paneTree has never heard of — which is exactly what
// an SFTP or agent pane will be to it. These checks are the reason the structural
// tests in paneTree moved from `type === 'terminal'` to `isLeaf()`: every one of them
// fails against the old file, because a pane that was not a terminal was not a pane.
const mockLeaf = (name) => ({ id: `m-${name}`, type: 'sftp', isFocused: false });

check('isLeaf answers about shape, not about kind', () => {
  assert.equal(isLeaf(createTerminalPane(session('a'))), true);
  assert.equal(isLeaf(mockLeaf('a')), true);
  assert.equal(isLeaf(createSplitPane('horizontal', createTerminalPane(session('a')), mockLeaf('b'))), false);
});

check('a leaf of an unknown kind is a leaf to every traversal', () => {
  const t = createTerminalPane(session('a'), true);
  const m = mockLeaf('b');
  const tree = createSplitPane('horizontal', t, m);

  assert.deepEqual(leafIds(tree), [t.id, m.id]);
  assert.equal(getFirstLeafPane(tree).id, t.id);
  assert.equal(findPaneById(tree, m.id).id, m.id);
  assert.equal(findParent(tree, m.id).id, tree.id);
  assert.equal(findParent(m, 'anything'), null);
});

check('focus moves onto an unknown kind and off the terminal', () => {
  const t = createTerminalPane(session('a'), true);
  const tree = setFocusedPane(createSplitPane('horizontal', t, mockLeaf('b')), 'm-b');

  assert.equal(getFocusedPane(tree).id, 'm-b');
  assert.equal(getAllPanes(tree).filter((p) => p.isFocused).length, 1);
  assert.equal(getAllPanes(tree).find((p) => p.id === t.id).isFocused, false);
});

check('closing a terminal collapses the split onto the unknown kind', () => {
  const t = createTerminalPane(session('a'), true);
  const m = mockLeaf('b');
  const tree = createSplitPane('horizontal', t, m);

  const left = closePane(tree, m.id);
  assert.equal(left.id, t.id);

  const right = closePane(tree, t.id);
  assert.equal(right.id, m.id);
  assert.equal(closePane(m, m.id), null);
});

check('an unknown kind splits, detaches and reorganises like any pane', () => {
  const m = mockLeaf('a');
  const split = splitPane(m, m.id, 'vertical', session('b'));
  assert.equal(split.type, 'split');
  assert.equal(split.children[0].id, m.id);
  assert.equal(split.children[0].isFocused, false);
  assert.equal(split.children[1].type, 'terminal');

  const { extractedPane, remainingTree } = extractPane(split, m.id);
  assert.equal(extractedPane.id, m.id);
  assert.equal(remainingTree.type, 'terminal');

  const t = createTerminalPane(session('c'), true);
  const pair = createSplitPane('horizontal', t, mockLeaf('d'));
  const moved = reorganizePane(pair, 'm-d', t.id, 'top');
  assert.equal(moved.direction, 'vertical');
  assert.deepEqual(leafIds(moved), ['m-d', t.id]);
});

check('the session helpers pass over a leaf that holds no session', () => {
  const t = createTerminalPane(session('a'), true);
  const m = mockLeaf('b');
  const tree = createSplitPane('horizontal', t, m);

  assert.deepEqual(names(tree), ['a']);
  assert.deepEqual(getSessionsInPane(tree, m.id), []);
  assert.deepEqual(getSessionsInPane(tree, t.id).map((s) => s.connectionName), ['a']);

  const renamed = updateSession(tree, 's-a', (s) => ({ ...s, connectionName: 'renamed' }));
  assert.deepEqual(names(renamed), ['renamed']);
  assert.deepEqual(renamed.children[1], m);
  assert.equal(updateSession(m, 's-a', () => { throw new Error('must not be called'); }), m);
});

check('extracting a split container is refused — only a leaf detaches', () => {
  // extractPane promises a leaf: the caller opens a new tab from it, and a container
  // handed over instead would be nested as if it were content. The guard is on both
  // children, so both sides are checked here — a mutation that drops either one
  // passed this file until this check existed.
  const a = createTerminalPane(session('a'), true);
  const withB = splitPane(a, a.id, 'horizontal', session('b'));
  const [, b] = withB.children;

  const splitOnTheLeft = splitPane(withB, a.id, 'vertical', session('c'));
  const left = extractPane(splitOnTheLeft, splitOnTheLeft.children[0].id);
  assert.equal(left.extractedPane, null);
  assert.equal(left.remainingTree, splitOnTheLeft);

  const splitOnTheRight = splitPane(withB, b.id, 'vertical', session('d'));
  const right = extractPane(splitOnTheRight, splitOnTheRight.children[1].id);
  assert.equal(right.extractedPane, null);
  assert.equal(right.remainingTree, splitOnTheRight);
});

check('closing a split by its id: a child collapses, the root does not', () => {
  // This asymmetry is pre-existing and deliberately left alone here, because PR 2 is a
  // refactor and this is a behaviour question. `closePane` tests a child's id without
  // asking whether it is a leaf, so naming a child split removes its whole subtree;
  // the root is only matched by the leaf guard, so naming the root does nothing.
  //
  // Nothing reaches either case today — close buttons live on leaves — and which of
  // the two is right belongs with the pane-kind registry, where disposing a pane's
  // contents gets an owner. Pinned so that answering it has to be deliberate.
  const a = createTerminalPane(session('a'), true);
  const withB = splitPane(a, a.id, 'horizontal', session('b'));
  const tree = splitPane(withB, a.id, 'vertical', session('c'));

  assert.deepEqual(names(tree), ['a', 'c', 'b']);
  assert.deepEqual(names(closePane(tree, tree.children[0].id)), ['b']);
  assert.deepEqual(leafIds(closePane(tree, tree.id)), leafIds(tree));
});

console.log(failures === 0 ? '\npane tree: all checks passed' : `\npane tree: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
