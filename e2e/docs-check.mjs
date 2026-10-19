/**
 * What the documentation claims about the code, checked against the code.
 *
 * `docs/SERVER.md` lists the settings an instance may declare as code, and counts them in
 * a sentence. That list is written by hand and the code's is `config::SETTINGS`, so they
 * drift — this release added four keys and the document said ten, which is the kind of
 * wrong that reads as authoritative: an operator writes a key the document knows about,
 * and the instance refuses to start naming it a typo.
 *
 * Run: node e2e/docs-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, normalize } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

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

/** The keys `config::SETTINGS` declares, in the order the table lists them. */
function settingsInCode() {
  const source = read('packages/rite-server/src/config.rs');
  const table = source.match(/pub const SETTINGS: &\[\(&str, Shape\)\] = &\[(.*?)\];/s);
  assert.ok(table, 'config.rs no longer has a SETTINGS table shaped as expected');
  return [...table[1].matchAll(/\("([a-z_]+)",/g)].map((m) => m[1]);
}

/** The keys `docs/SERVER.md` says exist, from the sentence that enumerates them. */
function settingsInDocs() {
  const doc = read('docs/SERVER.md');
  const listed = doc.match(/The full list: (.*?)\. A key outside/s);
  assert.ok(listed, 'SERVER.md no longer has a "The full list: …" sentence');
  return [...listed[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
}

const code = settingsInCode();
const docs = settingsInDocs();

console.log('the documented instance settings are the real ones:');

check('the code has a settings table to compare against', () => {
  assert.ok(code.length >= 10, `only ${code.length} settings found in config.rs`);
});

check('every documented key exists in the code', () => {
  const unknown = docs.filter((k) => !code.includes(k));
  assert.deepEqual(unknown, [], `SERVER.md documents keys the server refuses: ${unknown.join(', ')}`);
});

check('every key in the code is documented', () => {
  const missing = code.filter((k) => !docs.includes(k));
  assert.deepEqual(missing, [], `declarable but undocumented: ${missing.join(', ')}`);
});

check('and the count in the prose matches', () => {
  const doc = read('docs/SERVER.md');
  const said = doc.match(/^(\w+) settings govern how an instance behaves/m);
  assert.ok(said, 'SERVER.md no longer opens that section by counting the settings');
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
    'eighteen', 'nineteen', 'twenty'];
  assert.equal(
    words.indexOf(said[1].toLowerCase()),
    code.length,
    `the prose says ${said[1]} and there are ${code.length}`,
  );
});

/*
 * The second half: what the documentation tells a reader to run, and where it tells
 * them to look.
 *
 * Both drift silently, and both drift into the reader's first five minutes. INSTALL.md
 * spent four releases describing .deb and .dmg packages this project has never built;
 * QUICKSTART.md offered `task prepare-release` and `task fmt-rust`, which do not exist;
 * the README's tree listed a `packages/protocols/` that was never written. None of it
 * fails a build — it fails a person.
 */
/** Every markdown file that is ours (not a dependency's, not generated). */
function markdownFiles() {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(resolve(ROOT, rel), { withFileTypes: true })) {
      if (['node_modules', 'target', 'dist', '.git'].includes(entry.name)) continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.md')) out.push(next);
    }
  };
  walk('');
  return out;
}

const markdown = markdownFiles().map((rel) => [rel, read(rel)]);

console.log('\nwhat the documentation tells a reader to run exists:');

check('every `task …` in the docs is a task Taskfile.yaml defines', () => {
  const defined = new Set(
    [...read('Taskfile.yaml').matchAll(/^ {2}([a-zA-Z][\w:-]*):$/gm)].map((m) => m[1]),
  );
  assert.ok(defined.size > 10, `only ${defined.size} tasks parsed out of Taskfile.yaml`);
  const missing = [];
  for (const [rel, text] of markdown) {
    for (const m of text.matchAll(/\btask ([a-z][\w:-]*)/g)) {
      if (m[1] === 'list') continue; // `task --list`, written without the dashes in prose
      if (!defined.has(m[1])) missing.push(`${rel}: task ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `documented but undefined:\n        ${missing.join('\n        ')}`);
});

check('every relative link in the docs points at something', () => {
  const broken = [];
  for (const [rel, text] of markdown) {
    for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = normalize(join(dirname(rel), decodeURIComponent(target)));
      if (!existsSync(resolve(ROOT, path))) broken.push(`${rel} → ${target}`);
    }
  }
  assert.deepEqual(broken, [], `dead links:\n        ${broken.join('\n        ')}`);
});

check('every repository path the docs name in backticks exists', () => {
  const missing = [];
  const roots = /^(apps|packages|e2e|docs|deploy|\.github)\//;
  for (const [rel, text] of markdown) {
    for (const m of text.matchAll(/`([\w./@-]+)`/g)) {
      const path = m[1];
      if (!roots.test(path) || path.includes('*')) continue;
      if (!existsSync(resolve(ROOT, path))) missing.push(`${rel}: ${path}`);
    }
  }
  assert.deepEqual(missing, [], `named but absent:\n        ${missing.join('\n        ')}`);
});

check("the README's project tree is the project's tree", () => {
  const fence = read('README.md').match(/## Project Structure\s*\n+```\n([\s\S]*?)```/);
  assert.ok(fence, 'README.md no longer has a fenced tree under "## Project Structure"');
  const stack = [];
  const wrong = [];
  for (const line of fence[1].split('\n')) {
    const entry = line.match(/^((?:[│ ]   )*)(?:├──|└──) ([\w.-]+\/?)/u);
    if (!entry) continue; // the root line, and anything that is not a tree entry
    const depth = entry[1].length / 4;
    stack.length = depth;
    stack[depth] = entry[2].replace(/\/$/, '');
    const path = stack.slice(0, depth + 1).join('/');
    if (!existsSync(resolve(ROOT, path))) {
      wrong.push(`${path} (listed, does not exist)`);
      continue;
    }
    const isDir = statSync(resolve(ROOT, path)).isDirectory();
    if (isDir !== entry[2].endsWith('/')) {
      wrong.push(`${path} (listed as a ${entry[2].endsWith('/') ? 'directory' : 'file'})`);
    }
  }
  assert.deepEqual(wrong, [], `the tree is out of date:\n        ${wrong.join('\n        ')}`);
});

check('and it names every workspace member', () => {
  const fence = read('README.md').match(/## Project Structure\s*\n+```\n([\s\S]*?)```/)[1];
  const members = [
    ...readdirSync(resolve(ROOT, 'packages'), { withFileTypes: true }),
    ...readdirSync(resolve(ROOT, 'apps'), { withFileTypes: true }),
  ]
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const unlisted = members.filter((name) => !fence.includes(`${name}/`));
  assert.deepEqual(unlisted, [], `in the workspace, absent from the tree: ${unlisted.join(', ')}`);
});

console.log(`\n${passed} checks passed (${code.length} instance settings, ${markdown.length} documents)`);
