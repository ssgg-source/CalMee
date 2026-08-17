'use client';

import { Languages } from 'lucide-react';
import { useLanguage, type AppLocale } from '@/contexts/LanguageContext';

export function InterfaceLanguageSettings() {
  const { locale, setLocale, t } = useLanguage();

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-6">
        <div className="flex gap-3">
          <div className="mt-0.5 rounded-lg bg-violet-100 p-2 text-violet-700"><Languages className="h-5 w-5" /></div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{t('language.settingTitle')}</h3>
            <p className="mt-1 max-w-xl text-sm text-gray-600">{t('language.settingDescription')}</p>
          </div>
        </div>
        <select
          aria-label={t('language.settingTitle')}
          value={locale}
          onChange={event => setLocale(event.target.value as AppLocale)}
          className="min-w-44 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
        >
          <option value="en">{t('language.english')}</option>
          <option value="zh-CN">{t('language.chinese')}</option>
        </select>
      </div>
    </div>
  );
}
