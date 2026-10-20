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
 * A ratchet, not a gate: user-facing text written straight into a component.
 *
 * The checks above hold the two locales to each other, which says nothing about text
 * that never reached a locale at all — and 264 strings across 41 components never did.
 * The admin console alone holds 46. Translating them is a roadmap item and not a
 * release blocker; what IS a blocker is the count going UP, because that is how it got
 * here: each addition looked consistent with the file it landed in.
 *
 * So the baseline is written down and the check fails when it is exceeded. Lower it
 * when a surface is migrated — that is the ratchet turning, and it only turns one way.
 */
const HARDCODED_BASELINE = 264;

const JSX_TEXT = />\s*([A-Z][A-Za-z,'’-]*(?:\s+[A-Za-z,'’-]+){1,})\s*</g;
const JSX_ATTR = /\b(title|placeholder|aria-label|label)=["']([A-Z][^"']{6,})["']/g;

function hardcodedStrings() {
  const SRC = new URL('../apps/desktop/src/', import.meta.url);
  const found = [];
  const walk = (rel) => {
    for (const entry of readdirSync(new URL(rel, SRC), { withFileTypes: true })) {
      const next = `${rel}${entry.name}`;
      if (entry.isDirectory()) walk(`${next}/`);
      else if (entry.name.endsWith('.tsx')) {
        const text = readFileSync(new URL(next, SRC), 'utf8');
        for (const m of text.matchAll(JSX_TEXT)) {
          const s = m[1].trim();
          if (s.split(/\s+/).length >= 2 && s !== s.toUpperCase()) found.push(`${next}: ${s}`);
        }
        for (const m of text.matchAll(JSX_ATTR)) found.push(`${next}: ${m[1]}=${m[2]}`);
      }
    }
  };
  walk('');
  return found;
}

const hardcoded = hardcodedStrings();

check('no NEW user-facing string bypasses the locales', () => {
  assert.ok(
    hardcoded.length <= HARDCODED_BASELINE,
    `${hardcoded.length} hardcoded strings, baseline is ${HARDCODED_BASELINE}. ` +
      `New ones must go through the locales:\n        ` +
      hardcoded.slice(-5).join('\n        '),
  );
});

check('and the baseline is not stale', () => {
  // A baseline nobody lowers is a baseline nobody reads. If the count has dropped, the
  // constant above is wrong by exactly that much and this says so rather than passing.
  assert.equal(
    hardcoded.length,
    HARDCODED_BASELINE,
    `the count is ${hardcoded.length}; lower HARDCODED_BASELINE to match`,
  );
});

console.log(`\n${passed} checks passed`);
