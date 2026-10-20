/**
 * Internationalization (i18n) system
 *
 * Simple translation system with support for multiple languages.
 * Supports English and French with language switching via settings.
 */

import { deviceStore } from '../utils/deviceStore';
import { createContext, useContext, ReactNode, useState, useEffect } from 'react';
import en from './locales/en.json';
import fr from './locales/fr.json';

type Locale = 'en' | 'fr';

type TranslationKeys = typeof en;

interface I18nContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const translations: Record<Locale, TranslationKeys> = {
  en,
  fr,
};

// Default to English
const DEFAULT_LOCALE: Locale = 'en';
const LOCALE_STORAGE_KEY = 'rite-locale';

const I18nContext = createContext<I18nContextType | undefined>(undefined);

/**
 * Resolve a key outside React, for the two places a hook cannot reach: a store (no
 * component, no render) and a class error boundary (no hooks at all). Both hold text a
 * reader sees — a sign-in failure, a crash screen — so neither can stay in English
 * because of where it lives in the code.
 *
 * It reads the locale the provider persisted rather than the provider's state, which is
 * the same value and available before any render. A locale change does not re-render
 * what this returned: that is correct for a store's error string, which is produced at
 * the moment of the failure and shown once.
 */
export function translate(key: string, params?: Record<string, string | number>): string {
  const stored = deviceStore.getItem(LOCALE_STORAGE_KEY);
  const locale: Locale = stored === 'en' || stored === 'fr' ? stored : DEFAULT_LOCALE;
  const value = key
    .split('.')
    .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], translations[locale]);
  if (typeof value !== 'string') return key;
  return params
    ? value.replace(/\{(\w+)\}/g, (_, p: string) => params[p]?.toString() ?? `{${p}}`)
    : value;
}

interface I18nProviderProps {
  children: ReactNode;
}

export function I18nProvider({ children }: I18nProviderProps) {
  // Load locale from localStorage or use default
  const [locale, setLocaleState] = useState<Locale>(() => {
    const stored = deviceStore.getItem(LOCALE_STORAGE_KEY);
    return stored === 'en' || stored === 'fr' ? stored : DEFAULT_LOCALE;
  });

  // Save to localStorage when locale changes
  useEffect(() => {
    deviceStore.setItem(LOCALE_STORAGE_KEY, locale);
  }, [locale]);

  const setLocale = (newLocale: Locale) => {
    setLocaleState(newLocale);
  };

  const t = (key: string, params?: Record<string, string | number>): string => {
    const keys = key.split('.');
    let value: unknown = translations[locale];

    for (const k of keys) {
      value = (value as Record<string, unknown>)?.[k];
    }

    if (typeof value !== 'string') {
      console.warn(`Translation key not found: ${key}`);
      return key;
    }

    // Replace parameters {param} with actual values
    if (params) {
      return value.replace(/\{(\w+)\}/g, (_, param) => {
        return params[param]?.toString() ?? `{${param}}`;
      });
    }

    return value;
  };

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- context hook co-located with provider
export function useTranslation() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useTranslation must be used within I18nProvider');
  }
  return context;
}
