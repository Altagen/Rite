/**
 * EVERY PLACE THE APP CAN TURN A STRING INTO MARKUP, COUNTED.
 *
 * This is the shipped half of a lesson learnt in `design/mock/`. The prototypes built
 * markup as strings, so every `innerHTML` in them was a sink; CodeQL found five, and one
 * of them was not a prototype's licence to be sloppy but a live reflected XSS —
 * `setup.html` read `?u=` off the URL and wrote it unescaped, so a link ran script in
 * whoever opened it. The mock grew one `esc()` and a Playwright test to keep it wired up.
 *
 * That test could only ever guard the drawing. The statement worth holding about the
 * product is stronger and is an INVENTORY: React escapes everything it renders, so the
 * app is safe here by construction EXCEPT where it opts out — and there is exactly one
 * such place, the Board's note card, which goes through `mdMini` (held function-first by
 * `e2e/board-markup-check.mjs`, and component-first by `accounts.spec.ts`).
 *
 * So this file fails when a SECOND opt-out appears, or when the one that exists stops
 * going through the escaper. Both are one-line changes in a pull request about something
 * else, which is exactly the kind of change a reviewer waves through.
 *
 * It also holds the other half of the mock's bug: nothing in the app renders a value read
 * off the URL. Two modules read `location.search` and both compare it against fixed words
 * (a shell name, a harness name) rather than showing it, so the list is pinned — a new
 * reader of the query string has to come past this comment.
 *
 * Run: node e2e/html-sinks-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const SRC = new URL('../apps/desktop/src/', import.meta.url);

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

/** One pass can leave a delimiter behind, so each pattern runs until the text settles. */
const untilStable = (src, rx) => {
  let out = src;
  for (let prev = null; prev !== out;) {
    prev = out;
    out = out.replace(rx, '');
  }
  return out;
};

/**
 * Comments out, and deliberately: this repository explains its decisions at length, and a
 * doc comment that NAMES a sink ("returns an HTML string for `dangerouslySetInnerHTML`")
 * is documentation, not a crossing. What is counted is what runs.
 */
const code = (src) => [/\/\*[\s\S]*?\*\//g, /^\s*\/\/.*$/gm].reduce(untilStable, src);

/** Every .ts/.tsx under apps/desktop/src, as [relative path, code without comments]. */
function sources(dir = SRC, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...sources(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push([`${prefix}${entry.name}`, code(readFileSync(new URL(entry.name, dir), 'utf8'))]);
    }
  }
  return out;
}

const FILES = sources();

console.log('the app writes markup in one place:');

check('the sources were read, so the counts below count something', () => {
  // The guard this file needs most: a glob that matched nothing would make every
  // assertion below pass by describing an empty codebase.
  assert.ok(FILES.length > 100, `only ${FILES.length} sources were read`);
});

// Every way a string becomes markup in a browser. `dangerouslySetInnerHTML` is React's
// opt-out; the other four are the DOM's own, which a component can still reach for.
const SINKS = [
  'dangerouslySetInnerHTML',
  '.innerHTML',
  '.outerHTML',
  'insertAdjacentHTML',
  'document.write',
];

check('one opt-out, and it is the Board note', () => {
  const found = [];
  for (const [path, src] of FILES) {
    for (const sink of SINKS) {
      if (src.includes(sink)) found.push(`${path}: ${sink}`);
    }
  }
  assert.deepEqual(
    found,
    ['components/BoardModal.tsx: dangerouslySetInnerHTML'],
    'a new way to turn a string into markup — see this file’s header before allowing it',
  );
});

check('and it goes through the escaper, with nothing between them', () => {
  const src = FILES.find(([p]) => p === 'components/BoardModal.tsx')[1];
  // Pinned as one expression: `__html: card.text` and `__html: mdMini(x) + y` are both
  // the bug this check exists for, and both read almost the same in a diff.
  assert.ok(
    src.includes('dangerouslySetInnerHTML={{ __html: mdMini(card.text) }}'),
    'the Board note no longer renders exactly mdMini(card.text)',
  );
});

console.log('\nand it shows nothing it read off the URL:');

check('two modules read the query string, and both match it against fixed words', () => {
  // The page's OWN url, which is the only one an attacker writes. `new URLSearchParams()`
  // on its own is the opposite direction — `httpRoutes.ts` builds query strings to send —
  // so the predicate is `location`, not the class.
  const readers = FILES.filter(
    ([, src]) => src.includes('location.search') || src.includes('location.hash'),
  ).map(([p]) => p);
  assert.deepEqual(
    readers.sort(),
    ['utils/devHarness.ts', 'utils/mockBackend.ts'],
    'something new reads the URL — a value from there must never reach the DOM unescaped',
  );
  for (const path of readers) {
    const src = FILES.find(([p]) => p === path)[1];
    // `get(...)` compared with `===` or passed to a lookup is a word; interpolated into
    // markup it is the mock's bug, and there is no markup in either of these files.
    for (const sink of SINKS) {
      assert.ok(!src.includes(sink), `${path} both reads the URL and writes markup`);
    }
  }
});

console.log(`\n${passed} checks passed`);
