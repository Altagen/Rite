/**
 * The six shipped agent adapters: their two commands, and the parser that turns each
 * tool's listing into conversations.
 *
 * Loads `apps/desktop/src/utils/agentAdapters.ts` directly — Node strips the types and
 * the module imports nothing at runtime — so this tests the shipped adapters rather than
 * a copy of them.
 *
 * THE SAMPLES ARE THE REAL SHAPES WITH MADE-UP VALUES. Every layout below was measured
 * on 2026-11-03 against the installed binaries, and three of the four commands the mock
 * carried could not work. The paths and uuids are invented, because this file is public
 * and the machine that was measured is not.
 *
 * WHY THE COMMANDS ARE PINNED CHARACTER FOR CHARACTER. Each one is a fact about a
 * vendor's layout, and the three that were wrong were wrong in ways that read fine: a
 * `**` that `sh` treats as one `*`, a listing that answers for the current directory, a
 * directory of projects taken for a directory of conversations. An assertion on "the
 * command mentions codex" would have passed on all three.
 */
import assert from 'node:assert/strict';
import {
  SHIPPED_ADAPTERS,
  LIST_CAP,
  agentResumeCmd,
  shippedAdapter,
} from '../apps/desktop/src/utils/agentAdapters.ts';
import { agentProbeCmd, parseAgentProbe } from '../apps/desktop/src/utils/agentProbe.ts';

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
const A = (id) => {
  const a = shippedAdapter(id);
  assert.ok(a, `no adapter ${id}`);
  return a;
};
const parse = (id, lines) => A(id).parse(lines);

console.log('\nthe two commands, pinned:');

check('every shipped tool is there, and nothing else', () => {
  assert.deepEqual(
    SHIPPED_ADAPTERS.map((a) => a.id),
    ['claude', 'codex', 'gemini', 'grok', 'hermes', 'opencode'],
  );
});

check('the three commands the mock had wrong are the measured ones now', () => {
  // Codex files under sessions/YYYY/MM/DD, and `sh` has no recursive glob — `**` is one
  // `*`, so the mock's command listed a directory level that does not exist.
  assert.equal(
    A('codex').list,
    `ls -1t ~/.codex/sessions/*/*/*/*.jsonl 2>/dev/null | head -n ${LIST_CAP}`,
  );
  // Grok keeps one directory per URL-encoded working directory, each holding one
  // directory per conversation. `ls ~/.grok/sessions` listed the projects.
  assert.equal(
    A('grok').list,
    `ls -1t ~/.grok/sessions/*/*/chat_history.jsonl 2>/dev/null | head -n ${LIST_CAP}`,
  );
  // Gemini's is KEPT, deliberately: `--resume` takes an index, and only this listing
  // produces one. What changed is that the row is scoped to a directory, not a machine.
  assert.equal(A('gemini').list, 'gemini --list-sessions 2>&1');
  assert.equal(A('gemini').idKind, 'index');
});

check('no listing uses a recursive glob, which sh does not have', () => {
  for (const a of SHIPPED_ADAPTERS) assert.equal(a.list.includes('**'), false, a.id);
});

check('no listing uses a GNU-only flag a macOS host would refuse', () => {
  // `find -printf` and `stat -c` are the two that were reached for while writing this.
  for (const a of SHIPPED_ADAPTERS) {
    assert.equal(/-printf|stat\s+-c|stat\s+-f/.test(a.list), false, a.id);
  }
});

check('every file listing is ordered by write time, capped, and exits through head', () => {
  // The order IS the recency signal, so a listing that lost `-t` would silently sort by
  // name. The pipe is what makes the status 0 when a glob matches nothing.
  for (const id of ['claude', 'codex', 'grok']) {
    assert.match(A(id).list, /^ls -1t /, id);
    assert.ok(A(id).list.endsWith(`| head -n ${LIST_CAP}`), id);
  }
  assert.equal(LIST_CAP, 200);
});

check('a provenance says how far it goes, and only four were installed', () => {
  const kinds = Object.fromEntries(SHIPPED_ADAPTERS.map((a) => [a.id, a.from.kind]));
  assert.deepEqual(kinds, {
    claude: 'measured',
    codex: 'measured',
    gemini: 'measured',
    grok: 'measured',
    hermes: 'vendor',
    opencode: 'community',
  });
  // Gemini's flags were read off the binary; the shape of a populated row was not, and
  // the provenance has to say so rather than claim the whole adapter was seen working.
  assert.match(A('gemini').from.seen, /row shape unseen/);
});

