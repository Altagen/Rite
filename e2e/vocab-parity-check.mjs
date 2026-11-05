/**
 * EVERY CARRIER OF A VOCABULARY WORD NAMES THE SAME FIELDS.
 *
 * The defect this exists for: the stored shape of a declared word was written inline in
 * ten places, and one of them — the Zod schema on the wire — never learned
 * `description`. Zod STRIPS what it does not declare, so a description was typed, sent,
 * stored, read back, and removed on the way into the page, in silence. Nothing failed.
 * No type error could: an object with one field fewer satisfies a schema that asks for
 * one field fewer.
 *
 * WHY NOT A ROUND-TRIP TEST. There is one, and it passed throughout. A round trip can
 * only exercise the fields the fixture happens to carry, so it proves the shape it was
 * written against and says nothing about the field added afterwards. This reads the
 * DECLARATIONS instead, which is where the omission actually lives.
 *
 * WHY A TEXT SCAN. The four carriers are in three languages — a TypeScript interface, a
 * Zod schema, a Rust struct and a Rust constructor — and the only thing that can compare
 * them is something that reads all four as text. The Rust and the browser round-trips are
 * held separately, by `header_matches_the_browser` in `local_collections.rs`.
 *
 * AND THE LIST OF CARRIERS CANNOT GROW BEHIND THIS CHECK'S BACK: the sweep at the end
 * fails on any file that names a vocabulary word's fields without being listed here.
 *
 * Run: node e2e/vocab-parity-check.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/** The fields a vocabulary word has. Change this, and every carrier below must agree. */
const FIELDS = ['label', 'color', 'description'];

/**
 * Where the shape is written down.
 *
 * `region` isolates the block that names the fields, so an unrelated `color` elsewhere in
 * a four-thousand-line file is not counted; `fields` pulls the names out of it.
 */
const CARRIERS = [
  {
    file: 'apps/desktop/src/store/labelsFormat.ts',
    what: 'the TypeScript interface the whole frontend builds on',
    region: /export interface VocabWord \{[\s\S]*?\n\}/,
    fields: (text) => [...text.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]),
  },
  {
    file: 'apps/desktop/src/utils/backend.ts',
    what: 'the Zod schema on the wire — the one that silently stripped a field',
    region: /const VocabEntrySchema = z\.union\(\[[\s\S]*?\n\]\);/,
    fields: (text) => [...text.matchAll(/^\s{4}(\w+): z\./gm)].map((m) => m[1]),
  },
  {
    file: 'packages/rite-core/src/local_collections.rs',
    what: 'the struct the core seals into a collection header',
    region: /pub struct VocabWord \{[\s\S]*?\n\}/,
    fields: (text) => [...text.matchAll(/^\s{4}pub (\w+):/gm)].map((m) => m[1]),
  },
  {
    file: 'packages/rite-server/src/lib.rs',
    what: 'what the server writes back after cleaning — a field missing here is dropped',
    region: /fn accepted_vocabulary\([\s\S]*?\n\}/,
    fields: (text) => {
      const built = text.match(/VocabWord \{\n([\s\S]*?)\n\s*\}\)/);
      if (!built) return [];
      return built[1]
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
    },
  },
  {
    file: 'apps/desktop/src/components/LabelManager.tsx',
    what: 'the editor — a field it cannot write is a field nobody can set',
    // The row's Save builds the word; whatever it names there is what a person can set.
    region: /onDone\(\{\n[\s\S]*?\n\s+\}\)/,
    fields: (text) =>
      [...text.matchAll(/\b(label|color|description)\b(?=\s*[,:}])/g)].map((m) => m[1]),
  },
];

let failed = 0;
const fail = (line) => {
  console.log(`  FAIL  ${line}`);
  failed++;
};

console.log('\nthe fields of a declared word, carrier by carrier:');
const listed = new Set(CARRIERS.map((c) => c.file));
for (const carrier of CARRIERS) {
  const whole = read(carrier.file);
  const block = whole.match(carrier.region);
  if (!block) {
    fail(`${carrier.file}  the region this check reads is gone — ${carrier.what}`);
    continue;
  }
  const found = [...new Set(carrier.fields(block[0]))].sort();
  const want = [...FIELDS].sort();
  if (found.join(',') !== want.join(',')) {
    fail(`${carrier.file}  names ${found.join(', ') || '(nothing)'} — expected ${want.join(', ')}`);
    console.log(`        ${carrier.what}`);
  } else {
    console.log(`  ok  ${relative('.', carrier.file)}`);
  }
}

// A sixth carrier must not appear unlisted. A file that names a vocabulary word AND one of
// its fields is writing the shape down, whether or not anybody meant it to.
const scanned = [];
(function walk(dir) {
  for (const entry of readdirSync(join(root, dir))) {
    const p = join(dir, entry);
    if (entry === 'target' || entry === 'node_modules' || entry === 'dist') continue;
    if (statSync(join(root, p)).isDirectory()) walk(p);
    else if (/\.(ts|tsx|rs)$/.test(entry)) scanned.push(p);
  }
})('apps/desktop/src');
(function walk(dir) {
  for (const entry of readdirSync(join(root, dir))) {
    const p = join(dir, entry);
    if (entry === 'target' || entry === 'node_modules') continue;
    if (statSync(join(root, p)).isDirectory()) walk(p);
    else if (/\.rs$/.test(entry)) scanned.push(p);
  }
})('packages');

for (const file of scanned) {
  if (listed.has(file)) continue;
  const text = read(file);
  if (!/\bVocabWord\b|\bVocabEntry\b/.test(text)) continue;
  if (!/\bdescription\b/.test(text)) continue;
  fail(
    `${file} names a word's fields and is not a listed carrier — add it or pass the shape whole`,
  );
}

if (failed) {
  console.log(`\n${failed} failed\n`);
  process.exit(1);
}
console.log(`\n${CARRIERS.length} carriers agree on ${FIELDS.join(', ')}\nall ok\n`);
