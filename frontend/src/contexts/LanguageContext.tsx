'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { en, type TranslationKey } from '@/i18n/locales/en';
import { legacyZhCN, zhCN } from '@/i18n/locales/zh-CN';

export type AppLocale = 'en' | 'zh-CN';

const STORAGE_KEY = 'calmee.interfaceLocale';

type LanguageContextValue = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  t: (key: TranslationKey, variables?: Record<string, string | number>) => string;
  lt: (text: string, variables?: Record<string, string | number>) => string;
  dateLocale: string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>('en');

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh-CN') setLocaleState(saved);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((nextLocale: AppLocale) => {
    setLocaleState(nextLocale);
    window.localStorage.setItem(STORAGE_KEY, nextLocale);
  }, []);

  const t = useCallback((key: TranslationKey, variables?: Record<string, string | number>) => {
    const table = locale === 'zh-CN' ? zhCN : en;
    return Object.entries(variables ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      table[key] ?? en[key],
    );
  }, [locale]);

  // Safe React-level fallback for inherited UI that still uses literal English
  // labels. Unlike the removed DOM bridge, this never mutates rendered nodes.
  const lt = useCallback((text: string, variables?: Record<string, string | number>) => {
    const translated = locale === 'zh-CN' ? (legacyZhCN[text] ?? text) : text;
    return Object.entries(variables ?? {}).reduce(
      (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)),
      translated,
    );
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, t, lt, dateLocale: locale === 'zh-CN' ? 'zh-CN' : 'en-US' }), [locale, setLocale, t, lt]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within a LanguageProvider');
  return context;
}
