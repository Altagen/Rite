/**
 * Agent discovery: the command Rite sends to a machine, and the parser for what comes
 * back. ADR 0022 §4 — one command per machine, asked for explicitly.
 *
 * Two things are being held here. The first is that the script is a SCRIPT on the far
 * side: SSH exec hands it to the account's login shell, so it runs inside `sh -c` and
 * is checked by asking a shell to parse it. The second is the framing. The script
 * interleaves Rite's markers with output read off a host, and a transcript's file name
 * can contain anything a filename can — so a line that looks like a marker has to be
 * read as data, and the check proves it by writing one.
 *
 * Loads apps/desktop/src/utils/agentProbe.ts directly, so these are the shipped
 * builder and parser rather than a copy.
 *
 * Run: node e2e/agent-probe-check.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentProbeCmd, parseAgentProbe } from '../apps/desktop/src/utils/agentProbe.ts';

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

const A = (id, bin, list) => ({ id, bin, list });
const SIX = [
  A('claude', 'claude', 'ls ~/.claude/projects/*/*.jsonl'),
  A('codex', 'codex', 'ls ~/.codex/sessions/*/*/*/*.jsonl'),
  A('gemini', 'gemini', 'gemini --list-sessions'),
  A('grok', 'grok', 'ls ~/.grok/sessions'),
  A('hermes', 'hermes', 'sqlite3 ~/.hermes/state.db "select id,title from sessions"'),
  A('opencode', 'opencode', 'opencode session list --format json'),
];

/** Ask a shell to parse a command string without running it. */
const parses = (shell, cmd) => spawnSync(shell, ['-n', '-c', cmd], { encoding: 'utf8' }).status === 0;

console.log('the command:');

check('it parses as POSIX, with every shipped adapter in it', () => {
  // The floor. An adapter's `list` is pasted in as written, so a tool the user added
  // can break this — which is why the Tools dialog is where a broken one is seen.
  assert.ok(parses('sh', agentProbeCmd(SIX)), agentProbeCmd(SIX));
  assert.ok(parses('bash', agentProbeCmd(SIX)));
});

check('shell syntax never reaches the login shell', () => {
  // `if … then … fi` is a parse error in fish, and the login shell is the account's.
  const cmd = agentProbeCmd(SIX);
  assert.ok(cmd.startsWith("sh -c '"), cmd.slice(0, 40));
  if (spawnSync('fish', ['--version']).status === 0) {
    assert.ok(parses('fish', cmd), 'fish could not parse it');
  }
});

check('a tool is named by position, so there is no id in the command', () => {
  // An id is Rite's own key, but an id the USER chose when adding a CLI is text. It is
  // never interpolated: the marker carries the index, which is an integer.
  const cmd = agentProbeCmd([A("x'; id #", 'claude', 'ls')]);
  assert.ok(cmd.includes('__tool__ 0'), cmd);
  assert.ok(!cmd.includes('; id #'), cmd);
});

check('a binary name is quoted', () => {
  assert.ok(agentProbeCmd([A('t', 'a b', 'ls')]).includes("'a b'"));
});

console.log('\nwhat comes back:');

check('a tool that is not there says so, and claims nothing else', () => {
  const [t] = parseAgentProbe('__tool__ 0\n__missing__\n', SIX);
  assert.deepEqual(t, { id: 'claude', installed: false });
});

check('a listing that exits 0 with nothing is an empty list, not a missing one', () => {
  // "Answers and has nothing" is a different fact from "never asked", and the manager
  // shows them differently. An empty `lines` array is what carries that.
  const [t] = parseAgentProbe('__tool__ 3\n__version__ 1.0\n__body__ 0 0\n', SIX);
  assert.deepEqual(t, { id: 'grok', installed: true, version: '1.0', lines: [] });
});

check('a listing that fails keeps the status and the text, and no lines', () => {
  // Installed, reachable, and still unable to answer — the row says why instead of
  // vanishing. The sentence a user reads is the view's to write, so this is facts only.
  const [t] = parseAgentProbe(
    '__tool__ 2\n__version__ 0.4.2\n__body__ 1 2\nunknown flag --list-sessions\nusage: gemini\n',
    SIX,
  );
  assert.equal(t.lines, undefined);
  assert.deepEqual(t.failure, { status: 1, output: 'unknown flag --list-sessions\nusage: gemini' });
});

check('a line that looks like a marker is data', () => {
  // A transcript's file name can contain a newline, so a listing can print anything.
  // The count is what makes this unambiguous: markers are never searched for.
  const out = '__tool__ 0\n__version__ 2.1\n__body__ 0 3\n/p/a.jsonl\n__tool__ 1\n__missing__\n';
  const tools = parseAgentProbe(out, SIX);
  assert.equal(tools.length, 1, 'a filename opened a second section');
  assert.deepEqual(tools[0].lines, ['/p/a.jsonl', '__tool__ 1', '__missing__']);
});

