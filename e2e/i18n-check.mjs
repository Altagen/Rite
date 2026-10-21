/**
 * The two locales, held to each other and to the tables that need them.
 *
 * The app ships English and French and lets the user switch. A key added to one
 * file and not the other does not fail a build, does not fail a test, and does not
 * fail at runtime: `t()` logs a warning nobody is watching and renders the key
 * itself — so the screen reads `shortcuts.cmd.pane.close.label` for exactly the
 * users who chose the other language. That is why this is a check and not a habit.
 *
 * It also holds the keyboard table to having its strings: `SHORTCUT_COMMANDS` is a
 * list of ids and chords, with the words in the locales, so adding a command and
 * forgetting its two lines is the mistake this file exists to make loud. The
 * settings dialog had the other version of that mistake already — a second,
 * hand-written shortcut list that outlived the default it named.
 *
 * Run: node e2e/i18n-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SHORTCUT_COMMANDS } from '../apps/desktop/src/shortcuts/commands.ts';

const load = (locale) =>
  JSON.parse(
    readFileSync(new URL(`../apps/desktop/src/i18n/locales/${locale}.json`, import.meta.url)),
  );

const LOCALES = { en: load('en'), fr: load('fr') };

/** Every leaf key, dotted, the way `t()` addresses it. */
const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    v !== null && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

const KEYS = Object.fromEntries(Object.entries(LOCALES).map(([l, d]) => [l, new Set(flatten(d))]));

/** Resolve a dotted key the way i18n.tsx does, so this agrees with the app. */
const resolve = (data, key) =>
  key.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), data);

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

console.log('the locales agree:');

check('every English key exists in French', () => {
  const missing = [...KEYS.en].filter((k) => !KEYS.fr.has(k));
  assert.deepEqual(missing, [], `French is missing ${missing.length} key(s)`);
});

check('every French key exists in English', () => {
  // The other direction matters as much: a key only in French is a string the
  // majority of users will never see, and usually a rename that half landed.
  const missing = [...KEYS.fr].filter((k) => !KEYS.en.has(k));
  assert.deepEqual(missing, [], `English is missing ${missing.length} key(s)`);
});

check('no key resolves to something that is not a string', () => {
  // `t()` returns the key itself when the value is not a string, so a key that
  // accidentally addresses a group renders as its own path.
  for (const [locale, data] of Object.entries(LOCALES)) {
    for (const key of KEYS[locale]) {
      assert.equal(typeof resolve(data, key), 'string', `${locale}: ${key}`);
    }
  }
});

check('no value is empty', () => {
  for (const [locale, data] of Object.entries(LOCALES)) {
    for (const key of KEYS[locale]) {
      assert.notEqual(resolve(data, key).trim(), '', `${locale}: ${key} is empty`);
    }
  }
});

check('a placeholder is written the way the interpolator reads it', () => {
  // `i18n.tsx` fills `/\{(\w+)\}/` — single braces. A string written `{{name}}` in the
  // i18next spelling has its inner braces filled and the outer ones rendered, so the user
  // reads "Loaded from {Ancien.pub}". The check above compares the two locales and both
  // were wrong in the same way, which is exactly why it saw nothing.
  for (const locale of ['en', 'fr']) {
    for (const key of KEYS[locale]) {
      const value = resolve(LOCALES[locale], key);
      assert.ok(
        !value.includes('{{') && !value.includes('}}'),
        `${locale} ${key}: use {name}, not {{name}} — the interpolator reads single braces`,
      );
    }
  }
});

check('both locales interpolate the same parameters', () => {
  // `t('shortcuts.reserved', { chord })` fills `{chord}`; a translation that spells
  // it `{accord}` renders the braces to the user.
  const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of KEYS.en) {
    assert.deepEqual(
      params(resolve(LOCALES.fr, key)),
      params(resolve(LOCALES.en, key)),
      `${key}: the two locales fill different parameters`,
    );
  }
});

console.log('\nthe keyboard table has its words:');

