/**
 * Internationalization (i18n) system
 *
 * Simple translation system with support for multiple languages.
 * Supports English and French with language switching via settings.
 */

import { deviceStore } from '../utils/deviceStore';
import { createContext, useContext, ReactNode, useState, useEffect } from 'react';
import { LOCALE_STORAGE_KEY, resolve, storedLocale, type Locale } from './translate';

interface I18nContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

interface I18nProviderProps {
  children: ReactNode;
}

export function I18nProvider({ children }: I18nProviderProps) {
  // Load locale from localStorage or use default
  const [locale, setLocaleState] = useState<Locale>(storedLocale);

  // Save to localStorage when locale changes
  useEffect(() => {
    deviceStore.setItem(LOCALE_STORAGE_KEY, locale);
  }, [locale]);

  const setLocale = (newLocale: Locale) => {
    setLocaleState(newLocale);
  };

  const t = (key: string, params?: Record<string, string | number>): string =>
    resolve(locale, key, params);

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
