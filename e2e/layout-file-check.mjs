/**
 * The workspace file, held to its format.
 *
 * Presets and layouts are a file now (docs/LAYOUTS.md, ADR 0023), which means the
 * parser is the feature: every pane that opens, every machine that is named, every
 * cut of the screen and every refusal the user reads comes out of it.
 * `store/layoutsFormat.ts` imports nothing, so Node's type stripping loads the real
 * module — these checks run against the parser the app ships, not against a copy.
 *
 * The arrangement is checked by BUILDING it: the plan goes through the shipped
 * `paneTree`, and the resulting tree is painted onto a character grid and compared to
 * the picture in the documentation. An assertion about steps would pass while the
 * screen was wrong; a picture cannot.
 *
 * What is pinned here is mostly the refusals, because they are what a user hits on
 * a Tuesday: the file came from another computer, a value lost its quotes, a table
 * got misspelt. A parser that accepts half of that silently is worse than one that
 * refuses all of it loudly.
 *
 * Run: node e2e/layout-file-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseLayoutFile,
  formatLayoutFile,
  replacePresetBlocks,
  setLayoutStartup,
  planLayout,
  paneLabel,
} from '../apps/desktop/src/store/layoutsFormat.ts';
import { createTerminalPane, splitPane, getAllPanes } from '../apps/desktop/src/utils/paneTree.ts';

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
  // `terminal: {}` and not an absent field: the section is always present and its keys are
  // what is absent, so a reader never has to ask whether the document had the table
  // before asking what it said (ADR 0023, addendum).
  const fresh = { presets: [], layouts: [], terminal: {}, error: null };
  assert.deepEqual(parseLayoutFile(''), fresh);
  assert.deepEqual(parseLayoutFile('   \n\n'), fresh);
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
  fails('[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  host = "web-01"\n', 5, 'not host');
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

console.log('\nthe presets in the same file:');

check('a preset is a name and a command', () => {
  const { presets, error } = parseLayoutFile('[[preset]]\nname = "Logs"\ncommand = "journalctl -fu app"\n');
  assert.equal(error, null);
  assert.deepEqual(
    presets.map((p) => [p.name, p.command]),
    [['Logs', 'journalctl -fu app']],
  );
});

check('a pane may cite a preset instead of repeating the command', () => {
  const { layouts, error } = parseLayoutFile(
    '[[preset]]\nname = "Logs"\ncommand = "journalctl -fu app"\n\n' +
      '[[layout]]\nname = "M"\n\n  [[layout.pane]]\n  machine = "web-01"\n  preset = "Logs"\n',
  );
  assert.equal(error, null);
  assert.equal(layouts[0].panes[0].command, 'journalctl -fu app');
  assert.equal(layouts[0].panes[0].machine, 'web-01');
});

check('a preset may be declared after the layout that cites it', () => {
  // The whole file is read before the citations are resolved, so the order people
  // write their file in is their business.
  const { layouts, error } = parseLayoutFile(
    '[[layout]]\nname = "M"\n\n  [[layout.pane]]\n  preset = "Logs"\n\n' +
      '[[preset]]\nname = "Logs"\ncommand = "top"\n',
  );
  assert.equal(error, null);
  assert.equal(layouts[0].panes[0].command, 'top');
});

check('a preset nobody declared names its line', () => {
  fails(
    '[[layout]]\nname = "M"\n\n  [[layout.pane]]\n  preset = "Nope"\n',
    5,
    'no [[preset]] is named "Nope"',
  );
});

check('a pane takes a preset or a command, not both', () => {
  // Two sources for one pane's command is how they end up disagreeing.
  fails(
    '[[preset]]\nname = "Logs"\ncommand = "top"\n\n' +
      '[[layout]]\nname = "M"\n\n  [[layout.pane]]\n  preset = "Logs"\n  command = "df -h"\n',
    10,
    'not both',
  );
});

check('a key a preset does not have', () => {
  fails('[[preset]]\nname = "A"\nmachine = "web-01"\n', 3, 'name and command');
});

console.log('\nwhere each pane goes:');

/** Build the tab the way the workspace does, then paint it as the renderer would. */
const render = (layout, w = 32, h = 12) =>
  planLayout(layout).map((plan) => {
    const session = (i) => ({ id: `s${i}`, connectionId: 'c', connectionName: String(i + 1) });
    let tree = createTerminalPane(session(0), true);
    const ids = new Map([[0, tree.id]]);
    for (const step of plan.steps) {
      const anchor = ids.get(step.anchor);
      assert.ok(anchor, `step ${step.pane} has no anchor to cut`);
      tree = splitPane(tree, anchor, step.direction, session(step.pane), {
        before: step.before,
        ratio: step.ratio,
      });
      const added = getAllPanes(tree).find((pane) => pane.session.id === `s${step.pane}`);
      assert.ok(added, `pane ${step.pane} is not in the tree`);
      ids.set(step.pane, added.id);
    }
    const grid = Array.from({ length: h }, () => Array(w).fill('.'));
    const paint = (node, x, y, pw, ph) => {
      if (node.type !== 'split') {
        for (let r = y; r < y + ph; r++) for (let c = x; c < x + pw; c++) grid[r][c] = node.session.connectionName;
        return;
      }
      if (node.direction === 'horizontal') {
        const first = Math.round(pw * node.ratio);
        paint(node.children[0], x, y, first, ph);
        paint(node.children[1], x + first, y, pw - first, ph);
      } else {
        const first = Math.round(ph * node.ratio);
        paint(node.children[0], x, y, pw, first);
        paint(node.children[1], x, y + first, pw, ph - first);
      }
    };
    paint(tree, 0, 0, w, h);
    return { tab: plan.tab, picture: grid.map((r) => r.join('')).join('\n') };
  });