check('the probe can build its command from a shipped adapter', () => {
  // The two files share one boundary on purpose: the probe needs `id`, `bin` and `list`
  // and knows nothing else about a vendor.
  const cmd = agentProbeCmd(SHIPPED_ADAPTERS);
  for (const a of SHIPPED_ADAPTERS) assert.ok(cmd.includes(a.bin), a.id);
  assert.equal(parseAgentProbe('', SHIPPED_ADAPTERS).length, 0);
});

console.log('\nclaude — a uuid per file, the project slugged into the path:');

check('a listing becomes conversations, newest first', () => {
  const got = parse('claude', [
    '/home/u/.claude/projects/-srv-acme-api/3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11.jsonl',
    '/home/u/.claude/projects/-srv-acme-web/b7d2e4a1-90c6-4f38-8b15-3e9a0d6c2f77.jsonl',
  ]);
  assert.deepEqual(got, [
    {
      id: '3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11',
      project: '-srv-acme-api',
      label: '-srv-acme-api',
      rank: 0,
    },
    {
      id: 'b7d2e4a1-90c6-4f38-8b15-3e9a0d6c2f77',
      project: '-srv-acme-web',
      label: '-srv-acme-web',
      rank: 1,
    },
  ]);
});

check('the slug is shown as it is, never turned back into a path', () => {
  // `-srv-acme-linux-s7` is `/srv/acme/linux-s7` or `/srv/acme/linux/s7` and the slug
  // cannot say which. Un-mangling it would put a wrong path on screen.
  const [c] = parse('claude', [
    '/home/u/.claude/projects/-srv-acme-linux-s7/3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11.jsonl',
  ]);
  assert.equal(c.project, '-srv-acme-linux-s7');
});

check('a project folder also holds a memory directory, which is not a conversation', () => {
  // Measured: `~/.claude/projects/<slug>/memory` sits beside the transcripts.
  assert.deepEqual(parse('claude', ['/home/u/.claude/projects/-srv-acme-api/memory']), []);
});

check('a transcript whose name is not a uuid is not a conversation either', () => {
  assert.deepEqual(parse('claude', ['/home/u/.claude/projects/-srv/notes.jsonl']), []);
});

console.log('\ncodex — the uuid is the tail of the name, and the date is not the recency:');

check('the uuid comes off the end and the start time becomes the label', () => {
  const got = parse('codex', [
    '/home/u/.codex/sessions/2026/09/08/rollout-2026-09-08T12-52-12-01a080a5-9ce0-7841-bec7-866f002c969b.jsonl',
  ]);
  assert.deepEqual(got, [
    { id: '01a080a5-9ce0-7841-bec7-866f002c969b', label: '2026-09-08T12-52-12', rank: 0 },
  ]);
});

check('the oldest NAME can be the most recent conversation, and the order is kept', () => {
  // This is the fourth measurement, and the one that looked right: on the machine that
  // was read, the `2026-09-08` rollout had been written to that morning. `ls -t` put it
  // first and the parser must not reorder by the name it just parsed.
  const got = parse('codex', [
    '/home/u/.codex/sessions/2026/09/08/rollout-2026-09-08T12-52-12-01a080a5-9ce0-7841-bec7-866f002c969b.jsonl',
    '/home/u/.codex/sessions/2026/11/03/rollout-2026-11-03T08-41-33-01a1a05b-31b7-7b11-b3b8-35333cf07b0b.jsonl',
  ]);
  assert.deepEqual(
    got.map((c) => [c.rank, c.label]),
    [
      [0, '2026-09-08T12-52-12'],
      [1, '2026-11-03T08-41-33'],
    ],
  );
});

check('a codex conversation has no project, because its path carries a date', () => {
  const [c] = parse('codex', [
    '/home/u/.codex/sessions/2026/11/03/rollout-2026-11-03T08-41-33-01a1a05b-31b7-7b11-b3b8-35333cf07b0b.jsonl',
  ]);
  assert.equal(c.project, undefined);
});

check('a file that is not a rollout is skipped', () => {
  assert.deepEqual(parse('codex', ['/home/u/.codex/sessions/2026/11/03/history.jsonl']), []);
});

console.log('\ngemini — an index, out of prose:');

check('a numbered row becomes a conversation whose id is that number', () => {
  assert.deepEqual(parse('gemini', ['1. Port the queue worker', '2) Trace the 502s']), [
    { id: '1', label: 'Port the queue worker', rank: 0 },
    { id: '2', label: 'Trace the 502s', rank: 1 },
  ]);
});

check('the empty answer is prose, and prose is not a conversation', () => {
  // Measured verbatim on 2026-11-03, in a project with no saved sessions.
  assert.deepEqual(parse('gemini', ['No previous sessions found for this project.']), []);
});

