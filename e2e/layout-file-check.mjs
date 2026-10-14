/**
 * The layouts file, held to its format.
 *
 * A layout is a file now (docs/LAYOUTS.md), which means the parser is the feature:
 * every pane that opens, every machine that is named, and every refusal the user
 * reads comes out of it. `store/layoutsFormat.ts` imports nothing, so Node's type
 * stripping loads the real module — these checks run against the parser the app
 * ships, not against a copy of it.
 *
 * What is pinned here is mostly the refusals, because they are what a user hits on
 * a Tuesday: the file came from another computer, a value lost its quotes, a table
 * got misspelt. A parser that accepts half of that silently is worse than one that
 * refuses all of it loudly.
 *
 * Run: node e2e/layout-file-check.mjs
 */
import assert from 'node:assert/strict';
import {
  parseLayoutFile,
  formatLayoutFile,
  paneLabel,
} from '../apps/desktop/src/store/layoutsFormat.ts';

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

console.log('a file that parses:');

check('a layout, its panes, and their order', () => {
  const { layouts, error } = parseLayoutFile(`
[[layout]]
name = "Morning"
startup = true

  [[layout.pane]]
  command = ""

  [[layout.pane]]
  machine = "web-01"
  command = "journalctl -fu app"
`);
  assert.equal(error, null);
  assert.equal(layouts.length, 1);
  assert.equal(layouts[0].name, 'Morning');
  assert.equal(layouts[0].startup, true);
  assert.equal(layouts[0].panes.length, 2);
  // Order is the file's order: a layout is an arrangement, not a set.
  assert.equal(layouts[0].panes[0].machine, undefined);
  assert.equal(layouts[0].panes[1].machine, 'web-01');
  assert.equal(layouts[0].panes[1].command, 'journalctl -fu app');
});

check('several layouts keep their own panes', () => {
  const { layouts } = parseLayoutFile(
    '[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  command = "top"\n\n' +
      '[[layout]]\nname = "B"\n\n  [[layout.pane]]\n  command = "df -h"\n\n  [[layout.pane]]\n  command = "free -h"\n',
  );
  assert.deepEqual(
    layouts.map((l) => [l.name, l.panes.length]),
    [
      ['A', 1],
      ['B', 2],
    ],
  );
});

check('startup defaults to off', () => {
  const { layouts } = parseLayoutFile('[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  command = "top"\n');
  assert.equal(layouts[0].startup, false);
});

check('a file of nothing but comments is a fresh install, not an error', () => {
  // What the server hands a new installation. If this were an error, every new user
  // would open the editor to a warning about a file they have never touched.
  const { layouts, error } = parseLayoutFile('# Layouts\n# [[layout]]\n# name = "Morning"\n');
  assert.equal(error, null);
  assert.deepEqual(layouts, []);
});

check('an empty file is not an error either', () => {
  assert.deepEqual(parseLayoutFile(''), { layouts: [], error: null });
  assert.deepEqual(parseLayoutFile('   \n\n'), { layouts: [], error: null });
});

check('a # inside a quoted command is part of the command', () => {
  // `git log --format=%h#%s` is one command. Stripping from the first # would hand
  // the shell half a format string and the user a mystery.
  const { layouts, error } = parseLayoutFile(
    '[[layout]]\nname = "Log"\n\n  [[layout.pane]]\n  command = "git log --format=%h#%s"   # the pretty one\n',
  );
  assert.equal(error, null);
  assert.equal(layouts[0].panes[0].command, 'git log --format=%h#%s');
});

console.log('\na file that does not:');

const fails = (text, line, fragment) => {
  const { layouts, error } = parseLayoutFile(text);
  assert.notEqual(error, null, 'this file should not have parsed');
  // Nothing loads: half a file is worse than none, because you cannot tell which
  // half you got.
  assert.deepEqual(layouts, [], 'a refused file must load no layouts');
  assert.equal(error.line, line, `expected the error on line ${line}, got ${error.line}`);
  assert.ok(
    error.message.includes(fragment),
    `the message should mention ${JSON.stringify(fragment)}: ${error.message}`,
  );
};

check('an unquoted value names its line', () => {
  fails('[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  machine = web-01\n', 5, 'quoted string');
});

check('a pane before any layout', () => {
  fails('  [[layout.pane]]\n  command = "top"\n', 1, '[[layout.pane]]');
});

check('a key outside any layout', () => {
  fails('name = "A"\n', 1, 'outside');
});

check('an unknown table', () => {
  fails('[[layout]]\nname = "A"\n\n  [[layout.panes]]\n', 4, 'unknown table');
});

check('a key a pane does not have', () => {
  fails('[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  host = "web-01"\n', 5, 'machine, command and name');
});

check('a key a layout does not have', () => {
  fails('[[layout]]\nname = "A"\nlabel = "x"\n\n  [[layout.pane]]\n  command = "top"\n', 3, 'name and startup');
});

check('a line that is neither a key nor a table', () => {
  fails('[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  command\n', 5, 'not a key');
});

check('a layout with no name', () => {
  // Reported against the whole file (line 0): the name is missing, so there is no
  // line it is missing from.
  fails('[[layout]]\n\n  [[layout.pane]]\n  command = "top"\n', 0, 'no name');
});

check('a layout with no pane', () => {
  fails('[[layout]]\nname = "Empty"\n', 0, 'no [[layout.pane]]');
});

console.log('\nwhat a pane is called:');

check('its own name wins, then the machine, then the command', () => {
  assert.equal(paneLabel({ name: 'Logs', machine: 'web-01', command: 'top' }), 'Logs');
  assert.equal(paneLabel({ machine: 'web-01', command: 'top' }), 'web-01');
  assert.equal(paneLabel({ command: 'journalctl -fu app' }), 'journalctl');
  assert.equal(paneLabel({ command: '' }), '');
});

console.log('\nwriting it back out:');

check('what is written parses to what was written', () => {
  // The round trip is what the release-candidate carry-over relies on: layouts read
  // out of the old per-device store are turned into a file and must come back.
  const layouts = [
    { id: 'x', name: 'Morning', startup: true, panes: [{ command: '' }, { machine: 'web-01', command: 'top', name: 'load' }] },
  ];
  const { layouts: back, error } = parseLayoutFile(formatLayoutFile(layouts));
  assert.equal(error, null);
  assert.equal(back.length, 1);
  assert.equal(back[0].name, 'Morning');
  assert.equal(back[0].startup, true);
  assert.deepEqual(
    back[0].panes.map((p) => [p.machine ?? null, p.command, p.name ?? null]),
    [
      [null, '', null],
      ['web-01', 'top', 'load'],
    ],
  );
});

check('a quote in a name survives the round trip', () => {
  const layouts = [{ id: 'x', name: 'the "big" one', startup: false, panes: [{ command: 'echo hi' }] }];
  const text = formatLayoutFile(layouts);
  const { layouts: back, error } = parseLayoutFile(text);
  assert.equal(error, null, `${text} should parse`);
  assert.equal(back[0].name, 'the "big" one');
});

console.log(`\n${passed} checks passed`);
