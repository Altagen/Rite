/**
 * Which support a window reads its layouts from, as a table (ADR 0027).
 *
 * Three parties answer and the order matters: the instance can refuse outright, the reader
 * can decline, and only then does this machine's preference pick a support. Each of the
 * three was a sentence in the ADR and a branch in the code, and the branch is the one that
 * drifts — a browser must never be told to read a file it has no way to open, and a local
 * vault must never be offered a choice it cannot make.
 *
 * Run: node e2e/layouts-source-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layoutsVerdict, layoutsBlockedReason } from '../apps/desktop/src/utils/layoutsPolicy.ts';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const vault = { accounts: false };
const server = (policy) => ({ accounts: true, layoutsPolicy: policy });
const both = { webui: true, clients: true };

/** [what it is, inputs, expected verdict] */
const ROWS = [
  // A local vault: one support, no instance, no choice. The machine's preference is set
  // either way — a desktop that once signed into a server still has it written down — and
  // must not be consulted here, or a vault would read a blob that cannot exist.
  [
    'vault, desktop',
    { mode: vault, userWants: true, prefer: 'account', native: true },
    { allowed: true, support: 'file' },
  ],
  [
    'vault, desktop, prefers file',
    { mode: vault, userWants: true, prefer: 'file', native: true },
    { allowed: true, support: 'file' },
  ],
  [
    'vault, reader said no',
    { mode: vault, userWants: false, prefer: 'file', native: true },
    { allowed: false, by: 'you' },
  ],

  // Before the mode loads nothing is governed yet. Reading null as a server would hide the
  // feature for the first paint of every launch.
  [
    'mode not loaded',
    { mode: null, userWants: true, prefer: 'account', native: true },
    { allowed: true, support: 'file' },
  ],

  // A browser on a server: no filesystem, so the account or nothing. The preference is
  // ignored, including when it says `file`.
  [
    'web, default',
    { mode: server(both), userWants: true, prefer: 'account', native: false },
    { allowed: true, support: 'account' },
  ],
  [
    'web, prefers file',
    { mode: server(both), userWants: true, prefer: 'file', native: false },
    { allowed: true, support: 'account' },
  ],

  // A desktop window on a server has both, and this is the only row where gate 3 decides.
  [
    'desktop on server, default',
    { mode: server(both), userWants: true, prefer: 'account', native: true },
    { allowed: true, support: 'account' },
  ],
  [
    'desktop on server, prefers file',
    { mode: server(both), userWants: true, prefer: 'file', native: true },
    { allowed: true, support: 'file' },
  ],

  // The instance refuses one shell at a time, and the other keeps working.
  [
    'webui off, in a browser',
    {
      mode: server({ webui: false, clients: true }),
      userWants: true,
      prefer: 'account',
      native: false,
    },
    { allowed: false, by: 'server', shell: 'webui' },
  ],
  [
    'webui off, in the desktop',
    {
      mode: server({ webui: false, clients: true }),
      userWants: true,
      prefer: 'account',
      native: true,
    },
    { allowed: true, support: 'account' },
  ],
  [
    'clients off, in the desktop',
    {
      mode: server({ webui: true, clients: false }),
      userWants: true,
      prefer: 'file',
      native: true,
    },
    { allowed: false, by: 'server', shell: 'clients' },
  ],
  [
    'clients off, in a browser',
    {
      mode: server({ webui: true, clients: false }),
      userWants: true,
      prefer: 'account',
      native: false,
    },
    { allowed: true, support: 'account' },
  ],

  // Both false is the feature off, in both shells. No third `enabled` flag to disagree.
  [
    'both off, browser',
    {
      mode: server({ webui: false, clients: false }),
      userWants: true,
      prefer: 'account',
      native: false,
    },
    { allowed: false, by: 'server', shell: 'webui' },
  ],
  [
    'both off, desktop',
    {
      mode: server({ webui: false, clients: false }),
      userWants: true,
      prefer: 'file',
      native: true,
    },
    { allowed: false, by: 'server', shell: 'clients' },
  ],

  // An older server has no policy at all. Silence is not a refusal.
  [
    'server says nothing',
    { mode: server(undefined), userWants: true, prefer: 'account', native: false },
    { allowed: true, support: 'account' },
  ],

  // The instance outranks the reader: a refusal must name the server, because the switch in
  // Settings would do nothing and saying "off in settings" would send them to it.
  [
    'server refuses, reader also off',
    {
      mode: server({ webui: false, clients: true }),
      userWants: false,
      prefer: 'account',
      native: false,
    },
    { allowed: false, by: 'server', shell: 'webui' },
  ],
];

console.log('the support a window reads from, row for row:');
for (const [name, input, expected] of ROWS) {
  check(name, () => assert.deepEqual(layoutsVerdict(input), expected));
}

console.log('\nand why it is not there:');
check('each refusal has its own sentence', () => {
  const keys = [
    layoutsBlockedReason({ allowed: false, by: 'you' }),
    layoutsBlockedReason({ allowed: false, by: 'server', shell: 'webui' }),
    layoutsBlockedReason({ allowed: false, by: 'server', shell: 'clients' }),
  ];
  assert.deepEqual(keys, ['layouts.offYou', 'layouts.offWebui', 'layouts.offClients']);
  assert.equal(new Set(keys).size, 3, 'three refusals, three keys');
});

check('and an allowed verdict explains nothing', () => {
  assert.equal(layoutsBlockedReason({ allowed: true, support: 'file' }), null);
});

check('every key it can return exists in both locales', () => {
  const locale = (name) =>
    JSON.parse(
      readFileSync(
        new URL(`../apps/desktop/src/i18n/locales/${name}.json`, import.meta.url),
        'utf8',
      ),
    );
  const en = locale('en');
  const fr = locale('fr');
  for (const key of [
    'offYou',
    'offWebui',
    'offClients',
    'use',
    'useHint',
    'source',
    'sourceAccount',
    'sourceFile',
    'onAccount',
    'onFile',
    'lastWriteWins',
  ]) {
    assert.ok(en.layouts[key], `en is missing layouts.${key}`);
    assert.ok(fr.layouts[key], `fr is missing layouts.${key}`);
  }
});

console.log(`\n${passed} checks passed`);