check('a heading or a blank line is dropped too', () => {
  assert.deepEqual(parse('gemini', ['Available sessions:', '', '  3   Add the dark theme']), [
    { id: '3', label: 'Add the dark theme', rank: 0 },
  ]);
});

console.log('\ngrok — a project directory, URL-encoded, and a conversation inside it:');

check('the id is the conversation directory and the project is decoded', () => {
  // URL-encoding is lossless, so decoding gives the real path back rather than a guess.
  assert.deepEqual(
    parse('grok', [
      '/home/u/.grok/sessions/%2Fsrv%2Facme%2Fapi/019fdcfe-08ee-7ca3-aaae-02470f138ad1/chat_history.jsonl',
    ]),
    [
      {
        id: '019fdcfe-08ee-7ca3-aaae-02470f138ad1',
        project: '/srv/acme/api',
        label: '/srv/acme/api',
        rank: 0,
      },
    ],
  );
});

check('what sits beside a conversation is not one', () => {
  // Measured: both of these live among real sessions, and `ls ~/.grok/sessions` — the
  // command the mock carried — returned the project directories and nothing else.
  assert.deepEqual(
    parse('grok', [
      '/home/u/.grok/sessions/%2Fsrv%2Facme%2Fapi/prompt_history.jsonl',
      '/home/u/.grok/sessions/session_search.sqlite',
    ]),
    [],
  );
});

check('an encoding that will not decode is kept as printed', () => {
  const [c] = parse('grok', [
    '/home/u/.grok/sessions/%zz/019fdcfe-08ee-7ca3-aaae-02470f138ad1/chat_history.jsonl',
  ]);
  assert.equal(c.project, '%zz');
});

console.log('\nhermes — rows out of SQLite:');

check('id and title split on the first bar', () => {
  assert.deepEqual(parse('hermes', ['s-1|Fix the flaky migration']), [
    { id: 's-1', label: 'Fix the flaky migration', rank: 0 },
  ]);
});

check('a title containing a bar keeps all of it', () => {
  // Splitting on every bar would cut the title in half, and `sqlite3` does not escape it.
  const [c] = parse('hermes', ['s-2|retry budget | queue worker']);
  assert.equal(c.label, 'retry budget | queue worker');
});

check('a row with no title is still a conversation', () => {
  assert.deepEqual(parse('hermes', ['s-3']), [{ id: 's-3', label: undefined, rank: 0 }]);
});

console.log('\nopencode — one JSON document:');

check('a JSON array becomes conversations', () => {
  assert.deepEqual(
    parse('opencode', ['[{"id":"ses_01","title":"Add the toggle"},', ' {"id":"ses_02"}]']),
    [
      { id: 'ses_01', label: 'Add the toggle', rank: 0 },
      { id: 'ses_02', label: undefined, rank: 1 },
    ],
  );
});

check('a document that does not parse yields nothing, and does not throw', () => {
  // The adapter is wrong for the installed build. An empty list is what the view already
  // knows how to say; an exception in a parser would take the whole probe down.
  assert.deepEqual(parse('opencode', ['opencode: unknown flag --format']), []);
  assert.deepEqual(parse('opencode', ['{"sessions":[]}']), []);
});

console.log('\nresuming:');

check('the id is quoted, not interpolated', () => {
  assert.equal(
    agentResumeCmd(A('claude'), '3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11'),
    'claude --resume 3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11',
  );
  // The whole reason it goes through `shellArg`: an id is read off a remote host and the
  // command is typed into a live shell on that host.
  assert.equal(agentResumeCmd(A('claude'), 'a; rm -rf ~'), "claude --resume 'a; rm -rf ~'");
  assert.equal(agentResumeCmd(A('hermes'), "it's"), "hermes --resume 'it'\\''s'");
});

check('every shipped adapter has a place for the id', () => {
  for (const a of SHIPPED_ADAPTERS) assert.ok(a.resume.includes('{id}'), a.id);
});

check('an adapter with no placeholder gets the id appended, not dropped', () => {
  // The Tools dialog lets the user write the resume command, and a forgotten `{id}` must
  // not silently resume whatever conversation the tool picks by itself.
  const odd = { ...A('claude'), resume: 'claude --resume' };
  assert.equal(agentResumeCmd(odd, 'x-1'), 'claude --resume x-1');
});

console.log();
if (failed) {
  console.log(`❌ ${failed} failed`);
  process.exit(1);
}
console.log('✅ the six adapters list, parse and resume as measured');