check('a section that never arrived is absent, not absent-mindedly installed', () => {
  // The exec is capped at 15 s. A tool whose section did not come back has not been
  // answered for, and "not answered" is not "not installed".
  const tools = parseAgentProbe('__tool__ 0\n__version__ 2.1\n__body__ 0 1\n/p/a.jsonl\n', SIX);
  assert.deepEqual(
    tools.map((t) => t.id),
    ['claude'],
  );
});

check('a status that is not a number leaves the tool answered by nothing', () => {
  // It used to become `failure.status = NaN`, which a view that renders what it is
  // given puts on screen as "exited NaN". Installed, and nothing claimed about the
  // listing — the same state as a section that never arrived.
  const [tool] = parseAgentProbe(
    ['__tool__ 0', '__version__ 2.1.4', '__body__ oops 1', 'a line'].join('\n'),
    SIX,
  );
  assert.deepEqual(tool, { id: 'claude', installed: true, version: '2.1.4' });
});

check('and a status that is not a whole number is not a status either', () => {
  // `$?` is an integer. A fractional one is not a shell's answer, and the guard says
  // integer rather than finite — this is the case that tells the two apart.
  const [tool] = parseAgentProbe(['__tool__ 0', '__body__ 1.5 0'].join('\n'), SIX);
  assert.deepEqual(tool, { id: 'claude', installed: true });
});

check('a count that is not a number takes no lines with it', () => {
  // The other half of the same framing: `__body__ 0 x` has a readable status and an
  // unreadable count, so the listing is empty rather than everything that follows.
  // Held here even though `slice` coerces a NaN end to nothing by itself — the property
  // is what matters, and the next edit to that line should not have to rediscover it.
  const [tool] = parseAgentProbe(
    ['__tool__ 0', '__body__ 0 x', 'not mine', '__tool__ 1', '__missing__'].join('\n'),
    SIX,
  );
  assert.deepEqual(tool.lines, []);
});

check('a tool named twice is one tool, and the first section wins', () => {
  // Two rows with one id is a list a view cannot key. And if the framing ever did slip,
  // the second section is the one that could carry something a host chose.
  const tools = parseAgentProbe(
    ['__tool__ 0', '__body__ 0 1', 'first', '__tool__ 0', '__body__ 0 1', 'second'].join('\n'),
    SIX,
  );
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0].lines, ['first']);
});

check('a login shell that greets us is ignored', () => {
  // `Using Node v24.21.0` — measured, from a version manager in a shell profile.
  const tools = parseAgentProbe('Using Node v24.21.0\n\n__tool__ 0\n__missing__\n', SIX);
  assert.deepEqual(tools, [{ id: 'claude', installed: false }]);
});

console.log('\nthrough a real shell:');

check('the script and the parser agree, run end to end', () => {
  // Built out of tools every POSIX host has, so it does not depend on an agent CLI
  // being installed: one present, one absent, one that fails, one that answers
  // nothing. This is the only assertion here that proves the framing the parser
  // relies on is the framing the script actually emits.
  // A tool of our own, so `--version` printing several lines is a fact of the test and
  // not of whatever coreutils the host shipped. An absolute path is also what a CLI a
  // user added by hand often is.
  const chatty = join(mkdtempSync(join(tmpdir(), 'rite-probe-')), 'chatty');
  writeFileSync(chatty, "#!/bin/sh\nprintf '%s\\n' '9.9 (chatty)' 'Copyright' 'no warranty'\n");
  chmodSync(chatty, 0o755);

  const adapters = [
    A('present', 'printf', "printf '%s\\n' /p/a.jsonl /p/b.jsonl"),
    A('absent', 'rite-no-such-binary', 'ls'),
    A('failing', 'printf', 'exit 3'),
    A('empty', 'printf', 'true'),
    A('chatty', chatty, 'true'),
  ];
  const run = spawnSync('sh', ['-c', agentProbeCmd(adapters)], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const tools = parseAgentProbe(run.stdout, adapters);
  assert.deepEqual(
    tools.map((t) => t.id),
    ['present', 'absent', 'failing', 'empty', 'chatty'],
  );
  assert.deepEqual(tools[0].lines, ['/p/a.jsonl', '/p/b.jsonl']);
  assert.equal(tools[1].installed, false);
  assert.equal(tools[2].failure.status, 3);
  assert.deepEqual(tools[3].lines, []);
  // The chip shows a version, so a version is one line. The rest of what a binary
  // says about its licence is not a fact about a conversation.
  assert.equal(tools[4].version, '9.9 (chatty)');
  assert.deepEqual(tools[4].lines, []);
});

console.log(`\n${passed} checks passed`);