check('every command has a label and a description, in both locales', () => {
  for (const command of SHORTCUT_COMMANDS) {
    for (const [locale, data] of Object.entries(LOCALES)) {
      for (const field of ['label', 'description']) {
        const key = `shortcuts.cmd.${command.id}.${field}`;
        assert.equal(typeof resolve(data, key), 'string', `${locale} is missing ${key}`);
      }
    }
  }
});

check('no locale carries a label for a command that no longer exists', () => {
  // A removed command leaves its strings behind, and the next reader cannot tell a
  // leftover from a command that was dropped by accident.
  const ids = new Set(SHORTCUT_COMMANDS.map((c) => c.id));
  for (const [locale, data] of Object.entries(LOCALES)) {
    const group = resolve(data, 'shortcuts.cmd') ?? {};
    const stems = flatten(group).map((k) => k.replace(/\.(label|description)$/, ''));
    for (const stem of new Set(stems)) {
      assert.ok(ids.has(stem), `${locale}: shortcuts.cmd.${stem} has no command`);
    }
  }
});

/*
 * Every key the code asks for must exist, in both locales.
 *
 * `t()` returns the KEY when it cannot resolve one — so a typo or a key that was
 * renamed in the locales ships as `settings.foo.bar` on screen, with nothing but a
 * `console.warn` behind it. Nobody reads a browser console in a release build, and the
 * checks above could not see it: they compare the locales to each other, and a key that
 * exists in neither is consistent.
 *
 * It mattered most during the migration: moving 401 hardcoded strings into the locales
 * was 401 chances to ship a visible key. It caught the one that got through — seven
 * `auth.*` error strings dropped when the group was replaced, which put
 * `auth.wrongPassword` on the unlock screen.
 */
function translationCalls() {
  const SRC = new URL('../apps/desktop/src/', import.meta.url);
  const calls = [];
  const walk = (rel) => {
    for (const entry of readdirSync(new URL(rel, SRC), { withFileTypes: true })) {
      const next = `${rel}${entry.name}`;
      if (entry.isDirectory()) walk(`${next}/`);
      else if (/\.tsx?$/.test(entry.name)) {
        const text = readFileSync(new URL(next, SRC), 'utf8');
        // Literal keys only. A computed one (`t(someVar)`) cannot be checked here, and
        // there is no point pretending otherwise.
        for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)) {
          calls.push({ file: next, key: m[1] });
        }
        // A key carried as DATA, resolved somewhere else: `{ key: 'auth.wrongPassword' }`
        // in a store, `titleKey`/`msgKey` in a lookup table, `labelKey` in a nav list.
        //
        // This half was missing, and it cost exactly what it was built to prevent: the
        // migration replaced the `auth` group wholesale and dropped seven error strings
        // with it, so the unlock screen printed `auth.wrongPassword` to the user. Nothing
        // failed — the two locales agreed, and the only reader was `t()`'s console.warn.
        // `unlock-roundtrip.spec.ts` caught it, which is luck: it is the one screen with
        // a test that pins the wording.
        for (const m of text.matchAll(/\b\w*[Kk]ey\s*:\s*'([a-z][\w]*\.[\w.]+)'/g)) {
          calls.push({ file: next, key: m[1] });
        }
      }
    }
  };
  walk('');
  return calls;
}

const CALLS = translationCalls();

check('every key the code asks for exists in both locales', () => {
  assert.ok(CALLS.length > 100, `only ${CALLS.length} t() calls found — the scan is wrong`);
  const missing = [];
  for (const { file, key } of CALLS) {
    for (const [locale, keys] of Object.entries(KEYS)) {
      if (!keys.has(key)) missing.push(`${file}: '${key}' is not in ${locale}.json`);
    }
  }
  assert.deepEqual(
    [...new Set(missing)],
    [],
    `a missing key renders as itself on screen:\n        ${[...new Set(missing)].join('\n        ')}`,
  );
});

