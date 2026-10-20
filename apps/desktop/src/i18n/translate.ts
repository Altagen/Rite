/**
 * Key resolution, without React.
 *
 * The provider in `i18n.tsx` is the normal way in, but two places a hook cannot reach
 * also hold text a reader sees: a store (no component, no render) and a class error
 * boundary (no hooks at all). A sign-in failure and a crash screen cannot stay in
 * English because of where they live in the code.
 *
 * It lives in its own module rather than beside the provider so that importing it from
 * a store does not drag the React context along — and so the provider file keeps
 * exporting components only, which is what fast refresh needs.
 */

import { deviceStore } from '../utils/deviceStore';
import en from './locales/en.json';
import fr from './locales/fr.json';

export type Locale = 'en' | 'fr';
export type TranslationKeys = typeof en;

export const translations: Record<Locale, TranslationKeys> = { en, fr };

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'rite-locale';

/** The locale the provider persisted — readable before any render. */
export function storedLocale(): Locale {
  const stored = deviceStore.getItem(LOCALE_STORAGE_KEY);
  return stored === 'en' || stored === 'fr' ? stored : DEFAULT_LOCALE;
}

/** Resolve a dotted key, filling `{param}` placeholders. Returns the key when it misses. */
export function resolve(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const value = key
    .split('.')
    .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], translations[locale]);
  if (typeof value !== 'string') {
    console.warn(`Translation key not found: ${key}`);
    return key;
  }
  return params
    ? value.replace(/\{(\w+)\}/g, (_, p: string) => params[p]?.toString() ?? `{${p}}`)
    : value;
}

/**
 * Resolve a key outside React. A locale change does not re-render what this returned:
 * that is correct for a store's error string, produced at the moment of the failure and
 * shown once.
 */
export function translate(key: string, params?: Record<string, string | number>): string {
  return resolve(storedLocale(), key, params);
}
