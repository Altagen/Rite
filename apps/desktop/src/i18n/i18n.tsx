/**
 * Internationalization (i18n) system
 *
 * Simple translation system with support for multiple languages.
 * Supports English and French with language switching via settings.
 */

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

interface I18nProviderProps {
  children: ReactNode;
}

export function I18nProvider({ children }: I18nProviderProps) {
  // Load locale from localStorage or use default
  const [locale, setLocaleState] = useState<Locale>(() => {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    return (stored === 'en' || stored === 'fr') ? stored : DEFAULT_LOCALE;
  });

  // Save to localStorage when locale changes
  useEffect(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  }, [locale]);

  const setLocale = (newLocale: Locale) => {
    setLocaleState(newLocale);
  };

  const t = (key: string, params?: Record<string, string | number>): string => {
    const keys = key.split('.');
    let value: any = translations[locale];

    for (const k of keys) {
      value = value?.[k];
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

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useTranslation must be used within I18nProvider');
  }
  return context;
}
