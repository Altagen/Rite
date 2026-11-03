/**
 * The seven shipped agent adapters: their two commands, and the parser that turns each
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
  ASK_CAP,
  agentRemoveCmd,
  agentResumeCmd,
  agentStartArgv,
  agentStartCmd,
  shippedAdapter,
  withoutConversation,
} from '../apps/desktop/src/utils/agentAdapters.ts';
import { agentProbeCmd, parseAgentProbe } from '../apps/desktop/src/utils/agentProbe.ts';
import { agentVerdict, agentBlockedReason } from '../apps/desktop/src/utils/agentPolicy.ts';

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
const UUID_A = '3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11';
const UUID_B = '01a1a05b-31b7-7b11-b3b8-35333cf07b0b';

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
    ['claude', 'codex', 'gemini', 'grok', 'antigravity', 'hermes', 'opencode'],
  );
});

check('the three commands the mock had wrong are the measured ones now', () => {
  // Codex files under sessions/YYYY/MM/DD, and `sh` has no recursive glob — `**` is one
  // `*`, so the mock's command listed a directory level that does not exist.
  assert.match(A('codex').list, /ls -1t ~\/\.codex\/sessions\/\*\/\*\/\*\/\*\.jsonl/);
  // Grok keeps one directory per URL-encoded working directory, each holding one
  // directory per conversation. `ls ~/.grok/sessions` listed the projects, and the
  // history file is what tells a conversation from what sits beside one.
  assert.match(A('grok').list, /ls -1t ~\/\.grok\/sessions\/\*\/\*\/chat_history\.jsonl/);
  // Gemini's is KEPT, deliberately: `--resume` takes an index, and only this listing
  // produces one. What changed is that the row is scoped to a directory, not a machine.
  assert.equal(A('gemini').list, 'gemini --list-sessions 2>&1');
  assert.equal(A('gemini').idKind, 'index');
});

check('a file listing reads the first thing a person typed', () => {
  // WHAT A CONVERSATION IS to someone looking for it, and the only field that needed
  // reading inside a file. `"role":"user"` marks a human turn in both vendors, and the
  // first match is not always the person: Codex opens every session with an
  // `<environment_context>` block under that same role, so the preamble is dropped by
  // name and the first that remains is the question.
  for (const id of ['claude', 'codex']) {
    assert.ok(A(id).list.includes('"role":"user"'), id);
    assert.ok(A(id).list.includes('!/environment_context/'), id);
    // Capped on the host, because a first message can be a pasted file and nobody wants
    // that shipped back two hundred times.
    assert.ok(A(id).list.includes(`substr($0,1,${ASK_CAP})`), id);
    // Four thousand, not a hundred and twenty: what the cap decides is what is shipped
    // back two hundred times, not what a card shows. The card truncates with CSS, at the
    // width it actually has, and the detail panel shows the whole of it.
    assert.equal(ASK_CAP, 4000);
  }
  // And the two whose transcripts a listing does not open: Grok's shape was not
  // measured, and an Antigravity conversation is a SQLite database.
  for (const id of ['grok', 'antigravity']) {
    assert.equal(A(id).list.includes('"role":"user"'), false, id);
  }
});

check('the question survives the cut it arrives with', () => {
  // The line is truncated at 600 characters ON THE HOST, so it is not a JSON document
  // any more. A reader that insisted on parsing one found nothing on real data — six
  // Claude transcripts, six blanks — while the same `awk` on the host found five.
  const cut =
    '{"parentUuid":null,"type":"user","message":{"role":"user","content":[{"type":"text",' +
    '"text":"Peux-tu me trouver mon micro"';
  const [c] = parse('claude', [
    `1793700000\tsentinel/${UUID_A}.jsonl\t${cut}`.replace(
      'sentinel',
      '/home/u/.claude/projects/-srv',
    ),
  ]);
  assert.equal(c.ask, 'Peux-tu me trouver mon micro');
  // And the rest of the line still parsed into what it was carrying.
  assert.equal(c.writtenAt, 1793700000);
  assert.equal(c.project, '-srv');
});

check('and an escape inside it does not end it early', () => {
  // A quote, a newline and a code point, all written as escapes in the transcript. A
  // reader that stopped at the first `"` would cut the question at its first quotation.
  const raw = String.raw`{"payload":{"role":"user","content":[{"text":"ligne\nune \"citation\" et \u00e9"}]}}`;
  const [c] = parse('codex', [
    `1793700000\t/home/u/.codex/sessions/2026/11/03/rollout-2026-11-03T08-41-33-${UUID_B}.jsonl\t${raw}`,
  ]);
  assert.equal(c.ask, 'ligne une "citation" et é');
});

check('a session nobody typed into has no question, and none is invented', () => {
  // Measured: of sixty-one Codex rollouts on one machine, sixty held no human turn at
  // all — they are runs Codex delegated to itself. A card says so rather than wearing a
  // title taken from somewhere else.
  const envOnly =
    '{"payload":{"role":"user","content":[{"text":"<environment_context>  <cwd>/srv</cwd>"}]}}';
  const path = `/home/u/.codex/sessions/2026/11/03/rollout-2026-11-03T08-41-33-${UUID_B}.jsonl`;
  assert.equal(parse('codex', [`1793700000\t${path}\t${envOnly}`])[0].ask, undefined);
  assert.equal(parse('codex', [`1793700000\t${path}\t`])[0].ask, undefined);
  assert.equal(parse('codex', [`1793700000\t${path}\tnot json at all`])[0].ask, undefined);
});

check('a file listing asks for the time it is sorted by', () => {
  // THE CARD AND THE LIST HAVE TO AGREE. Ordered by last-written and labelled with the
  // date in the file name, sixty-one Codex cards read as a shuffle: a conversation
  // started in September and resumed today sorts first and reads last.
  //
  // Two syntaxes, tried in order, because there is no portable one — `stat -c` is GNU
  // and `stat -f` is BSD. A host with neither leaves the field empty, and the order
  // still holds without a clock.
  for (const id of ['claude', 'codex', 'grok', 'antigravity']) {
    const list = A(id).list;
    assert.match(list, /^ls -1t /, id);
    assert.ok(list.includes('stat -c %Y "$f" 2>/dev/null || stat -f %m "$f"'), id);
    assert.ok(list.trimEnd().endsWith('done'), id);
    // A REAL TAB between the three fields. Written as `\t` it would reach `printf` as
    // two characters, `printf` would read the escape itself, and the parser would split
    // on a tab that is not there — measured once already on `stat -c`, which does not
    // interpret escapes at all.
    assert.ok(list.includes('printf \'%s\t%s\t%s\\n\' "$t" "$f" "$a"'), id);
  }
});

check('no listing uses a recursive glob, which sh does not have', () => {
  for (const a of SHIPPED_ADAPTERS) assert.equal(a.list.includes('**'), false, a.id);
});

check('no listing uses a GNU-only flag with nothing behind it', () => {
  // `find -printf` has no BSD spelling at all, so it is never reachable. `stat` has two
  // and both are tried, which is why that one is allowed here and this one is not.
  for (const a of SHIPPED_ADAPTERS) {
    assert.equal(/-printf/.test(a.list), false, a.id);
  }
});

check('every listing is capped, and an empty one is not a failure', () => {
  // `ls` answers non-zero when a glob matches nothing — the shell hands it the pattern —
  // and a tool with no conversations is not a tool that failed.
  // Every listing Rite shapes. The two it does not are the vendor's own output: Gemini
  // prints a project's sessions in prose, and opencode prints one JSON document — which
  // `head` would cut in half rather than shorten.
  for (const a of SHIPPED_ADAPTERS.filter((a) => a.id !== 'gemini' && a.id !== 'opencode')) {
    assert.ok(a.list.includes(`head -n ${LIST_CAP}`), a.id);
  }
  for (const id of ['claude', 'codex', 'grok', 'antigravity']) {
    // The status is the loop's, and a loop over nothing exits 0.
    assert.ok(A(id).list.includes('while IFS= read -r f; do'), id);
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
    antigravity: 'measured',
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

check('a listing becomes conversations, newest first, with their times', () => {
  const got = parse('claude', [
    '1793704737\t/home/u/.claude/projects/-srv-acme-api/3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11.jsonl',
    '1793377732\t/home/u/.claude/projects/-srv-acme-web/b7d2e4a1-90c6-4f38-8b15-3e9a0d6c2f77.jsonl',
  ]);
  assert.deepEqual(got, [
    {
      id: '3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11',
      path: '/home/u/.claude/projects/-srv-acme-api/3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11.jsonl',
      project: '-srv-acme-api',
      label: '-srv-acme-api',
      ask: undefined,
      rank: 0,
      writtenAt: 1793704737,
    },
    {
      id: 'b7d2e4a1-90c6-4f38-8b15-3e9a0d6c2f77',
      path: '/home/u/.claude/projects/-srv-acme-web/b7d2e4a1-90c6-4f38-8b15-3e9a0d6c2f77.jsonl',
      project: '-srv-acme-web',
      label: '-srv-acme-web',
      ask: undefined,
      rank: 1,
      writtenAt: 1793377732,
    },
  ]);
});

check('a host whose stat answered neither syntax still gets its conversations', () => {
  // The third branch of the chain prints the bare paths. The clock is lost, the order is
  // not — and a card then shows no time rather than one nobody measured.
  const [c] = parse('claude', [
    '/home/u/.claude/projects/-srv-acme-api/3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11.jsonl',
  ]);
  assert.equal(c.writtenAt, undefined);
  assert.equal(c.project, '-srv-acme-api');
});

check('a path that CONTAINS a tab is still a path, not a time and a path', () => {
  // The separator is a tab because a path can hold a space and rarely holds a tab — but
  // "rarely" is not "never", so the epoch is read only when the whole leading field is
  // digits. Without that test, the first tab in a directory name cuts the path in half
  // and the conversation is lost. A directory called `2026` is the other half of the
  // same rule: it is digits, but it is not alone before the first tab.
  const [c] = parse('claude', [
    '/home/u/.claude/pro\tjects/-srv-acme-api/3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11.jsonl',
  ]);
  assert.equal(c.writtenAt, undefined);
  assert.equal(c.project, '-srv-acme-api');
});

check('and a bare path with no tab at all carries no time', () => {
  const [c] = parse('claude', [
    '/home/u/.claude/projects/2026-srv/3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11.jsonl',
  ]);
  assert.equal(c.writtenAt, undefined);
  assert.equal(c.project, '2026-srv');
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
    '1793692980\t/home/u/.codex/sessions/2026/09/08/rollout-2026-09-08T12-52-12-01a080a5-9ce0-7841-bec7-866f002c969b.jsonl',
  ]);
  assert.deepEqual(got, [
    {
      id: '01a080a5-9ce0-7841-bec7-866f002c969b',
      path: '/home/u/.codex/sessions/2026/09/08/rollout-2026-09-08T12-52-12-01a080a5-9ce0-7841-bec7-866f002c969b.jsonl',
      label: '2026-09-08T12-52-12',
      ask: undefined,
      rank: 0,
      writtenAt: 1793692980,
    },
  ]);
});

check('the oldest NAME can be the most recent conversation, and the time says so', () => {
  // The measurement that looked right and was not: on the machine that was read, the
  // `2026-09-08` rollout had been written to that morning, because `codex resume`
  // appends to the file it reopens. `ls -t` puts it first, the parser must not reorder
  // by the name it just parsed — and the card has to show `writtenAt`, or a correctly
  // ordered list reads as a shuffled one.
  const got = parse('codex', [
    '1793692980\t/home/u/.codex/sessions/2026/09/08/rollout-2026-09-08T12-52-12-01a080a5-9ce0-7841-bec7-866f002c969b.jsonl',
    '1793691937\t/home/u/.codex/sessions/2026/11/03/rollout-2026-11-03T08-41-33-01a1a05b-31b7-7b11-b3b8-35333cf07b0b.jsonl',
  ]);
  assert.deepEqual(
    got.map((c) => [c.rank, c.label, c.writtenAt]),
    [
      [0, '2026-09-08T12-52-12', 1793692980],
      [1, '2026-11-03T08-41-33', 1793691937],
    ],
  );
  // The order is the times' own, which is the whole point of asking for them.
  assert.ok(got[0].writtenAt > got[1].writtenAt);
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
      '1793300000\t/home/u/.grok/sessions/%2Fsrv%2Facme%2Fapi/019fdcfe-08ee-7ca3-aaae-02470f138ad1/chat_history.jsonl',
    ]),
    [
      {
        id: '019fdcfe-08ee-7ca3-aaae-02470f138ad1',
        // The conversation's own FOLDER, not the history file the glob matched: a Grok
        // conversation is a directory, so that is what `remove` is given.
        path: '/home/u/.grok/sessions/%2Fsrv%2Facme%2Fapi/019fdcfe-08ee-7ca3-aaae-02470f138ad1',
        project: '/srv/acme/api',
        label: '/srv/acme/api',
        ask: undefined,
        rank: 0,
        writtenAt: 1793300000,
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

console.log('\nantigravity — a database per conversation:');

check('a uuid database is a conversation, with its time', () => {
  assert.deepEqual(
    parse('antigravity', [
      '1793700000\t/home/u/.gemini/antigravity-cli/conversations/37ef7294-637a-4270-ae67-43241917834e.db',
    ]),
    [
      {
        id: '37ef7294-637a-4270-ae67-43241917834e',
        path: '/home/u/.gemini/antigravity-cli/conversations/37ef7294-637a-4270-ae67-43241917834e.db',
        rank: 0,
        writtenAt: 1793700000,
      },
    ],
  );
});

check('and what sits beside them is not one', () => {
  // Measured: `conversation_summaries.db` lives in that same folder, so the glob returns
  // it. Only the uuid test tells the two apart — resuming a summaries file would ask the
  // vendor's CLI for a conversation whose id is `conversation_summaries`.
  assert.deepEqual(
    parse('antigravity', [
      '1793700000\t/home/u/.gemini/antigravity-cli/conversations/conversation_summaries.db',
      '1793600000\t/home/u/.gemini/antigravity-cli/conversations/history.jsonl',
    ]),
    [],
  );
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

console.log('\nremoving — the one command that cannot be taken back:');

const CLAUDE_PATH =
  '/home/u/.claude/projects/-srv-acme-api/3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11.jsonl';
const CLAUDE_ID = '3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11';

check('the path is quoted and the flags are the safe ones', () => {
  assert.equal(
    agentRemoveCmd(A('claude'), { id: CLAUDE_ID, path: CLAUDE_PATH, rank: 0 }),
    `rm -f -- '${CLAUDE_PATH}'`,
  );
  // `--` so a path is never read as a flag, and the quoting is `shellArg`'s, for the same
  // reason a resume line quotes an id: this is typed into a live shell on that host.
  assert.equal(
    agentRemoveCmd(A('claude'), {
      id: CLAUDE_ID,
      path: `/home/u/.claude/projects/-a b/${CLAUDE_ID}.jsonl`,
      rank: 0,
    }),
    `rm -f -- '/home/u/.claude/projects/-a b/${CLAUDE_ID}.jsonl'`,
  );
});

check('a grok conversation is a folder, so its removal is recursive', () => {
  const id = '019fdcfe-08ee-7ca3-aaae-02470f138ad1';
  assert.equal(
    agentRemoveCmd(A('grok'), { id, path: `/home/u/.grok/sessions/%2Fsrv/${id}`, rank: 0 }),
    `rm -rf -- '/home/u/.grok/sessions/%2Fsrv/${id}'`,
  );
});

check('THE PATH HAS TO BE NAMED BY THE CONVERSATION', () => {
  // The check that matters, because what comes back has `rm` at the front of it. A parser
  // that drifted and reported another file can no longer produce a command at all,
  // instead of producing one that removes somebody's project.
  assert.equal(
    agentRemoveCmd(A('claude'), {
      id: CLAUDE_ID,
      path: '/home/u/.claude/projects/-srv-acme-api/some-other-file.jsonl',
      rank: 0,
    }),
    null,
  );
  // Codex's file name is `rollout-<date>-<uuid>`, so "contains" and not "equals".
  const codexId = '01a080a5-9ce0-7841-bec7-866f002c969b';
  assert.ok(
    agentRemoveCmd(A('codex'), {
      id: codexId,
      path: `/home/u/.codex/sessions/2026/09/08/rollout-2026-09-08T12-52-12-${codexId}.jsonl`,
      rank: 0,
    }),
  );
});

check('a shallow path, a relative one and a traversal are all refused', () => {
  const at = (path) => agentRemoveCmd(A('claude'), { id: CLAUDE_ID, path, rank: 0 });
  // Four segments deep is the floor: every removable layout here is at least
  // `~/.<tool>/<something>/<file>` once the shell has expanded the tilde. A parser that
  // one day yields a truncated path cannot become a command that removes a home.
  assert.equal(at(`/home/${CLAUDE_ID}.jsonl`), null);
  assert.equal(at(`/home/u/${CLAUDE_ID}.jsonl`), null);
  assert.ok(at(`/home/u/x/${CLAUDE_ID}.jsonl`));
  assert.equal(at(`u/.claude/projects/-a/${CLAUDE_ID}.jsonl`), null);
  assert.equal(at(`/home/u/../../etc/${CLAUDE_ID}.jsonl`), null);
  assert.equal(at(''), null);
  assert.equal(at(undefined), null);
});

check('a tool whose listing names no file offers no removal', () => {
  // Three of the seven: an index, a sqlite row, a vendor subcommand. A removal invented
  // for them would be a guess carried out with `rm`, so the view shows no button.
  for (const id of ['gemini', 'hermes', 'opencode']) {
    assert.equal(A(id).remove, undefined, id);
    assert.equal(agentRemoveCmd(A(id), { id: 'x', path: '/a/b/c/x', rank: 0 }), null, id);
  }
  // And the four that can, all of them through `{path}`.
  for (const id of ['claude', 'codex', 'grok', 'antigravity']) {
    assert.ok(A(id).remove.includes('{path}'), id);
  }
});

check('a template that names the path twice substitutes both', () => {
  // The Tools dialog lets a user write this command, and "remove the file, then the
  // folder it was alone in" needs the path twice. One substitution would leave `{path}`
  // standing in a line that still runs.
  const twice = { ...A('claude'), remove: 'rm -f -- {path} && rmdir "$(dirname -- {path})"' };
  const out = agentRemoveCmd(twice, { id: CLAUDE_ID, path: CLAUDE_PATH, rank: 0 });
  assert.ok(!out.includes('{path}'), out);
  assert.equal(out.split(CLAUDE_PATH).length - 1, 2, out);
});

check('a template with no placeholder removes nothing rather than something else', () => {
  // The Tools dialog lets a user write these commands. `rm -rf --` with the path left out
  // is a command that still runs, so it is refused instead of sent.
  const odd = { ...A('claude'), remove: 'rm -rf --' };
  assert.equal(agentRemoveCmd(odd, { id: CLAUDE_ID, path: CLAUDE_PATH, rank: 0 }), null);
});

check('the removed conversation leaves the held listing, and only it', () => {
  // What a successful `rm` leaves behind: the answer is held per machine, so the line the
  // file was on is still there. Re-probing to learn what Rite had just done would be an
  // SSH round trip nobody asked for; showing the card until then would be showing a
  // conversation that is gone.
  const other = '/home/u/.claude/projects/-srv-acme-web/b7d2e4a1-90c6-4f38-8b15-3e9a0d6c2f77.jsonl';
  const lines = [`1793704737\t${CLAUDE_PATH}`, `1793377732\t${other}`];
  assert.deepEqual(withoutConversation(A('claude'), lines, CLAUDE_ID), [lines[1]]);
  // An id the listing does not hold takes nothing away.
  assert.deepEqual(withoutConversation(A('claude'), lines, 'nope'), lines);
});

check('a grok folder leaves by the id in its path, not by the file name', () => {
  const id = '019fdcfe-08ee-7ca3-aaae-02470f138ad1';
  const lines = [
    `1793300000\t/home/u/.grok/sessions/%2Fsrv/${id}/chat_history.jsonl`,
    '1793200000\t/home/u/.grok/sessions/%2Fsrv/019fdcfe-08ee-7ca3-aaae-02470f138ad2/chat_history.jsonl',
  ];
  assert.deepEqual(withoutConversation(A('grok'), lines, id), [lines[1]]);
});

console.log('\nstarting one, which is the tool with no arguments:');

check('the directory is a cd and an exec, and it is quoted', () => {
  // `exec` so the channel holds ONE process: the shell is replaced rather than left
  // waiting on a child, and closing the pane ends the agent instead of orphaning it.
  // A path always leaves `shellArg` quoted: it starts with a `/`, which is not a plain
  // argument — the same rule that keeps a name from being read as a flag.
  assert.equal(agentStartCmd(A('claude'), '/srv/acme/api'), "cd '/srv/acme/api' && exec claude");
  assert.equal(agentStartCmd(A('claude'), '/srv/a b'), "cd '/srv/a b' && exec claude");
  assert.equal(agentStartCmd(A('claude'), "/srv/it's"), "cd '/srv/it'\\''s' && exec claude");
  assert.equal(agentStartCmd(A('antigravity'), '/srv/x'), "cd '/srv/x' && exec agy");
});

check('no directory is the account landing where it always does', () => {
  // Its home, which only that machine can resolve — so nothing is named here.
  assert.equal(agentStartCmd(A('claude'), ''), 'claude');
  assert.equal(agentStartCmd(A('claude'), '   '), 'claude');
});

check('the local half is argv, because execvp takes it as written', () => {
  assert.deepEqual(agentStartArgv(A('codex')), ['codex']);
  assert.deepEqual(agentStartArgv(A('antigravity')), ['agy']);
});

console.log('\nwho may ask (ADR 0022 §3):');

const V = (over) => agentVerdict({ mode: null, native: false, ...over });

check('a standalone vault has no authority to consult', () => {
  // The user's vault, their network, their machines. There is no server to set a policy.
  assert.deepEqual(V({ mode: null }), { allowed: true });
  assert.deepEqual(
    V({ mode: { accounts: false, agentPolicy: { webui: false, clients: false } } }),
    {
      allowed: true,
    },
  );
});

check('a server that has never been configured has not said no', () => {
  // Reading silence as a refusal would turn a shipped feature off on upgrade, which is
  // the one outcome nobody asked for (ADR 0019's argument, reused).
  assert.deepEqual(V({ mode: { accounts: true } }), { allowed: true });
  assert.deepEqual(V({ mode: { accounts: true }, native: true }), { allowed: true });
});

check('each half answers for its own shell, and only for it', () => {
  const webuiOff = { accounts: true, agentPolicy: { webui: false, clients: true } };
  assert.deepEqual(V({ mode: webuiOff }), { allowed: false, shell: 'webui' });
  assert.deepEqual(V({ mode: webuiOff, native: true }), { allowed: true });
  const clientsOff = { accounts: true, agentPolicy: { webui: true, clients: false } };
  assert.deepEqual(V({ mode: clientsOff }), { allowed: true });
  assert.deepEqual(V({ mode: clientsOff, native: true }), { allowed: false, shell: 'clients' });
});

check('the refusal names the shell, because the two are different statements', () => {
  // In a browser nothing runs for anybody here; on a client the request is never made.
  // One "disabled" would flatten the two, and they send an administrator to one switch
  // or the other.
  assert.equal(agentBlockedReason({ allowed: true }), null);
  assert.equal(agentBlockedReason({ allowed: false, shell: 'webui' }), 'agent.offWebui');
  assert.equal(agentBlockedReason({ allowed: false, shell: 'clients' }), 'agent.offClients');
});

console.log();
if (failed) {
  console.log(`❌ ${failed} failed`);
  process.exit(1);
}
console.log('✅ the seven adapters list, parse and resume as measured');
