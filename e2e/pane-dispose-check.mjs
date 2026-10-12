// Unit gate for pane disposal (apps/desktop/src/panes/dispose.ts).
//
// Closing a tab releases what every pane in it held. That used to be a loop over
// terminal session ids inside Workspace; the pane-kind registry made it a fan-out
// over panes, and its semantics are the kind of thing a later "simplification"
// quietly changes: awaiting in sequence instead of in parallel, or letting the first
// rejection abandon the rest and leave sessions open on the server.
//
// `dispose.ts` keeps no runtime imports for this reason — Node strips the types and
// the real module loads as-is, same as paneTree.
//
// Run from the repo root: `node e2e/pane-dispose-check.mjs`
import assert from 'node:assert/strict';
import { disposePanes } from '../apps/desktop/src/panes/dispose.ts';

const pane = (id) => ({ id, type: 'terminal', session: { id: `s-${id}`, connectionId: 'c', connectionName: id } });

// The checks are async, so they are queued here and awaited in order below rather
// than fired off and hoped for.
let failures = 0;
const queue = [];
const test = (what, fn) => queue.push([what, fn]);

test('every pane is disposed, and the count says so', async () => {
  const seen = [];
  const out = await disposePanes([pane('a'), pane('b'), pane('c')], () => async (p) => {
    seen.push(p.id);
  });
  assert.deepEqual(seen.sort(), ['a', 'b', 'c']);
  assert.equal(out.disposed, 3);
  assert.deepEqual(out.failed, []);
});

test('a kind that holds nothing is skipped, not counted and not a failure', async () => {
  const out = await disposePanes([pane('a'), pane('b')], (p) =>
    p.id === 'a' ? async () => {} : undefined
  );
  assert.equal(out.disposed, 1);
  assert.deepEqual(out.failed, []);
});

test('one failure does not stop the others, and is reported with its pane', async () => {
  const seen = [];
  const out = await disposePanes([pane('a'), pane('b'), pane('c')], () => async (p) => {
    seen.push(p.id);
    if (p.id === 'b') throw new Error('server already forgot it');
  });
  assert.deepEqual(seen.sort(), ['a', 'b', 'c'], 'every disposer ran');
  assert.equal(out.disposed, 2);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].pane.id, 'b');
  assert.equal(out.failed[0].error.message, 'server already forgot it');
});

test('a disposer that rejects without an Error is still reported, not thrown', async () => {
  const out = await disposePanes([pane('a')], () => async () => {
    throw 'a string, as the backend bridge does';
  });
  assert.equal(out.disposed, 0);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].error, 'a string, as the backend bridge does');
});

test('the disposers all start before any of them is awaited', async () => {
  // Sequential disposal would hold a tab open for as long as the slowest pane put
  // together, and the first pane would finish before the second had begun. Nothing
  // here resolves until all three have started, so a sequential implementation never
  // settles — Node then exits 13 on the unsettled top-level await, which is a real
  // failure rather than this check passing slowly. Verified by mutating it.
  const started = [];
  let release;
  const gate = new Promise((r) => { release = r; });

  const pending = disposePanes([pane('a'), pane('b'), pane('c')], () => async (p) => {
    started.push(p.id);
    if (started.length === 3) release();
    await gate;
  });

  await gate;
  assert.deepEqual(started.sort(), ['a', 'b', 'c']);
  const out = await pending;
  assert.equal(out.disposed, 3);
});

test('nothing to dispose is not an error', async () => {
  const out = await disposePanes([], () => { throw new Error('must not be consulted'); });
  assert.equal(out.disposed, 0);
  assert.deepEqual(out.failed, []);
});

console.log('pane disposal (the real module, types stripped):');
for (const [what, fn] of queue) {
  try {
    await fn();
    console.log(`  PASS  ${what}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${what}`);
    console.log(`        ${e.message.split('\n')[0]}`);
  }
}

console.log(failures === 0 ? '\npane disposal: all checks passed' : `\npane disposal: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