/*
 * No user-facing text written straight into a component.
 *
 * This started as a ratchet over 401 strings across 45 components, because the count only
 * ever went up: each addition looked consistent with the file it landed in. The migration
 * is finished, so it is now a gate — the scan must find nothing but the lines listed in
 * ALLOWED, each of which is not interface text at all.
 *
 * Keep it that way. A new string in a component fails this check by name, and the fix is a
 * key in both locales, not a line in the list below.
 *
 * The patterns are deliberately wide, and the width was earned. An early version allowed
 * only letters and commas inside a string, so a full stop, an apostrophe entity, an arrow
 * or an em dash hid 125 of them — it reported 264 where the figure was 401. Worse, two
 * strings fixed in one commit ("Policies + oversight", "Grant name / roster access") only
 * became COUNTABLE once the `+` and the `/` were replaced by words, so the count appeared
 * to rise while the file got better. Both halves of a ternary are read for the same reason:
 * counting only the `:` side turned `isFirstRun ? 'Create your vault' : 'Unlock vault'` into
 * a single string, and those fallbacks are the error and empty states — the text a reader
 * meets when something has already gone wrong.
 */
const ALLOWED = new Map([
  // A log context, read by a developer in a console, never by a user.
  ['components/TerminalManager.tsx: [ternary-else] TerminalManager', 'log context, not interface'],
  // The product's name, and the name of a key on the keyboard. Neither is translated.
  ['components/ServerAuthScreen.tsx: [jsx-text] Rite', 'product name'],
  ['components/Workspace.tsx: [jsx-text] Esc', 'key cap, printed in a <kbd>'],
  // A developer-facing error about a malformed backend reply: there is no user action.
  [
    'utils/backend.ts: [throw] Invalid response from ${command}: ${result.error.message}',
    'internal protocol error, not shown to a user',
  ],
  // The browser-preview mock's seed data — machine names, not chrome. A demo library in
  // the reader's language would claim the fixtures are real.
  ['utils/mockBackend.ts: [ternary-else] Database (demo)', 'mock fixture data'],
  ['utils/mockBackend.ts: [ternary-else] Web Server (demo)', 'mock fixture data'],
  [
    'utils/mockBackend.ts: [ternary-else] Demo connection — browser preview only',
    'mock fixture data',
  ],
  // A bounds comparison: `clientX > rect.right || clientY < rect.top` is a `>`, words
  // and a `<`, which is what the jsx-tail pattern is looking for.
  ['components/TerminalManager.tsx: [jsx-tail] rect.right || clientY', 'source code, not text'],
  // A CSS font-family stack. Font names are not translated.
  ['utils/terminalPool.ts: [ternary-else] JetBrains Mono, Fira Code, monospace', 'CSS font stack'],
]);