const bare = (count, w = 12, h = 4) => {
  const panes = Array.from({ length: count }, (_, i) => `  [[layout.pane]]\n  command = "c${i}"`).join('\n\n');
  const { layouts, error } = parseLayoutFile(`[[layout]]\nname = "G"\n\n${panes}\n`);
  assert.equal(error, null, JSON.stringify(error));
  return render(layouts[0], w, h)[0].picture;
};

check('two bare panes sit side by side', () => {
  assert.equal(bare(2), ['111111222222', '111111222222', '111111222222', '111111222222'].join('\n'));
});

check('four bare panes make a 2×2 grid, in reading order', () => {
  // The promise in ADR 0023 §4, and the one thing a file is allowed to leave unsaid.
  assert.equal(bare(4), ['111111222222', '111111222222', '333333444444', '333333444444'].join('\n'));
});

check('eight bare panes make 4×2, because wider is better for a terminal', () => {
  assert.equal(
    bare(8),
    ['111222333444', '111222333444', '555666777888', '555666777888'].join('\n'),
  );
});

check('nine bare panes make three EQUAL rows, not 50/25/25', () => {
  // Each cut takes its share of what is left — 1/3, then 1/2 of the remainder.
  // Halving every time is the mistake that looks right with two rows and wrong with
  // three, which is why this case exists and why it is nine panes.
  assert.equal(
    bare(9, 9, 6),
    ['111222333', '111222333', '444555666', '444555666', '777888999', '777888999'].join('\n'),
  );
});

