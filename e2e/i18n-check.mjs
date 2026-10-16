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
import { readFileSync } from 'node:fs';
import { SHORTCUT_COMMANDS } from '../apps/desktop/src/shortcuts/commands.ts';

const load = (locale) =>
  JSON.parse(readFileSync(new URL(`../apps/desktop/src/i18n/locales/${locale}.json`, import.meta.url)));

const LOCALES = { en: load('en'), fr: load('fr') };

/** Every leaf key, dotted, the way `t()` addresses it. */
const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    v !== null && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

const KEYS = Object.fromEntries(Object.entries(LOCALES).map(([l, d]) => [l, new Set(flatten(d))]));

/** Resolve a dotted key the way i18n.tsx does, so this agrees with the app. */
const resolve = (data, key) => key.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), data);

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

console.log(`\n${passed} checks passed`);