const HARDCODED = [
  // Text between tags. Wide on purpose: an earlier version allowed only letters and
  // commas inside a string, so a full stop, an apostrophe entity, an arrow or an em dash
  // hid 125 of them from it — and a one-word rule hid another 73, which is where most
  // buttons live: Cancel, Delete, Rename…, Save.
  ['jsx-text', />\s*([A-Z][^<>{}\n]*?[a-z][^<>{}]*?)\s*</gs],
  ['attr', /\b(?:title|placeholder|aria-label|label|alt)=["']([A-Z][^"']{4,})["']/g],
  // The same attributes written as a template literal, which the quoted pattern cannot
  // see. Twenty-one of them were left that way, all of them screen-reader labels and
  // tooltips: `aria-label={`Remove ${v.label} from the list`}`.
  ['attr-tpl', /\b(?:title|placeholder|aria-label|label|alt)=\{`([^`]{4,})`\}/g],
  ['confirm', /window\.confirm\(\s*[`'"]([^`'"]{10,})/g],
  ['toast', /toast\(\s*[`'"]([A-Z][^`'"]{6,})/g],
  ['throw', /throw new Error\(\s*[`'"]([A-Z][^`'"]{6,})/g],
  // Both halves of a ternary, and an object property a reader sees. Counting only the
  // `:` side missed the other one — `isFirstRun ? 'Create your vault' : 'Unlock vault'`
  // came out as a single string.
  ['ternary-else', /:\s*['"]([A-Z][a-z][^'"]{10,})['"]/g],
  ['ternary-then', /\?\s*['"]([A-Z][a-z][^'"]{10,})['"]\s*:/g],
  ['prop', /\b(?:label|message|hint|text|note)=?:\s*['"]([A-Z][a-z][^'"]{8,})['"]/g],
  // A fragment that starts lower-case, because it continues a sentence a <b> interrupted:
  // "…<b>Owner</b> manages sharing & settings". Six of those were left when every pattern
  // above still demanded a capital, and they are the half of the sentence that says what
  // the bold word means.
  ['jsx-tail', />\s*([a-z][a-zA-Z0-9 ,.;:·'’&/()!?+%@À-ɏ—–…→▸-]*?\s[^<>{}]*?)\s*</gs],
  // Text that TOUCHES an interpolation — the shape every pattern above is blind to,
  // because they read `>` … `<` with `{` and `}` excluded from the capture. So
  // `>Members ·{n}<` and `>{n} terminals<` were invisible, and that is the commonest
  // shape in a real component: a sentence wrapped around a count. It cost 34 strings,
  // three of which a reader found on screen in a French console after this check had
  // already reported zero.
  ['jsx-after-expr', /\}\s*([A-Za-zÀ-ÿ][^<>{}\n]*?[a-zà-ÿ][^<>{}]*?)\s*(?=[<{])/gs],
  ['jsx-before-expr', />\s*([A-Za-zÀ-ÿ][^<>{}\n]*?[a-zà-ÿ][^<>{}]*?)\s*(?=\{)/gs],
];

/*
 * The two `-expr` patterns also match JavaScript, because `} catch {` and `} else {` are
 * a brace, a word and a brace. Keywords and template-literal fragments are dropped here
 * rather than by narrowing the pattern — a narrower pattern is what hid the 34.
 */
const NOT_TEXT =
  /^(catch|finally|else|try|interface\b|export\b|class\b|function\b|const\b|let\b|var\b|return\b|if\b|while\b|for\b|switch\b|case\b|async\b|await\b|new\b|type\b)|px`|`\$|w-full|h-full|maxHeight|left:|[;=()[\]|&]|=>/;

function hardcodedStrings() {
  const SRC = new URL('../apps/desktop/src/', import.meta.url);
  const found = [];
  const walk = (rel) => {
    for (const entry of readdirSync(new URL(rel, SRC), { withFileTypes: true })) {
      const next = `${rel}${entry.name}`;
      if (entry.isDirectory()) walk(`${next}/`);
      else if (/\.tsx?$/.test(entry.name)) {
        const text = readFileSync(new URL(next, SRC), 'utf8');
        for (const [kind, rx] of HARDCODED) {
          for (const m of text.matchAll(rx)) {
            const s = m[1].replace(/\s+/g, ' ').trim();
            // `=> Promise<T>` reads as a `>`, a word and a `<`, in 60-odd stores and
            // components. It is the one shape worth excluding by hand.
            const jsx = kind.startsWith('jsx-');
            if (jsx && m.index > 0 && text[m.index - 1] === '=') continue;
            if (jsx && s === s.toUpperCase()) continue;
            // JSX only exists in .tsx, and in a plain .ts a brace-word-brace is a shell
            // command or a module declaration — nine of those before this line existed.
            if (kind.endsWith('-expr') && !next.endsWith('.tsx')) continue;
            if (kind.endsWith('-expr') && (s.length < 4 || NOT_TEXT.test(s))) continue;
            found.push(`${next}: [${kind}] ${s}`);
          }
        }
      }
    }
  };
  walk('');
  return found;
}

const hardcoded = hardcodedStrings();

check('no user-facing string bypasses the locales', () => {
  const unexpected = hardcoded.filter((h) => !ALLOWED.has(h));
  assert.deepEqual(
    unexpected,
    [],
    `${unexpected.length} hardcoded string(s). Each one needs a key in both locales:\n        ` +
      unexpected.join('\n        '),
  );
});

check('and the allow-list has no stale entry', () => {
  // An allowed line that no longer matches is a line nobody will question later. If the
  // code it described is gone, so is its reason to be here.
  const found = new Set(hardcoded);
  const stale = [...ALLOWED.keys()].filter((k) => !found.has(k));
  assert.deepEqual(stale, [], `${stale.length} allow-list entr(y/ies) match nothing any more`);
});

console.log(`\n${passed} checks passed`);