check('the eight-pane arrangement in the documentation is the one you get', () => {
  // The acceptance test of ADR 0023 §8.1. The file is read out of docs/LAYOUTS.md
  // itself, so an example that drifts from the parser fails here rather than in
  // somebody's morning.
  const doc = readFileSync(new URL('../docs/LAYOUTS.md', import.meta.url), 'utf8');
  const block = doc
    .split('```toml')
    .slice(1)
    .map((b) => b.split('```')[0])
    .find((b) => b.includes('Warroom'));
  assert.ok(block, 'docs/LAYOUTS.md no longer carries the Warroom example');
  const { layouts, error } = parseLayoutFile(
    '[[preset]]\nname = "Logs"\ncommand = "journalctl -fu app"\n' + block,
  );
  assert.equal(error, null, JSON.stringify(error));
  const [{ picture }] = render(layouts[0]);
  // Pane numbers are the file's order: 1 web-01, 2 db-01/psql, 3 web-02, 4 uptime,
  // 5 web-03, 6 top, 7 df, 8 free.
  assert.equal(
    picture,
    [
      '11111111111111112222222222222222',
      '11111111111111112222222222222222',
      '11111111111111112222222222222222',
      '11111111111111112222222222222222',
      '33333333555555556666666666666666',
      '33333333555555556666666666666666',
      '33333333555555556666666666666666',
      '33333333555555556666666666666666',
      '44444444444444447777777788888888',
      '44444444444444447777777788888888',
      '44444444444444447777777788888888',
      '44444444444444447777777788888888',
    ].join('\n'),
  );
});

check('size is a share of what is cut, and left and up put the pane first', () => {
  const { layouts, error } = parseLayoutFile(
    '[[layout]]\nname = "S"\n\n  [[layout.pane]]\n  command = "a"\n\n' +
      '  [[layout.pane]]\n  command = "b"\n  split = "left"\n  size = "25%"\n',
  );
  assert.equal(error, null, JSON.stringify(error));
  // "left" puts the new pane on the left, and 25% is ITS share — not the other one's.
  assert.equal(render(layouts[0], 8, 2)[0].picture, ['22111111', '22111111'].join('\n'));
});

check('tabs are their own arrangements', () => {
  const { layouts, error } = parseLayoutFile(
    '[[layout]]\nname = "Two"\n\n' +
      '  [[layout.pane]]\n  tab = "Prod"\n  command = "a"\n\n' +
      '  [[layout.pane]]\n  command = "b"\n  split = "down"\n\n' +
      '  [[layout.pane]]\n  tab = "Local"\n  command = "c"\n',
  );
  assert.equal(error, null, JSON.stringify(error));
  const tabs = render(layouts[0], 4, 2);
  assert.deepEqual(
    tabs.map((x) => x.tab),
    ['Prod', 'Local'],
  );
  // The second pane follows the first into Prod; the third opens a tab of its own.
  assert.equal(tabs[0].picture, ['1111', '2222'].join('\n'));
  assert.equal(tabs[1].picture, ['1111', '1111'].join('\n'));
});

console.log('\narrangements a file may not ask for:');

check('a split that is not one of the four words', () => {
  fails(
    '[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  command = "a"\n\n  [[layout.pane]]\n  split = "sideways"\n',
    8,
    'right, down, left or up',
  );
});

check('a size outside what the screen can honour', () => {
  for (const [value, line] of [['5%', 8], ['95%', 8], ['half', 8]]) {
    fails(
      '[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  command = "a"\n\n  [[layout.pane]]\n  size = "' +
        value +
        '"\n',
      line,
      'between 10% and 90%',
    );
  }
});

check('an unquoted percentage says how to write it', () => {
  // The mistake this TOML subset invites, so it gets its own sentence.
  fails(
    '[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  command = "a"\n\n  [[layout.pane]]\n  size = 45\n',
    8,
    'size = "45%"',
  );
});

check('an anchor that names no pane placed before it', () => {
  fails(
    '[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  command = "a"\n  name = "one"\n\n' +
      '  [[layout.pane]]\n  split = "right"\n  of = "two"\n',
    10,
    'no pane placed before this one',
  );
});

check('an anchor in another tab says so, rather than "no such pane"', () => {
  fails(
    '[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  tab = "One"\n  command = "a"\n  name = "left"\n\n' +
      '  [[layout.pane]]\n  tab = "Two"\n  command = "b"\n\n' +
      '  [[layout.pane]]\n  split = "right"\n  of = "left"\n',
    15,
    'in another tab',
  );
});

check('two panes of one layout may not share a name', () => {
  fails(
    '[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  command = "a"\n  name = "same"\n\n' +
      '  [[layout.pane]]\n  command = "b"\n  name = "same"\n',
    10,
    'could not tell them apart',
  );
});

