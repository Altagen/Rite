/**
 * A PROP NOBODY PASSES.
 *
 * Written for a defect class rather than a defect: a component that declares an optional
 * prop no call site ever supplies is a branch that is always on its default. Sometimes
 * that is a leftover — `LabelField` carried `cap` and `onColor` for a vocabulary editor
 * that ended up being its own component, so both were dead the day they were written —
 * and sometimes it is a wire somebody forgot to connect, which is the dangerous one: the
 * component draws the affordance, the caller never enables it, and nothing fails.
 *
 * WHAT THIS IS NOT. It is not a type error: an optional prop with no caller type-checks
 * perfectly. It is not something eslint sees either, because each half is used — the
 * declaration by the component, the component by the caller. It needs both files at once,
 * which is why it is a check and not a rule.
 *
 * HOW IT READS THE TREE. Every component in this app is `function Name({ a, b }: {...})`,
 * so the destructuring pattern is the prop list. The call sites are parsed as JSX rather
 * than grepped: `<Thing compact />` passes `compact`, and a grep for `compact=` does not
 * see it. A component rendered with a spread is skipped — a prop can arrive unnamed there
 * and the question cannot be answered from the text.
 *
 * `children` is never reported: it arrives as the element's content, not as an attribute.
 *
 * THE BASELINE IS NOT AN OPINION. It is what was already in the tree the day this was
 * written. A new entry fails, and so does a baseline entry that has since been wired or
 * deleted — otherwise the list rots into a list of things nobody remembers.
 *
 * Run: node e2e/dead-props-check.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'apps/desktop/src');

/**
 * Props that were already unreached when this check was written.
 *
 * Each is a deliberate API with no caller yet, not a bug found and left: deleting someone
 * else's designed shape is a separate decision from adding a check. The point of listing
 * them is that the list cannot grow silently.
 */
const BASELINE = new Map([
  ['ConnectionError', ['detail', 'actionLabel', 'onAction']],
  ['Hub', ['onOpenLocalInPlace']],
  ['MemberPicker', ['initialColor']],
  ['SettingsToggle', ['disabled']],
  ['SplitPane', ['className']],
  ['StatusPastille', ['className']],
  ['Toast', ['duration']],
]);

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(p)) files.push(p);
  }
})(src);
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const all = [...sources.values()].join('\n');

/**
 * The attribute names on every `<Name ...>` in `text`.
 *
 * Walks to the end of the opening tag counting braces, so `cond={a > b}` is not read as
 * the end of the tag, and blanks out the braced values so an identifier inside one is not
 * read as an attribute name.
 */
function attributesPassedTo(name, text) {
  const names = new Set();
  let spread = false;
  let seen = 0;
  for (const m of text.matchAll(new RegExp(`<${name}(?=[\\s/>])`, 'g'))) {
    seen++;
    let depth = 0;
    let region = '';
    for (let i = m.index + m[0].length; i < text.length; i++) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
      region += c;
    }
    if (/\{\s*\.\.\./.test(region)) spread = true;
    let d = 0;
    let flat = '';
    for (const c of region) {
      if (c === '{') d++;
      flat += d === 0 ? c : ' ';
      if (c === '}') d--;
    }
    for (const a of flat.matchAll(/(?:^|\s)([a-zA-Z_$]\w*)(?=\s|=|\/|$)/g)) names.add(a[1]);
  }
  return { names, spread, seen };
}

const found = new Map();
let scanned = 0;
for (const [file, text] of sources) {
  for (const m of text.matchAll(/(?:export\s+)?function\s+([A-Z]\w*)\s*\(\s*\{([^}]*)\}/g)) {
    const [, name, pattern] = m;
    // A rest element can absorb anything, so the pattern is no longer the prop list.
    if (pattern.includes('...')) continue;
    const props = pattern
      .split(',')
      .map((p) => p.split(/[:=]/)[0].trim())
      .filter((p) => /^\w+$/.test(p) && p !== 'children');
    if (!props.length) continue;
    scanned++;
    const { names, spread, seen } = attributesPassedTo(name, all);
    // Never rendered at all is a different finding, and dead code eslint can see.
    if (seen === 0 || spread) continue;
    const missing = props.filter((p) => !names.has(p));
    if (missing.length) found.set(name, { file: relative(root, file), missing });
  }
}

let failed = 0;
const fail = (line) => {
  console.log(`  FAIL  ${line}`);
  failed++;
};

console.log('\nprops no call site passes:');
for (const [name, { file, missing }] of found) {
  const allowed = BASELINE.get(name);
  const fresh = allowed ? missing.filter((p) => !allowed.includes(p)) : missing;
  if (fresh.length) fail(`${file}  ${name} declares ${fresh.join(', ')} and nothing passes it`);
  else console.log(`  ok  ${name} (baseline: ${missing.join(', ')})`);
}

// The other direction: a baseline entry that is no longer true. Either it was wired up or
// the prop is gone, and in both cases the line here is now misinformation.
for (const [name, props] of BASELINE) {
  const still = found.get(name)?.missing ?? [];
  const stale = props.filter((p) => !still.includes(p));
  if (stale.length) fail(`BASELINE is stale: ${name}.${stale.join(', ')} is no longer unreached`);
}

console.log(`\n${scanned} components scanned, ${found.size} with an unreached prop`);
if (failed) {
  console.log(`\n${failed} failed\n`);
  process.exit(1);
}
console.log('all ok\n');
