/**
 * WHAT IS IN EFFECT, as a parse rather than as a screen.
 *
 * The read is one command and its answer is a pure function of the text that came back,
 * so this is where it belongs: a browser test per layout would be minutes of SSH for
 * decisions a table settles — the same argument `agent-adapters-check.mjs` makes.
 *
 * ADR 0022 §6 for the shape: two layers, the project's over the account's, every row
 * carrying its path, and a copy that lost shown LOSING rather than hidden.
 *
 * Run: node e2e/agent-context-check.mjs
 */
import assert from 'node:assert/strict';

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message.split('\n')[0]}`);
    failed++;
  }
};

import {
  agentContextCmd,
  parseAgentContext,
} from '../apps/desktop/src/utils/agentAdapters.ts';

console.log('\nthe command it runs:');

check('refuses a directory that is not absolute', () => {
  assert.equal(agentContextCmd('relative/path'), null);
  assert.equal(agentContextCmd(''), null);
});

check('refuses a path that climbs', () => {
  assert.equal(agentContextCmd('/srv/app/../../etc'), null);
});

check('reads the project layer and the account layer, and nothing else', () => {
  const cmd = agentContextCmd('/srv/acme/api');
  assert.match(cmd, /'\/srv\/acme\/api\/\.claude'/, 'the project layer is named');
  assert.match(cmd, /"\$HOME\/\.claude"/, 'the account layer is the shell\'s own HOME');
  // BOUNDED, like every other read on this path. A settings file is named by whoever owns
  // the account, so a read with no ceiling is one somebody else decides the cost of.
  assert.match(cmd, /head -c 65536/);
});

check('quotes a directory with a space in it', () => {
  const cmd = agentContextCmd('/srv/two words/api');
  assert.match(cmd, /'\/srv\/two words\/api\/\.claude'/);
});

console.log('\nthe answer it parses:');

const OUT = [
  '__account__ deploy@10.0.0.5',
  '__skill__ project /srv/acme/api/.claude/skills/deploy-runbook/SKILL.md',
  '__skill__ project /srv/acme/api/.claude/skills/commit-conventions/SKILL.md',
  '__skill__ user /home/deploy/.claude/skills/commit-conventions/SKILL.md',
  '__skill__ user /home/deploy/.claude/skills/rust-review/SKILL.md',
  '__cmd__ project /srv/acme/api/.claude/commands/gate.md',
  '__cmd__ user /home/deploy/.claude/commands/adr.md',
  '__settings__ project /srv/acme/api/.claude/settings.json',
  JSON.stringify({
    hooks: {
      PostToolUse: [
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'ruff format "$F"' }] },
      ],
    },
  }),
  '__endsettings__',
  '__settings__ user /home/deploy/.claude/settings.json',
  JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'curl -s https://x' }] }] },
  }),
  '__endsettings__',
].join('\n');

check('the account it was resolved under', () => {
  assert.equal(parseAgentContext(OUT).account, 'deploy@10.0.0.5');
});

check('a skill is named by the directory that holds its SKILL.md', () => {
  const names = parseAgentContext(OUT).skills.map((s) => s.name);
  assert.deepEqual(names, [
    'deploy-runbook',
    'commit-conventions',
    'commit-conventions',
    'rust-review',
  ]);
});

check('a command is named the way it is typed', () => {
  assert.deepEqual(
    parseAgentContext(OUT).commands.map((c) => c.name),
    ['/gate', '/adr'],
  );
});

check('THE ACCOUNT COPY THAT LOST IS MARKED, not hidden', () => {
  const skills = parseAgentContext(OUT).skills;
  const shadowed = skills.filter((s) => s.shadowed).map((s) => `${s.from}:${s.name}`);
  // Only the user's `commit-conventions`: the project layer defines one too. Its own
  // `rust-review` is unopposed, and neither project row can be shadowed by anything.
  assert.deepEqual(shadowed, ['user:commit-conventions']);
});

check('and a project row is never marked as having lost', () => {
  const skills = parseAgentContext(OUT).skills;
  assert.deepEqual(
    skills.filter((s) => s.from === 'project' && s.shadowed),
    [],
  );
});

check('every row carries the path it came from', () => {
  const ctx = parseAgentContext(OUT);
  for (const row of [...ctx.skills, ...ctx.commands, ...ctx.hooks]) {
    assert.match(row.path, /^\//, `a row with no path: ${JSON.stringify(row)}`);
  }
});

check('a hook carries its event, its matcher and the command that will run', () => {
  const hooks = parseAgentContext(OUT).hooks;
  assert.deepEqual(hooks, [
    {
      event: 'PostToolUse',
      command: 'ruff format "$F"',
      path: '/srv/acme/api/.claude/settings.json',
      from: 'project',
      matcher: 'Edit|Write',
    },
    {
      event: 'PreToolUse',
      command: 'curl -s https://x',
      path: '/home/deploy/.claude/settings.json',
      from: 'user',
    },
  ]);
});

check('a matcher-less hook carries no matcher rather than an empty one', () => {
  const hook = parseAgentContext(OUT).hooks.find((h) => h.event === 'PreToolUse');
  assert.ok(!('matcher' in hook), 'an absent matcher must be absent, not ""');
});

check('A SETTINGS FILE THAT WILL NOT PARSE IS SAID, not swallowed', () => {
  const out = [
    '__settings__ project /srv/app/.claude/settings.json',
    '{ this is not json',
    '__endsettings__',
  ].join('\n');
  const ctx = parseAgentContext(out);
  assert.deepEqual(ctx.hooks, []);
  // A panel showing fewer hooks than will fire is worse than one saying it could not read
  // a file, so the path comes back.
  assert.deepEqual(ctx.unreadable, ['/srv/app/.claude/settings.json']);
});

check('a shape that is not the hooks shape yields nothing rather than a guess', () => {
  const out = [
    '__settings__ user /h/.claude/settings.json',
    JSON.stringify({ hooks: { PreToolUse: 'a string, not a list' }, other: 1 }),
    '__endsettings__',
  ].join('\n');
  // A hook invented by a lenient parser is a command this panel claims will run and
  // will not.
  assert.deepEqual(parseAgentContext(out).hooks, []);
  assert.deepEqual(parseAgentContext(out).unreadable, []);
});

check("a hook with no command is not a hook", () => {
  const out = [
    '__settings__ user /h/.claude/settings.json',
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '   ' }] }] } }),
    '__endsettings__',
  ].join('\n');
  assert.deepEqual(parseAgentContext(out).hooks, []);
});

check('a login shell that chats is not a skill', () => {
  const out = [
    'Welcome to Ubuntu 24.04',
    "bash: warning: setlocale: LC_ALL: cannot change locale",
    '__account__ me@here',
    '__skill__ project /srv/a/.claude/skills/one/SKILL.md',
    'You have mail.',
  ].join('\n');
  const ctx = parseAgentContext(out);
  assert.equal(ctx.skills.length, 1);
  assert.equal(ctx.account, 'me@here');
});

check('nothing read at all is an empty answer and not a failure', () => {
  const ctx = parseAgentContext('');
  assert.deepEqual(ctx, { skills: [], commands: [], hooks: [], unreadable: [] });
});

if (failed) {
  console.log(`\n${failed} failed\n`);
  process.exit(1);
}
console.log('\nall ok\n');