check('the first pane of a tab is the whole area', () => {
  for (const [key, value] of [['split', '"right"'], ['of', '"x"'], ['size', '"40%"']]) {
    fails(
      `[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  command = "a"\n  ${key} = ${value}\n`,
      6,
      'the whole area',
    );
  }
});

console.log('\nediting the presets without rewriting the file:');

const spliced = (text, presets) => {
  const out = replacePresetBlocks(text, presets);
  const parse = parseLayoutFile(out);
  assert.equal(parse.error, null, `${JSON.stringify(parse.error)}\n${out}`);
  return { out, parse };
};

check('the layouts, the comments and the blank lines survive an edit', () => {
  const { out, parse } = spliced(
    '# my file\n\n[[preset]]\nname = "Old"\ncommand = "ls"\n\n[[layout]]\nname = "Morning"\n\n' +
      '  [[layout.pane]]\n  command = "top"   # keep me\n',
    [{ id: 'a', name: 'Load', command: 'top' }],
  );
  assert.ok(out.startsWith('# my file'), out);
  assert.ok(out.includes('# keep me'), out);
  assert.ok(!out.includes('"Old"'), out);
  assert.deepEqual(parse.presets.map((p) => p.name), ['Load']);
  assert.deepEqual(parse.layouts.map((l) => l.name), ['Morning']);
});

check('a preset block followed straight by a layout does not swallow it', () => {
  // The off-by-one that a less careful splice makes: the block ends at the next
  // table, and the next table must survive it.
  const { parse } = spliced('[[preset]]\n[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  command = "x"\n', [
    { id: 'a', name: 'Load', command: 'top' },
  ]);
  assert.equal(parse.layouts.length, 1);
  assert.equal(parse.presets.length, 1);
});

check('a file with no presets yet gets them before its first table', () => {
  const { parse } = spliced('# header\n\n[[layout]]\nname = "M"\n\n  [[layout.pane]]\n  command = ""\n', [
    { id: 'a', name: 'Load', command: 'top' },
  ]);
  assert.equal(parse.presets.length, 1);
  assert.equal(parse.layouts.length, 1);
});

check('an empty file and a comments-only file both take the presets', () => {
  for (const input of ['', '# only comments\n']) {
    const { parse } = spliced(input, [{ id: 'a', name: 'Load', command: 'top' }]);
    assert.deepEqual(parse.presets.map((p) => p.name), ['Load']);
  }
});

check('removing every preset leaves the layouts alone', () => {
  const { parse } = spliced(
    '[[preset]]\nname = "Load"\ncommand = "top"\n\n[[layout]]\nname = "M"\n\n  [[layout.pane]]\n  command = ""\n',
    [],
  );
  assert.equal(parse.presets.length, 0);
  assert.equal(parse.layouts.length, 1);
});

check('two scattered preset blocks collapse into one library', () => {
  const { parse } = spliced(
    '[[preset]]\nname = "A"\ncommand = "a"\n\n[[layout]]\nname = "M"\n\n  [[layout.pane]]\n  command = ""\n\n' +
      '[[preset]]\nname = "B"\ncommand = "b"\n',
    [
      { id: '1', name: 'A', command: 'a' },
      { id: '2', name: 'B', command: 'b' },
    ],
  );
  assert.deepEqual(parse.presets.map((p) => p.name), ['A', 'B']);
  assert.equal(parse.layouts.length, 1);
});

console.log('\nthe startup switch, spliced into the file:');

// The file the toggle will actually meet: comments, blank lines, indentation, and a
// layout that already declares the key.
const WITH_STARTUP = `# my workspace
[[preset]]
name = "Load"
command = "top"

[[layout]]
name = "Morning"
startup = true

  [[layout.pane]]
  command = "uptime"

[[layout]]
name = "Warroom"   # the big one

  [[layout.pane]]
  command = "top"
`;

