/**
 * MAY THIS CLIENT RUN THE DASHBOARD'S PROBES? ADR 0019 §5, walked row by row.
 *
 * Two parties answer and the most restrictive one wins: the instance may refuse, and the
 * reader may decline. A "yes" from either is only ever a permission — never an
 * instruction — so it takes both to let a request leave and either one to stop it. And a
 * refusal has to say WHOSE it was, because the three of them are three different things
 * to do next: in a browser nobody can undo it, on a client the server asked and this
 * client agreed, and the reader's own switch is one click away.
 *
 * WHY A TABLE AND NOT A DASHBOARD. The rule is a pure function of three inputs, and the
 * part that drifts is the precedence between them: a `||` where an `&&` belongs reads the
 * same and reverses the answer for the four rows where the two parties disagree. Those
 * four are the point of this file. The server's half of the same ADR is
 * `e2e/dashboard-policy-check.mjs` (a real instance, refusing a real request), and the
 * user's half is `e2e/tests/dashboard-probe-gate.spec.ts` (the switch, in the UI).
 *
 * This table used to live in `design/mock/`, asked of a drawing of the dashboard. It is
 * asked of the shipped function here — which is also why `probeVerdict` takes `native`
 * rather than detecting the shell: the module imports nothing at runtime, so Node's type
 * stripping loads the real thing instead of a copy of it.
 *
 * Run: node e2e/dashboard-verdict-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { probeVerdict, probeBlockedReason } from '../apps/desktop/src/utils/dashboardProbes.ts';

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
const server = (policy) => ({ accounts: true, dashboardPolicy: policy });
const both = { webui: true, clients: true };

const RUN = { allowed: true };
const BY_YOU = { allowed: false, by: 'you' };
const BY_SERVER = (shell) => ({ allowed: false, by: 'server', shell });

/** [what it is, inputs, the verdict ADR 0019 §5 gives it] */
const ROWS = [
  // A LOCAL VAULT HAS NO AUTHORITY TO CONSULT: the user's vault, network and machines.
  // The policy is set here on purpose — a desktop that once signed into a server still
  // holds one — and must not be read, or an instance would be governing a vault it has
  // never seen.
  ['a vault, the reader says yes', { mode: vault, userWants: true, native: true }, RUN],
  [
    'a vault, with a policy that refuses both shells',
    {
      mode: { ...vault, dashboardPolicy: { webui: false, clients: false } },
      userWants: true,
      native: true,
    },
    RUN,
  ],
  ['a vault, the reader says no', { mode: vault, userWants: false, native: true }, BY_YOU],

  // A DESKTOP SIGNED INTO AN INSTANCE: `clients` is the key that answers, and the
  // reader's switch still applies on top of it.
  ['a client, both say yes', { mode: server(both), userWants: true, native: true }, RUN],
  [
    'a client the instance refuses',
    { mode: server({ webui: true, clients: false }), userWants: true, native: true },
    BY_SERVER('clients'),
  ],
  [
    'a client the instance refuses, and the reader too — the instance is named first',
    { mode: server({ webui: true, clients: false }), userWants: false, native: true },
    BY_SERVER('clients'),
  ],
  ['a client the reader declines', { mode: server(both), userWants: false, native: true }, BY_YOU],

  // A BROWSER ON THAT INSTANCE: the other key, and the same precedence. `clients: false`
  // says nothing about a browser and must not reach it.
  ['a browser, both say yes', { mode: server(both), userWants: true, native: false }, RUN],
  [
    'a browser the instance refuses',
    { mode: server({ webui: false, clients: true }), userWants: true, native: false },
    BY_SERVER('webui'),
  ],
  [
    'a browser the instance refuses, and the reader too',
    { mode: server({ webui: false, clients: true }), userWants: false, native: false },
    BY_SERVER('webui'),
  ],
  [
    'a browser the reader declines, with the client key off',
    { mode: server({ webui: true, clients: false }), userWants: false, native: false },
    BY_YOU,
  ],
  [
    'a browser, where only the client key is off — which is not about browsers',
    { mode: server({ webui: true, clients: false }), userWants: true, native: false },
    RUN,
  ],

  // SILENCE IS NOT A REFUSAL. A server with no policy, and a mode that has not loaded
  // yet, both leave the reader's own switch as the only answer — otherwise the feature
  // would be off on every instance that never configured it.
  [
    'an instance that never configured one',
    { mode: server(undefined), userWants: true, native: true },
    RUN,
  ],
  [
    'an instance that configured one key only',
    { mode: server({ clients: true }), userWants: true, native: false },
    RUN,
  ],
  ['before the mode has loaded', { mode: null, userWants: true, native: false }, RUN],
  [
    'before the mode has loaded, reader off',
    { mode: null, userWants: false, native: true },
    BY_YOU,
  ],
];

console.log('who may run the probes, and who said no:');
for (const [what, inputs, want] of ROWS) {
  check(what, () => assert.deepEqual(probeVerdict(inputs), want));
}

console.log('\nand why they are not there:');

check('each refusal has its own sentence', () => {
  const keys = [
    probeBlockedReason(BY_YOU),
    probeBlockedReason(BY_SERVER('webui')),
    probeBlockedReason(BY_SERVER('clients')),
  ];
  assert.deepEqual(keys, ['dash.probesOffYou', 'dash.probesOffWebui', 'dash.probesOffClients']);
  assert.equal(new Set(keys).size, 3, 'three refusals, three keys');
});

check('and an allowed verdict explains nothing', () => {
  assert.equal(probeBlockedReason(RUN), null);
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
  for (const key of ['probesOffYou', 'probesOffWebui', 'probesOffClients']) {
    assert.ok(en.dash[key], `en is missing dash.${key}`);
    assert.ok(fr.dash[key], `fr is missing dash.${key}`);
  }
});

console.log(`\n${passed} checks passed`);
