/**
 * A setting that changes `/api/server/mode` has to tell the clients.
 *
 * ADR 0017 distributes a policy change live: the server broadcasts `policy-updated`, every
 * connected client re-pulls the mode, and the switch takes effect while the admin is still
 * looking at it. Two handlers did that — health-check and dashboard — and the other twelve
 * wrote their setting and said nothing.
 *
 * The visible cost was small and baffling: renaming the instance left the old name on the
 * context pastille of every open client until the person signed out and back in. The admin
 * typed a new name, saw the old one, and had no way to tell that from a rename that had not
 * saved. Open registration, Quick SSH, the default shell and the host-key mode behaved the
 * same way.
 *
 * This is a source check rather than a behavioural one on purpose. The behaviour needs a
 * second connected client to observe, and what actually went wrong was not a broken
 * broadcast — it was twelve handlers written one at a time, each copying a neighbour that
 * did not nudge either. A rule on the shape catches the thirteenth.
 *
 * Run: node e2e/mode-nudge-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../packages/rite-server/src/lib.rs', import.meta.url), 'utf8');

/**
 * Settings that are deliberately silent, with the reason.
 *
 * `remote_servers` is the desktop client's own roster of servers it can open — a local list
 * in its own store, not instance policy, and no other client has any business hearing about
 * it. `set_setting` is the configuration-file escape hatch (ADR 0020), which writes a key
 * named at runtime; it cannot know whether what it wrote is in the mode, so it nudges
 * unconditionally and is excluded from the pairing rule for that reason.
 */
const SILENT = new Map([
  ['remote_servers', 'the client’s own roster, not instance policy'],
]);

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
};

/** Every `async fn …` body in the file, by name. */
function handlers() {
  const out = new Map();
  const rx = /^async fn (\w+)\(/gm;
  const starts = [...SRC.matchAll(rx)].map((m) => ({ name: m[1], at: m.index }));
  for (const [i, h] of starts.entries()) {
    const end = i + 1 < starts.length ? starts[i + 1].at : SRC.length;
    out.set(h.name, SRC.slice(h.at, end));
  }
  return out;
}

const HANDLERS = handlers();

console.log('a setting change reaches the clients:');

check('every handler that writes a setting nudges the mode', () => {
  const quiet = [];
  for (const [name, body] of HANDLERS) {
    const keys = [...body.matchAll(/\.set_setting\(\s*"(\w+)"/g)].map((m) => m[1]);
    if (keys.length === 0) continue;
    if (keys.every((k) => SILENT.has(k))) continue;
    if (body.includes('nudge_mode_changed(')) continue;
    quiet.push(`${name} writes ${keys.join(', ')} and never calls nudge_mode_changed`);
  }
  assert.deepEqual(
    quiet,
    [],
    `${quiet.length} handler(s) change the mode in silence:\n        ` + quiet.join('\n        '),
  );
});

check('the nudge exists and broadcasts to everyone', () => {
  const fn = HANDLERS.get('nudge_mode_changed') ?? SRC.slice(SRC.indexOf('fn nudge_mode_changed'));
  assert.ok(
    SRC.includes('fn nudge_mode_changed'),
    'nudge_mode_changed is gone — the handlers below call nothing',
  );
  // Payload-less and session-less is what makes it reach every socket rather than one.
  assert.match(
    fn,
    /"event":\s*"policy-updated"/,
    'the nudge no longer sends policy-updated, which is the event the client listens for',
  );
  assert.match(fn, /"payload":\s*\{\s*\}/, 'a payload would scope the event to one session');
});

check('every silent setting says why', () => {
  for (const [key, why] of SILENT) {
    assert.ok(why && why.length > 10, `${key} is excused without a reason`);
  }
});

console.log(`\n${passed} checks passed`);