check('turning it on adds the key under name', () => {
  const out = setLayoutStartup(WITH_STARTUP, 1, true);
  assert.match(out, /name = "Warroom".*\nstartup = true\n/);
  const parse = parseLayoutFile(out);
  assert.equal(parse.error, null, JSON.stringify(parse.error));
  assert.deepEqual(parse.layouts.map((l) => l.startup), [true, true]);
});

check('turning it off removes the key rather than writing false', () => {
  const out = setLayoutStartup(WITH_STARTUP, 0, false);
  assert.ok(!out.includes('startup'), 'the key should be gone, not set to false');
  assert.deepEqual(parseLayoutFile(out).layouts.map((l) => l.startup), [false, false]);
});

check('turning it on when it is already on changes nothing that matters', () => {
  const out = setLayoutStartup(WITH_STARTUP, 0, true);
  assert.deepEqual(parseLayoutFile(out).layouts.map((l) => l.startup), [true, false]);
});

check('turning it off when it is already off is a no-op', () => {
  assert.equal(setLayoutStartup(WITH_STARTUP, 1, false), WITH_STARTUP);
});

check('the comments, the preset and the other layout survive the edit', () => {
  const out = setLayoutStartup(WITH_STARTUP, 1, true);
  assert.ok(out.startsWith('# my workspace'), 'the preamble comment');
  assert.ok(out.includes('# the big one'), 'a trailing comment on the line above');
  assert.ok(out.includes('name = "Load"'), 'the preset block');
  assert.equal(parseLayoutFile(out).presets.length, 1);
  // Exactly one line added, and it is the one we asked for. Counted rather than
  // diffed: the file already carries one `startup = true`, so a set difference
  // reports nothing and would pass against a splicer that added no line at all.
  const lineCount = (text, want) => text.split('\n').filter((l) => l === want).length;
  assert.equal(out.split('\n').length, WITH_STARTUP.split('\n').length + 1);
  assert.equal(lineCount(WITH_STARTUP, 'startup = true'), 1);
  assert.equal(lineCount(out, 'startup = true'), 2);
});

check('it targets the position in the file, not the name', () => {
  const twins = '[[layout]]\nname = "Same"\n\n  [[layout.pane]]\n  command = "a"\n\n[[layout]]\nname = "Same"\n\n  [[layout.pane]]\n  command = "b"\n';
  const out = setLayoutStartup(twins, 1, true);
  assert.deepEqual(parseLayoutFile(out).layouts.map((l) => l.startup), [false, true]);
});

check('a layout with no name takes the key under its header', () => {
  const out = setLayoutStartup('[[layout]]\n\n  [[layout.pane]]\n  command = "a"\n', 0, true);
  assert.match(out, /^\[\[layout\]\]\nstartup = true\n/);
});

check('an index no layout occupies leaves the file alone', () => {
  assert.equal(setLayoutStartup(WITH_STARTUP, 7, true), WITH_STARTUP);
  assert.equal(setLayoutStartup(WITH_STARTUP, -1, true), WITH_STARTUP);
});

check('a key after the first pane is not mistaken for the layout own key', () => {
  // `startup` is a layout key; a pane cannot carry it, so the scan must stop at the
  // first [[layout.pane]]. If it did not, this would edit the pane's line.
  const sneaky = '[[layout]]\nname = "A"\n\n  [[layout.pane]]\n  command = "a"\n  startup = true\n';
  const out = setLayoutStartup(sneaky, 0, true);
  assert.match(out, /name = "A"\nstartup = true/);
  assert.ok(out.includes('  startup = true'), 'the pane line is left exactly as it was');
});

check('indentation follows the line the key is written under', () => {
  const indented = '[[layout]]\n  name = "A"\n\n  [[layout.pane]]\n  command = "a"\n';
  assert.ok(setLayoutStartup(indented, 0, true).includes('\n  startup = true'));
});

check('an empty file is not a crash', () => {
  assert.equal(setLayoutStartup('', 0, true), '');
  assert.equal(setLayoutStartup(null, 0, true), '');
});

console.log(`\n${passed} checks passed`);
