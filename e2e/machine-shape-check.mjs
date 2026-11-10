/**
 * THE CLIENT'S SCHEMA DECLARES EVERY FIELD THE CORE SENDS.
 *
 * Zod strips what it does not declare, silently and on every read. `ConnectionInfoSchema`
 * had no `labels`, so a machine's labels were sealed correctly, stored correctly,
 * returned correctly by the route — and removed on the way into the client, every time.
 *
 * NOTHING COULD SEE IT. `machine-labels.spec.ts` asserts against the ROUTE and passed
 * throughout. The screens that use the field — the chips on a card, the library's search,
 * the collection's `Label ▾` filter, the picker's offers — all read an empty list, which
 * on screen reads as "nothing is labelled" rather than as a defect. It was found because
 * a picker offered no words for a machine that visibly had one.
 *
 * `e2e/vocab-parity-check.mjs` exists for exactly this family and did not catch it: it
 * covers the shape of a WORD and this is the shape of a MACHINE. A guard whose reach is
 * narrower than the class it names is worse than none, because it is believed.
 *
 * THE WIRE RESHAPES THREE FIELDS ON PURPOSE and they are named below rather than guessed
 * at: `auth_method` is an enum in the core and arrives as `authType` plus the parts of it
 * that are not secret (ADR 0024 §6). Everything else must appear verbatim, camelCased.
 *
 * Run: node e2e/machine-shape-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

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

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** Every `pub <field>:` in a Rust struct, as the wire spells it. */
function rustFields(file, struct) {
  const text = read(file);
  const at = text.indexOf(`pub struct ${struct} {`);
  assert.ok(at > 0, `${struct} is gone from ${file}`);
  const body = text.slice(at, text.indexOf('\n}', at));
  return [...body.matchAll(/^\s*pub (\w+):/gm)].map((m) => camel(m[1]));
}

/** Every key a Zod object declares, including the ones an `.extend()` adds. */
function zodFields(file, ...names) {
  const text = read(file);
  const out = new Set();
  for (const name of names) {
    const at = text.indexOf(`const ${name} = `);
    assert.ok(at > 0, `${name} is gone from ${file}`);
    const body = text.slice(at, text.indexOf('\n});', at));
    // `z\` and not `z.\`: a long field is written `forwards: z` with the `.array(` on
    // the next line, and a parser that demanded the dot reported it as missing — which
    // is this check inventing the very defect it looks for.
    for (const m of body.matchAll(/^\s{2}(\w+):\s*z\b/gm)) out.add(m[1]);
  }
  return out;
}

/**
 * Fields the core sends that the client deliberately does not take under that name.
 *
 * One entry, and it is a reshape rather than an omission: the core's `AuthMethod` is an
 * enum carrying secrets, and the wire sends the parts that are not secret as their own
 * fields. A second entry here should be argued, not added.
 */
const RESHAPED = new Map([
  ['authMethod', 'arrives as authType + keyPath + hasStoredPassphrase/Password (ADR 0024 §6)'],
]);

console.log('\na machine, from the core to the client:');

const core = rustFields('packages/rite-core/src/local_collections.rs', 'MachineRecord');
const client = zodFields(
  'apps/desktop/src/utils/backend.ts',
  'ConnectionInfoSchema',
  'LocalMachineSchema',
);

check('the core still has the fields this check reads', () => {
  assert.ok(core.length > 10, `only ${core.length} fields parsed`);
  assert.ok(core.includes('labels'), 'labels is gone from MachineRecord');
});

check('EVERY FIELD THE CORE SENDS IS DECLARED BY THE CLIENT', () => {
  const missing = core.filter((f) => !client.has(f) && !RESHAPED.has(f));
  assert.deepEqual(missing, [], `Zod will strip these on every read: ${missing.join(', ')}`);
});

check('and a reshaped field is named rather than quietly absent', () => {
  const stale = [...RESHAPED.keys()].filter((f) => !core.includes(f) || client.has(f));
  assert.deepEqual(
    stale,
    [],
    `no longer reshaped, so the exception is misinformation: ${stale.join(', ')}`,
  );
});

if (failed) {
  console.log(`\n${failed} failed\n`);
  process.exit(1);
}
console.log(`\n${core.length} fields on the wire, all declared\nall ok\n`);
